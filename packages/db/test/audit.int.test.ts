import { verifyAuditChain } from '@expensewise/domain';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  appendAuditEvent,
  auditActorNames,
  checkAuditChain,
  listAuditEvents,
  readAuditChain,
} from '../src/audit.ts';
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

describe('reading the audit trail', () => {
  let acme: { orgId: string; memberId: string; userId: string };
  let globex: { orgId: string; memberId: string; userId: string };

  beforeAll(async () => {
    acme = await seedOrg(app.db, 'acme-trail');
    globex = await seedOrg(app.db, 'globex-trail');
  });

  it('lists the trail newest first, a page at a time, by record and by who made it', async () => {
    const riley = { type: 'user' as const, id: acme.userId };
    const workflow = { type: 'system' as const, id: 'receipt-workflow' };
    const events = [
      { actor: riley, entityType: 'receipt', entityId: 'r1', action: 'receipt.captured' },
      { actor: workflow, entityType: 'expense', entityId: 'e1', action: 'expense.created' },
      { actor: workflow, entityType: 'receipt', entityId: 'r1', action: 'receipt.read' },
      { actor: riley, entityType: 'expense', entityId: 'e1', action: 'expense.edited' },
      { actor: riley, entityType: 'receipt', entityId: 'r2', action: 'receipt.captured' },
    ];
    for (const event of events) {
      await withOrg(app.db, acme.orgId, (tx) => appendAuditEvent(tx, acme.orgId, event));
    }
    await withOrg(app.db, globex.orgId, (tx) =>
      appendAuditEvent(tx, globex.orgId, { ...events[0]!, actor: { type: 'user', id: 'x' } }),
    );

    const page = (filter: Parameters<typeof listAuditEvents>[2], limit = 10) =>
      withOrg(app.db, acme.orgId, async (tx) =>
        (await listAuditEvents(tx, acme.orgId, filter, limit)).map((e) => e.sequence),
      );
    expect(await page({}, 2)).toEqual([5, 4]);
    expect(await page({ before: 4 }, 2)).toEqual([3, 2]);
    expect(await page({ before: 2 }, 2)).toEqual([1]);
    expect(await page({ entityType: 'receipt', entityId: 'r1' })).toEqual([3, 1]);
    expect(await page({ entityId: 'e1' })).toEqual([4, 2]);
    expect(await page({ actorId: 'receipt-workflow' })).toEqual([3, 2]);
    expect(await page({ entityType: 'trip' })).toEqual([]);

    // The events listed are the stored chain itself: they verify as they are.
    const listed = await withOrg(app.db, acme.orgId, (tx) =>
      listAuditEvents(tx, acme.orgId, {}, 10),
    );
    expect(await verifyAuditChain([...listed].reverse())).toEqual({ ok: true });

    const names = await withOrg(app.db, acme.orgId, (tx) =>
      auditActorNames(tx, [acme.userId, globex.userId, 'receipt-workflow']),
    );
    expect(names).toEqual([
      { userId: acme.userId, name: 'acme-trail', email: 'acme-trail@example.com' },
    ]);
  });

  it('recomputes the chain on request, and finds the first event an edit broke', async () => {
    const initech = await seedOrg(app.db, 'initech-trail');
    const actor = { type: 'user' as const, id: initech.userId };
    for (const action of ['expense.created', 'expense.edited', 'expense.filed']) {
      await withOrg(app.db, initech.orgId, (tx) =>
        appendAuditEvent(tx, initech.orgId, {
          actor,
          entityType: 'expense',
          entityId: 'e7',
          action,
          payload: { amountMinor: 18420 },
        }),
      );
    }
    const check = () => withOrg(app.db, initech.orgId, (tx) => checkAuditChain(tx, initech.orgId));
    expect(await check()).toEqual({ intact: true, checked: 3, total: 3, brokenAt: null });

    // The table's owner can switch the guard off; the chain still shows what it did.
    await owner.db.transaction(async (tx) => {
      await tx.execute(sql`alter table audit_events disable trigger audit_events_append_only`);
      await tx.execute(
        sql`update audit_events set payload = '{"amountMinor":1842}'::jsonb
            where org_id = ${initech.orgId} and sequence = 2`,
      );
      await tx.execute(sql`alter table audit_events enable trigger audit_events_append_only`);
    });
    const broken = await check();
    expect(broken).toMatchObject({ intact: false, checked: 2, total: 3 });
    expect(broken.brokenAt).toMatchObject({ sequence: 2, action: 'expense.edited' });
    // Another organization's chain is untouched.
    expect(
      await withOrg(app.db, globex.orgId, (tx) => checkAuditChain(tx, globex.orgId)),
    ).toMatchObject({ intact: true });
  });
});
