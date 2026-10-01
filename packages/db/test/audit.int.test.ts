import { verifyAuditChain } from '@expensewise/domain';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appendAuditEvent, readAuditChain } from '../src/audit.ts';
import { withOrg } from '../src/client.ts';
import { auditEvents } from '../src/schema.ts';
import { connectAs, expectDbError, seedOrg } from './helpers.ts';

const app = connectAs('app');
const owner = connectAs('owner');
afterAll(async () => {
  await app.pool.end();
  await owner.pool.end();
});

describe('audit log', () => {
  let acme: { orgId: string; memberId: string };
  let globex: { orgId: string; memberId: string };

  beforeAll(async () => {
    acme = await seedOrg(app.db, 'acme-audit');
    globex = await seedOrg(app.db, 'globex-audit');
  });

  it('chains events so the stored history verifies', async () => {
    const actor = { type: 'user' as const, id: acme.memberId };
    await withOrg(app.db, acme.orgId, async (tx) => {
      await appendAuditEvent(tx, acme.orgId, {
        actor,
        entityType: 'expense',
        entityId: 'e1',
        action: 'created',
        payload: { amountMinor: 18420, currency: 'USD' },
      });
      await appendAuditEvent(tx, acme.orgId, {
        actor,
        entityType: 'expense',
        entityId: 'e1',
        action: 'submitted',
      });
    });
    await withOrg(app.db, acme.orgId, (tx) =>
      appendAuditEvent(tx, acme.orgId, {
        actor: { type: 'system', id: null },
        entityType: 'expense',
        entityId: 'e1',
        action: 'approved',
      }),
    );
    await withOrg(app.db, globex.orgId, (tx) =>
      appendAuditEvent(tx, globex.orgId, {
        actor,
        entityType: 'expense',
        entityId: 'e9',
        action: 'created',
      }),
    );

    const chain = await withOrg(app.db, acme.orgId, (tx) => readAuditChain(tx, acme.orgId));
    expect(chain.map((e) => [e.sequence, e.action])).toEqual([
      [1, 'created'],
      [2, 'submitted'],
      [3, 'approved'],
    ]);
    expect(await verifyAuditChain(chain)).toEqual({ ok: true });
  });

  it('keeps sequences gapless under concurrent writers', async () => {
    const actor = { type: 'system' as const, id: null };
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        withOrg(app.db, globex.orgId, (tx) =>
          appendAuditEvent(tx, globex.orgId, {
            actor,
            entityType: 'receipt',
            entityId: `r${i}`,
            action: 'extracted',
          }),
        ),
      ),
    );
    const chain = await withOrg(app.db, globex.orgId, (tx) => readAuditChain(tx, globex.orgId));
    expect(chain.map((e) => e.sequence)).toEqual(Array.from({ length: 13 }, (_, i) => i + 1));
    expect(await verifyAuditChain(chain)).toEqual({ ok: true });
  });

  it('denies UPDATE and DELETE to the application role', async () => {
    await expectDbError(
      withOrg(app.db, acme.orgId, (tx) =>
        tx
          .update(auditEvents)
          .set({ action: 'rewritten' })
          .where(eq(auditEvents.orgId, acme.orgId)),
      ),
      /permission denied/,
    );
    await expectDbError(
      withOrg(app.db, acme.orgId, (tx) =>
        tx.delete(auditEvents).where(eq(auditEvents.orgId, acme.orgId)),
      ),
      /permission denied/,
    );
  });

  it('blocks even the table owner from rewriting history', async () => {
    await expectDbError(
      owner.db.execute(sql`update audit_events set action = 'rewritten'`),
      /append-only/,
    );
    await expectDbError(owner.db.execute(sql`delete from audit_events`), /append-only/);
    await expectDbError(owner.db.execute(sql`truncate audit_events`), /append-only/);
  });
});
