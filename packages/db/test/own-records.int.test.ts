import { newId, type MemberRole } from '@expensewise/domain';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  isOwnRecordsRefusal,
  switchOrg,
  withMember,
  withOrg,
  type Transaction,
} from '../src/client.ts';
import { appendAuditEvent } from '../src/audit.ts';
import { deleteDuplicateReceipt } from '../src/duplicates.ts';
import { fileReceipt, recordExtractionRun } from '../src/receipts.ts';
import {
  auditEvents,
  expenses,
  extractionRuns,
  members,
  receiptDuplicates,
  receipts,
  reports,
  trips,
} from '../src/schema.ts';
import { createTrip } from '../src/trips.ts';
import { connectAs, expectDbError, seedOrg } from './helpers.ts';

const app = connectAs('app');
const owner = connectAs('owner');
afterAll(async () => {
  await app.pool.end();
  await owner.pool.end();
});

interface Person {
  readonly orgId: string;
  readonly memberId: string;
  readonly role: MemberRole;
  readonly userId: string;
}

/** A member added to an organization by the system, as an accepted invite would. */
async function addMember(orgId: string, name: string, role: MemberRole): Promise<Person> {
  const memberId = newId();
  const userId = `user_${memberId}`;
  await withOrg(app.db, orgId, (tx) =>
    tx.insert(members).values({
      id: memberId,
      orgId,
      userId,
      email: `${name}@example.com`,
      displayName: name,
      role,
    }),
  );
  return { orgId, memberId, role, userId };
}

let counter = 0x50_0000;
const sha = () => (counter++).toString(16).padStart(64, '0');

/** One receipt with its expense and a reading, and one trip, made by `who` as themselves. */
async function workOf(who: Person, place: string) {
  const id = newId();
  const filed = await withMember(app.db, who, (tx) =>
    fileReceipt(
      tx,
      who.orgId,
      {
        id,
        memberId: who.memberId,
        source: 'camera',
        storageKey: `orgs/${who.orgId}/receipts/${id}`,
        contentType: 'image/jpeg',
        byteSize: 2048,
        sha256: sha(),
      },
      who.userId,
    ),
  );
  if (filed.status !== 'filed') throw new Error(`filing for ${place} answered ${filed.status}`);
  // The reading workflow acts for the system.
  await withOrg(app.db, who.orgId, (tx) =>
    recordExtractionRun(tx, who.orgId, {
      receiptId: id,
      requestId: filed.event.outboxId,
      extractor: 'claude',
      model: 'model-a',
      promptVersion: 'v1',
      schemaVersion: 'v1',
      outcome: 'confident',
      output: { merchant: place },
      fieldConfidence: null,
      error: null,
      latencyMs: 900,
      inputTokens: 100,
      outputTokens: 20,
      costMicroUsd: 10,
    }),
  );
  const trip = await withMember(app.db, who, (tx) =>
    createTrip(
      tx,
      who.orgId,
      who.memberId,
      { name: place, startDate: '2026-09-21', endDate: '2026-09-23' },
      who.userId,
    ),
  );
  if (trip.status !== 'saved') throw new Error('the trip was not made');
  return { receiptId: id, expenseId: filed.receipt.expenseId!, tripId: trip.tripId };
}

const everything = async (tx: Transaction) => ({
  receipts: (await tx.select({ m: receipts.memberId }).from(receipts)).map((r) => r.m).sort(),
  expenses: (await tx.select({ m: expenses.memberId }).from(expenses)).map((r) => r.m).sort(),
  trips: (await tx.select({ m: trips.memberId }).from(trips)).map((r) => r.m).sort(),
  readings: (
    await tx
      .select({ m: receipts.memberId })
      .from(extractionRuns)
      .innerJoin(receipts, eq(receipts.id, extractionRuns.receiptId))
  )
    .map((r) => r.m)
    .sort(),
});

describe('members see and change only their own records (GAP-20, ADR-0035)', () => {
  let alex: Person;
  let blair: Person;
  let finance: Person;
  let auditor: Person;
  let alexWork: Awaited<ReturnType<typeof workOf>>;
  let blairWork: Awaited<ReturnType<typeof workOf>>;
  const only = (...people: Person[]) => {
    const ids = people.map((p) => p.memberId).sort();
    return { receipts: ids, expenses: ids, trips: ids, readings: ids };
  };

  beforeAll(async () => {
    const org = await seedOrg(app.db, 'own-records');
    alex = await addMember(org.orgId, 'alex', 'member');
    blair = await addMember(org.orgId, 'blair', 'approver');
    finance = await addMember(org.orgId, 'finn', 'finance_admin');
    auditor = await addMember(org.orgId, 'audrey', 'auditor');
    alexWork = await workOf(alex, 'Omaha');
    blairWork = await workOf(blair, 'Houston');
  });

  it("can't see another member's receipts, expenses or trips, or their readings", async () => {
    expect(await withMember(app.db, alex, everything)).toEqual(only(alex));
    expect(await withMember(app.db, blair, everything)).toEqual(only(blair));
    const peek = await withMember(app.db, alex, (tx) =>
      tx.select().from(receipts).where(eq(receipts.id, blairWork.receiptId)),
    );
    expect(peek).toEqual([]);
  });

  it("can't change, delete or file another member's records", async () => {
    const changed = await withMember(app.db, alex, (tx) =>
      tx
        .update(expenses)
        .set({ merchant: 'Changed by alex' })
        .where(eq(expenses.id, blairWork.expenseId))
        .returning({ id: expenses.id }),
    );
    expect(changed).toEqual([]);
    const deleted = await withMember(app.db, alex, (tx) =>
      tx.delete(trips).where(eq(trips.id, blairWork.tripId)).returning({ id: trips.id }),
    );
    expect(deleted).toEqual([]);
    await expectDbError(
      withMember(app.db, alex, (tx) =>
        tx.insert(trips).values({
          orgId: alex.orgId,
          memberId: blair.memberId,
          name: 'In blair’s name',
          startDate: '2026-10-01',
          endDate: '2026-10-02',
        }),
      ),
      /own_records/,
    );
    const [trip] = await withOrg(app.db, blair.orgId, (tx) =>
      tx.select({ id: trips.id }).from(trips).where(eq(trips.id, blairWork.tripId)),
    );
    expect(trip).toBeDefined();
    const [expense] = await withOrg(app.db, blair.orgId, (tx) =>
      tx
        .select({ merchant: expenses.merchant })
        .from(expenses)
        .where(eq(expenses.id, blairWork.expenseId)),
    );
    expect(expense?.merchant).not.toBe('Changed by alex');
  });

  it('still sees and changes their own, as they did alone', async () => {
    const changed = await withMember(app.db, alex, (tx) =>
      tx
        .update(trips)
        .set({ purpose: 'Client visit' })
        .where(eq(trips.id, alexWork.tripId))
        .returning({ id: trips.id }),
    );
    expect(changed).toEqual([{ id: alexWork.tripId }]);
  });

  it("lets a finance admin see both members' records, and change neither", async () => {
    expect(await withMember(app.db, finance, everything)).toEqual(only(alex, blair));
    // The refusal is an error, so the whole change rolls back, its audit event too.
    const error = await withMember(app.db, finance, async (tx) => {
      await appendAuditEvent(tx, finance.orgId, {
        actor: { type: 'user', id: finance.userId },
        entityType: 'expense',
        entityId: alexWork.expenseId,
        action: 'expense.fixed_by_finance',
      });
      await tx
        .update(expenses)
        .set({ merchant: 'Fixed' })
        .where(eq(expenses.id, alexWork.expenseId));
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(isOwnRecordsRefusal(error)).toBe(true);
    const recorded = await withOrg(app.db, finance.orgId, (tx) =>
      tx.select().from(auditEvents).where(eq(auditEvents.action, 'expense.fixed_by_finance')),
    );
    expect(recorded).toEqual([]);
  });

  it('lets an auditor read every record and change nothing, not even their own', async () => {
    expect(await withMember(app.db, auditor, everything)).toEqual(only(alex, blair));
    await expectDbError(
      withMember(app.db, auditor, (tx) =>
        tx.update(trips).set({ name: 'Audited' }).where(eq(trips.id, blairWork.tripId)),
      ),
      /own_records/,
    );
    await expectDbError(
      withMember(app.db, auditor, (tx) =>
        tx.insert(trips).values({
          orgId: auditor.orgId,
          memberId: auditor.memberId,
          name: 'An auditor’s own',
          startDate: '2026-10-01',
          endDate: '2026-10-02',
        }),
      ),
      /own_records/,
    );
  });

  it('acts for the system, as workflows do, when no member is named', async () => {
    expect(await withOrg(app.db, alex.orgId, everything)).toEqual(only(alex, blair));
    const changed = await withOrg(app.db, alex.orgId, (tx) =>
      tx
        .update(receipts)
        .set({ status: 'extracted' })
        .where(sql`${receipts.id} in (${alexWork.receiptId}, ${blairWork.receiptId})`)
        .returning({ id: receipts.id }),
    );
    expect(changed).toHaveLength(2);
  });

  it('acts for the system again after moving to an organization', async () => {
    const seen = await withMember(app.db, alex, async (tx) => {
      await switchOrg(tx, alex.orgId);
      return everything(tx);
    });
    expect(seen).toEqual(only(alex, blair));
  });

  it('refuses a member that is not a member id and role', async () => {
    await expect(
      withMember(app.db, { ...alex, memberId: 'alex' }, (tx) => tx.select().from(trips)),
    ).rejects.toThrow(/member UUID/);
    await expect(
      withMember(app.db, { ...alex, role: 'admin' as MemberRole }, (tx) => tx.select().from(trips)),
    ).rejects.toThrow(/member role/);
  });
});

describe('a possible duplicate, settled by its member', () => {
  it('deletes the copy through delete_receipt(), and refuses a finance admin doing it for them', async () => {
    const org = await seedOrg(app.db, 'own-records-duplicates');
    const alex = await addMember(org.orgId, 'alex', 'member');
    const finance = await addMember(org.orgId, 'finn', 'finance_admin');
    const first = await workOf(alex, 'Austin');
    const copy = await workOf(alex, 'Austin again');
    // The reading workflow, for the system, holds the later one as a possible copy.
    await withOrg(app.db, org.orgId, (tx) =>
      tx.insert(receiptDuplicates).values({
        orgId: org.orgId,
        receiptId: copy.receiptId,
        otherReceiptId: first.receiptId,
        settledStatus: 'needs_review',
      }),
    );
    await expectDbError(
      withMember(app.db, finance, (tx) =>
        deleteDuplicateReceipt(tx, org.orgId, copy.receiptId, first.receiptId, finance.userId),
      ),
      /own_records/,
    );
    const deleted = await withMember(app.db, alex, (tx) =>
      deleteDuplicateReceipt(tx, org.orgId, copy.receiptId, first.receiptId, alex.userId),
    );
    expect(deleted).toMatchObject({ status: 'deleted', kept: first.receiptId });
    const left = await withOrg(app.db, org.orgId, (tx) =>
      tx.select({ id: receipts.id }).from(receipts),
    );
    expect(left).toEqual([{ id: first.receiptId }]);
  });
});

describe('a one-person organization', () => {
  it('works for its owner as it did before', async () => {
    const solo = await seedOrg(app.db, 'own-records-solo');
    const me: Person = { ...solo, role: 'owner' };
    const work = await workOf(me, 'Chicago');
    expect(await withMember(app.db, me, everything)).toEqual({
      receipts: [me.memberId],
      expenses: [me.memberId],
      trips: [me.memberId],
      readings: [me.memberId],
    });
    const deleted = await withMember(app.db, me, (tx) =>
      tx.delete(trips).where(eq(trips.id, work.tripId)).returning({ id: trips.id }),
    );
    expect(deleted).toEqual([{ id: work.tripId }]);
  });
});

describe('policy coverage for members’ own records', () => {
  it('keeps every table of a member’s records to that member, for reading and changing', async () => {
    const { rows } = await owner.db.execute<{
      table: string;
      policy: boolean;
      trigger: boolean;
    }>(sql`
      select c.relname as "table",
             exists (select 1 from pg_policies p
                      where p.schemaname = 'public' and p.tablename = c.relname
                        and p.policyname = 'own_records' and p.permissive = 'RESTRICTIVE'
                        and p.cmd = 'SELECT') as policy,
             exists (select 1 from pg_trigger t
                      where t.tgrelid = c.oid and t.tgname = 'own_records'
                        and not t.tgisinternal) as "trigger"
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r'
       order by 1`);
    const byTable = new Map(rows.map((r) => [r.table, r]));
    // Every table with a member's records, found by its member_id column, and what hangs off them.
    const { rows: owned } = await owner.db.execute<{ table: string }>(sql`
      select table_name as "table" from information_schema.columns
       where table_schema = 'public' and column_name = 'member_id'`);
    const hanging = ['extraction_runs', 'receipt_duplicates', 'mileage_logs'];
    // A sign-in is how a member reaches the organization, not a record of their work.
    const notRecords = new Set(['member_sign_ins']);
    const tables = [...owned.map((r) => r.table).filter((t) => !notRecords.has(t)), ...hanging];
    expect(tables).toEqual(
      expect.arrayContaining(['receipts', 'expenses', 'trips', 'reports', 'inbound_emails']),
    );
    for (const table of tables) {
      expect(byTable.get(table)?.policy, `${table} shows a member only their own`).toBe(true);
      expect(byTable.get(table)?.trigger, `${table} lets a member change only their own`).toBe(
        true,
      );
    }
    expect(byTable.get('approval_steps')?.policy, 'approval steps follow their report').toBe(true);
  });

  it('keeps reports to their member too', async () => {
    const org = await seedOrg(app.db, 'own-records-reports');
    const sam = await addMember(org.orgId, 'sam', 'member');
    const report = await withOrg(app.db, org.orgId, (tx) =>
      tx
        .insert(reports)
        .values({
          orgId: org.orgId,
          memberId: org.memberId,
          title: 'September',
          currency: 'USD',
          closesAt: new Date('2026-11-01T00:00:00Z'),
        })
        .returning({ id: reports.id }),
    );
    expect(report).toHaveLength(1);
    expect(await withMember(app.db, sam, (tx) => tx.select().from(reports))).toEqual([]);
    expect(
      await withMember(app.db, { ...org, role: 'owner' }, (tx) => tx.select().from(reports)),
    ).toHaveLength(1);
  });
});
