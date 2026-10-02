import { newId } from '@expensewise/domain';
import { asc } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { withOrg } from '../src/client.ts';
import {
  fileReceipt,
  getReceipt,
  listExtractionRuns,
  listReceipts,
  recordExtractionRun,
  requestReceiptReading,
  runsForRequest,
  settleReceipt,
  type NewExtractionRun,
} from '../src/receipts.ts';
import { auditEvents, outboxEvents } from '../src/schema.ts';
import { connectAs, seedOrg } from './helpers.ts';

const app = connectAs('app');
afterAll(async () => {
  await app.pool.end();
});

const sha = (n: number) => n.toString(16).padStart(64, '0');
const receipt = (memberId: string, n: number, id = newId()) => ({
  id,
  memberId,
  source: 'camera' as const,
  storageKey: `orgs/x/receipts/${id}`,
  contentType: 'image/jpeg',
  byteSize: 1234,
  sha256: sha(n),
});
const run = (receiptId: string, requestId: string, model: string): NewExtractionRun => ({
  receiptId,
  requestId,
  extractor: 'claude',
  model,
  promptVersion: 'extract-v1',
  schemaVersion: 'v1',
  outcome: 'confident',
  output: { documentType: 'receipt' },
  fieldConfidence: { total: 'high' },
  error: null,
  latencyMs: 1200,
  inputTokens: 1500,
  outputTokens: 300,
  costMicroUsd: 4500,
});

describe('filing a receipt', () => {
  it('stores the row, the event that has it read, and an audit event, together', async () => {
    const acme = await seedOrg(app.db, 'acme-receipts');
    const input = receipt(acme.memberId, 1);
    const result = await withOrg(app.db, acme.orgId, (tx) =>
      fileReceipt(tx, acme.orgId, input, acme.userId),
    );
    expect(result).toMatchObject({
      status: 'filed',
      receipt: { id: input.id, status: 'processing', uploadedBy: 'acme-receipts' },
      event: { topic: 'receipt.uploaded', orgId: acme.orgId, payload: { receiptId: input.id } },
    });
    const [outbox] = await withOrg(app.db, acme.orgId, (tx) => tx.select().from(outboxEvents));
    expect(outbox).toMatchObject({ topic: 'receipt.uploaded', payload: { receiptId: input.id } });
    if (result.status === 'filed') expect(result.event.outboxId).toBe(outbox!.id);
  });

  it('treats a retried request as done, and a second copy of a file as a duplicate', async () => {
    const acme = await seedOrg(app.db, 'acme-receipt-dupes');
    const input = receipt(acme.memberId, 2);
    const file = (r: typeof input) =>
      withOrg(app.db, acme.orgId, (tx) => fileReceipt(tx, acme.orgId, r, acme.userId));
    await file(input);
    expect((await file(input)).status).toBe('exists');
    expect(await file({ ...input, id: newId() })).toEqual({
      status: 'duplicate',
      receiptId: input.id,
    });
    const events = await withOrg(app.db, acme.orgId, (tx) => tx.select().from(outboxEvents));
    expect(events).toHaveLength(1);
  });

  it('keeps receipts inside their organization', async () => {
    const acme = await seedOrg(app.db, 'acme-receipt-iso');
    const globex = await seedOrg(app.db, 'globex-receipt-iso');
    const input = receipt(acme.memberId, 3);
    await withOrg(app.db, acme.orgId, (tx) => fileReceipt(tx, acme.orgId, input, acme.userId));
    expect(await withOrg(app.db, globex.orgId, (tx) => getReceipt(tx, input.id))).toBeUndefined();
    expect(await withOrg(app.db, globex.orgId, (tx) => listReceipts(tx, 10))).toEqual([]);
    // The same file in another organization is not a duplicate.
    const theirs = await withOrg(app.db, globex.orgId, (tx) =>
      fileReceipt(tx, globex.orgId, receipt(globex.memberId, 3), globex.userId),
    );
    expect(theirs.status).toBe('filed');
  });
});

describe('reading a receipt', () => {
  it('records each model once per request, then settles once', async () => {
    const acme = await seedOrg(app.db, 'acme-readings');
    const input = receipt(acme.memberId, 4);
    const filed = await withOrg(app.db, acme.orgId, (tx) =>
      fileReceipt(tx, acme.orgId, input, acme.userId),
    );
    if (filed.status !== 'filed') throw new Error('expected a new receipt');
    const requestId = filed.event.outboxId;

    await withOrg(app.db, acme.orgId, async (tx) => {
      await recordExtractionRun(tx, acme.orgId, run(input.id, requestId, 'claude-haiku-4-5'));
      // A retried step writes the same reading again; it is ignored.
      await recordExtractionRun(tx, acme.orgId, run(input.id, requestId, 'claude-haiku-4-5'));
      await recordExtractionRun(tx, acme.orgId, run(input.id, requestId, 'claude-sonnet-5-5'));
    });
    const runs = await withOrg(app.db, acme.orgId, (tx) => runsForRequest(tx, input.id, requestId));
    expect(runs.map((r) => r.model).sort()).toEqual(['claude-haiku-4-5', 'claude-sonnet-5-5']);

    const settle = () =>
      withOrg(app.db, acme.orgId, (tx) =>
        settleReceipt(tx, acme.orgId, input.id, {
          status: 'extracted',
          requestId,
          detail: { differences: [] },
        }),
      );
    await settle();
    await settle();
    expect((await withOrg(app.db, acme.orgId, (tx) => getReceipt(tx, input.id)))?.status).toBe(
      'extracted',
    );
    const actions = await withOrg(app.db, acme.orgId, async (tx) =>
      (await tx.select().from(auditEvents).orderBy(asc(auditEvents.sequence))).map((e) => e.action),
    );
    expect(actions).toEqual(['receipt.captured', 'receipt.read']);
  });

  it('reads again on request, with a new request id', async () => {
    const acme = await seedOrg(app.db, 'acme-read-again');
    const input = receipt(acme.memberId, 5);
    await withOrg(app.db, acme.orgId, (tx) => fileReceipt(tx, acme.orgId, input, acme.userId));
    const again = await withOrg(app.db, acme.orgId, (tx) =>
      requestReceiptReading(tx, acme.orgId, input.id, acme.userId),
    );
    expect(again).toMatchObject({
      topic: 'receipt.read_requested',
      payload: { receiptId: input.id },
    });
    expect(
      await withOrg(app.db, acme.orgId, (tx) =>
        requestReceiptReading(tx, acme.orgId, newId(), acme.userId),
      ),
    ).toBeUndefined();

    await withOrg(app.db, acme.orgId, (tx) =>
      recordExtractionRun(tx, acme.orgId, run(input.id, again!.outboxId, 'claude-haiku-4-5')),
    );
    const all = await withOrg(app.db, acme.orgId, (tx) => listExtractionRuns(tx, [input.id]));
    expect(all.map((r) => r.requestId)).toEqual([again!.outboxId]);
  });
});
