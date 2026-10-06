import { newId } from '@expensewise/domain';
import { asc, eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { getModelSettings, saveModelSettings } from '../src/ai-models.ts';
import { withOrg } from '../src/client.ts';
import { fileReceipt, recordExtractionRun, runsForRequest } from '../src/receipts.ts';
import { auditEvents, extractionRuns, orgAiModels } from '../src/schema.ts';
import { connectAs, expectDbError, seedOrg } from './helpers.ts';

const app = connectAs('app');
afterAll(async () => {
  await app.pool.end();
});

const choice = (primary: string | null, models: [string, boolean][]) => ({
  primary,
  models: models.map(([model, enabled]) => ({ model, enabled })),
});

describe('which AI models read an organization’s receipts (FR-INT-16)', () => {
  it('keeps the primary and the order, records each change once, and nothing for a repeat', async () => {
    const org = await seedOrg(app.db, 'models-save');
    const inOrg = <T>(run: Parameters<typeof withOrg<T>>[2]) => withOrg(app.db, org.orgId, run);
    const save = (settings: ReturnType<typeof choice>) =>
      inOrg((tx) => saveModelSettings(tx, org.orgId, settings, org.memberId, org.userId));

    expect(await inOrg((tx) => getModelSettings(tx))).toBeUndefined();
    const first = choice('claude-sonnet-5-5', [
      ['claude-sonnet-5-5', true],
      ['gpt-5.6-luna', true],
      ['claude-haiku-4-5', false],
    ]);
    expect(await save(first)).toBe('saved');
    expect(await save(first)).toBe('unchanged');
    expect(await inOrg((tx) => getModelSettings(tx))).toMatchObject(first);

    // Another model primary, and the back-ups in a new order.
    const second = choice('gpt-5.6-luna', [
      ['claude-haiku-4-5', true],
      ['gpt-5.6-luna', true],
      ['claude-sonnet-5-5', true],
    ]);
    expect(await save(second)).toBe('saved');
    expect(await inOrg((tx) => getModelSettings(tx))).toMatchObject(second);

    // Every model off: no primary.
    const none = choice(null, [
      ['claude-haiku-4-5', false],
      ['gpt-5.6-luna', false],
      ['claude-sonnet-5-5', false],
    ]);
    expect(await save(none)).toBe('saved');
    expect(await inOrg((tx) => getModelSettings(tx))).toMatchObject(none);

    const events = await inOrg((tx) =>
      tx
        .select({ action: auditEvents.action, payload: auditEvents.payload })
        .from(auditEvents)
        .where(eq(auditEvents.entityType, 'ai_models'))
        .orderBy(asc(auditEvents.sequence)),
    );
    expect(events.map((e) => e.action)).toEqual([
      'ai_models.changed',
      'ai_models.changed',
      'ai_models.changed',
    ]);
    expect(events[1]?.payload).toEqual({
      primary: 'gpt-5.6-luna',
      on: ['claude-haiku-4-5', 'gpt-5.6-luna', 'claude-sonnet-5-5'],
      off: [],
      before: {
        primary: 'claude-sonnet-5-5',
        on: ['claude-sonnet-5-5', 'gpt-5.6-luna'],
        off: ['claude-haiku-4-5'],
      },
      memberId: org.memberId,
    });
  });

  it('allows one primary, only while it is on, and keeps organizations apart', async () => {
    const acme = await seedOrg(app.db, 'models-acme');
    const other = await seedOrg(app.db, 'models-other');
    await withOrg(app.db, acme.orgId, (tx) =>
      saveModelSettings(
        tx,
        acme.orgId,
        choice('claude-haiku-4-5', [['claude-haiku-4-5', true]]),
        acme.memberId,
        acme.userId,
      ),
    );
    expect(await withOrg(app.db, other.orgId, (tx) => getModelSettings(tx))).toBeUndefined();
    expect(await withOrg(app.db, other.orgId, (tx) => tx.select().from(orgAiModels))).toEqual([]);

    const row = (model: string, over: Partial<typeof orgAiModels.$inferInsert> = {}) => ({
      orgId: acme.orgId,
      model,
      enabled: true,
      isPrimary: false,
      position: 1,
      updatedByMemberId: acme.memberId,
      ...over,
    });
    await expectDbError(
      withOrg(app.db, acme.orgId, (tx) =>
        tx.insert(orgAiModels).values(row('claude-sonnet-5-5', { isPrimary: true })),
      ),
      /org_ai_models_one_primary/,
    );
    await expectDbError(
      withOrg(app.db, acme.orgId, (tx) =>
        tx.insert(orgAiModels).values(row('gpt-5.6-luna', { enabled: false, isPrimary: true })),
      ),
      /org_ai_models_primary_is_on/,
    );
    await expectDbError(
      withOrg(app.db, acme.orgId, (tx) => tx.insert(orgAiModels).values(row('Not A Model'))),
      /org_ai_models_model_format/,
    );
  });

  it('records why each model read: primary or back-up, and nothing else', async () => {
    const org = await seedOrg(app.db, 'models-roles');
    const id = newId();
    const filed = await withOrg(app.db, org.orgId, (tx) =>
      fileReceipt(
        tx,
        org.orgId,
        {
          id,
          memberId: org.memberId,
          source: 'camera',
          storageKey: `orgs/x/receipts/${id}`,
          contentType: 'image/jpeg',
          byteSize: 1234,
          sha256: 'ab'.repeat(32),
        },
        org.userId,
      ),
    );
    if (filed.status !== 'filed') throw new Error('expected a new receipt');
    const requestId = filed.event.outboxId;
    const run = (model: string, role?: 'primary' | 'backup') => ({
      receiptId: id,
      requestId,
      extractor: 'claude',
      model,
      promptVersion: 'extract-v1',
      schemaVersion: 'v1',
      outcome: 'failed' as const,
      output: null,
      fieldConfidence: null,
      error: 'request_rejected: no credit',
      latencyMs: null,
      inputTokens: null,
      outputTokens: null,
      costMicroUsd: null,
      ...(role ? { role } : {}),
    });
    await withOrg(app.db, org.orgId, async (tx) => {
      await recordExtractionRun(tx, org.orgId, run('claude-sonnet-5-5', 'primary'));
      await recordExtractionRun(tx, org.orgId, run('claude-haiku-4-5', 'backup'));
      await recordExtractionRun(tx, org.orgId, run('gpt-5.6-luna'));
    });
    const runs = await withOrg(app.db, org.orgId, (tx) => runsForRequest(tx, id, requestId));
    expect(runs.map((r) => [r.model, r.role]).sort()).toEqual([
      ['claude-haiku-4-5', 'backup'],
      ['claude-sonnet-5-5', 'primary'],
      ['gpt-5.6-luna', null],
    ]);
    await expectDbError(
      withOrg(app.db, org.orgId, (tx) =>
        tx.update(extractionRuns).set({ role: 'fallback' }).where(eq(extractionRuns.receiptId, id)),
      ),
      /extraction_runs_role_known/,
    );
  });
});
