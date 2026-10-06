/**
 * Who paid an expense: the policy by type, a person's switch on each expense, and what a change
 * of the policy reaches, on a real database as expensewise_app (FR-EXP-17, FR-EXP-18, Q46 to
 * Q48, ADR-0045). Run with `pnpm test:integration`.
 */
import { newId, type MemberRole } from '@expensewise/domain';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { classifyExpense, listCatalog } from '../src/categories.ts';
import { withMember, withOrg } from '../src/client.ts';
import {
  listCompanyPaid,
  setExpensePaidBy,
  setTypeCompanyPays,
  tallyPayers,
} from '../src/company-paid.ts';
import { deleteDuplicateReceipt } from '../src/duplicates.ts';
import { ensureOwnerOrganization } from '../src/members.ts';
import { fileReceipt, recordExtractionRun } from '../src/receipts.ts';
import { getReport } from '../src/reports.ts';
import {
  auditEvents,
  expenses,
  members,
  receiptDuplicates,
  receipts,
  reports,
} from '../src/schema.ts';
import { connectAs, expectDbError } from './helpers.ts';

const app = connectAs('app');
afterAll(async () => {
  await app.pool.end();
});

interface Person {
  readonly orgId: string;
  readonly memberId: string;
  readonly role: MemberRole;
  readonly userId: string;
}

/** An organization as one is created on first sign-in, with the ready-made types. */
async function freshOrg(name: string) {
  const userId = `user_${newId()}`;
  const { membership } = await ensureOwnerOrganization(app.db, {
    userId,
    email: `${name}@example.com`,
  });
  const owner: Person = { ...membership, userId };
  const inOrg = <T>(work: Parameters<typeof withOrg<T>>[2]) =>
    withOrg(app.db, membership.orgId, work);
  const catalog = await inOrg((tx) => listCatalog(tx));
  const typed = (name: string) => {
    const type = catalog.types.find((t) => t.name === name)!;
    const category = catalog.categories.find((c) => c.typeIds.includes(type.id))!;
    return { categoryId: category.id, typeId: type.id };
  };
  /** A member added by the system, as an accepted invite would. */
  const addMember = async (who: string, role: MemberRole): Promise<Person> => {
    const memberId = newId();
    await inOrg((tx) =>
      tx.insert(members).values({
        id: memberId,
        orgId: membership.orgId,
        userId: `user_${memberId}`,
        email: `${who}@example.com`,
        displayName: who,
        role,
      }),
    );
    return { orgId: membership.orgId, memberId, role, userId: `user_${memberId}` };
  };
  /** An expense typed in by hand for `who`, of a type, as a person gave it. */
  const addExpense = (
    who: Person,
    type: string | null,
    over: Partial<typeof expenses.$inferInsert> = {},
  ) =>
    inOrg(async (tx) => {
      const id = newId();
      await tx.insert(expenses).values({
        id,
        orgId: membership.orgId,
        memberId: who.memberId,
        status: 'ready',
        source: 'manual',
        merchant: 'United Airlines',
        transactionDate: '2026-09-24',
        amountMinor: 48_720,
        currency: 'USD',
        ...(type ? { ...typed(type), classifiedAt: new Date() } : {}),
        ...over,
      });
      return id;
    });
  const paid = async (ids: readonly string[]) =>
    Object.fromEntries(
      (
        await inOrg((tx) =>
          tx
            .select({
              id: expenses.id,
              companyPaid: expenses.companyPaid,
              pinned: expenses.companyPaidPinned,
            })
            .from(expenses)
            .where(inArray(expenses.id, [...ids])),
        )
      ).map((r) => [r.id, r.pinned ? `${String(r.companyPaid)}, pinned` : r.companyPaid]),
    );
  const events = (action: string) =>
    inOrg((tx) =>
      tx
        .select({ entityId: auditEvents.entityId, payload: auditEvents.payload })
        .from(auditEvents)
        .where(eq(auditEvents.action, action))
        .orderBy(auditEvents.sequence),
    );
  const policy = (type: string, companyPays: boolean, by: Person = owner) =>
    withOrg(app.db, membership.orgId, (tx) =>
      setTypeCompanyPays(tx, membership.orgId, typed(type).typeId, companyPays, by),
    );
  return { owner, inOrg, typed, addMember, addExpense, paid, events, policy };
}

describe('a change of the policy (FR-EXP-18, Q48)', () => {
  it('follows on every unsubmitted expense of its type not set by hand, and skips pinned, submitted and approved ones, with one audit event', async () => {
    const org = await freshOrg('company-pays-change');
    const sam = await org.addMember('sam', 'member');
    const ready = await org.addExpense(org.owner, 'Airfare');
    const reviewing = await org.addExpense(org.owner, 'Airfare', { status: 'needs_review' });
    const samsFare = await org.addExpense(sam, 'Airfare');
    const pinned = await org.addExpense(org.owner, 'Airfare', { companyPaidPinned: true });
    const submitted = await org.addExpense(org.owner, 'Airfare', { status: 'submitted' });
    const approved = await org.addExpense(org.owner, 'Airfare', { status: 'approved' });
    const lodging = await org.addExpense(org.owner, 'Lodging');
    const all = [ready, reviewing, samsFare, pinned, submitted, approved, lodging];

    const saved = await org.policy('Airfare', true);
    expect(saved.status).toBe('saved');
    const switched = [ready, reviewing, samsFare].sort();
    expect(saved.status === 'saved' && [...saved.switched].sort()).toEqual(switched);
    expect(await org.paid(all)).toEqual({
      [ready]: true,
      [reviewing]: true,
      [samsFare]: true,
      [pinned]: 'false, pinned',
      [submitted]: false,
      [approved]: false,
      [lodging]: false,
    });
    const [event, ...more] = await org.events('expense_type.company_pays_changed');
    expect(more).toEqual([]);
    expect(event?.entityId).toBe(org.typed('Airfare').typeId);
    expect(event?.payload).toMatchObject({ name: 'Airfare', before: false, after: true });
    expect([...((event?.payload as { switched: string[] }).switched ?? [])].sort()).toEqual(
      switched,
    );

    // The same again changes and records nothing; back, the same expenses follow it back.
    expect(await org.policy('Airfare', true)).toEqual({ status: 'unchanged' });
    const back = await org.policy('Airfare', false);
    expect(back.status === 'saved' && [...back.switched].sort()).toEqual(switched);
    expect((await org.paid(switched)) as Record<string, unknown>).toEqual(
      Object.fromEntries(switched.map((id) => [id, false])),
    );
    expect(await org.events('expense_type.company_pays_changed')).toHaveLength(2);
    expect(
      await org.inOrg((tx) => setTypeCompanyPays(tx, org.owner.orgId, newId(), true, org.owner)),
    ).toEqual({ status: 'missing' });
  });

  it('reopens a closed report one of its expenses is on, and never touches a drive', async () => {
    const org = await freshOrg('company-pays-reopen');
    const reportId = newId();
    await org.inOrg((tx) =>
      tx.insert(reports).values({
        id: reportId,
        orgId: org.owner.orgId,
        memberId: org.owner.memberId,
        title: 'September',
        currency: 'USD',
        status: 'closed',
        closesAt: new Date('2026-10-20T00:00:00Z'),
        closedAt: new Date('2026-10-01T00:00:00Z'),
      }),
    );
    const fare = await org.addExpense(org.owner, 'Airfare', { reportId, justification: 'Visit' });
    const drive = await org.addExpense(org.owner, 'Mileage', { source: 'mileage' });
    const saved = await org.policy('Airfare', true);
    expect(saved).toEqual({ status: 'saved', switched: [fare] });
    const [report] = await org.inOrg((tx) =>
      tx.select({ status: reports.status }).from(reports).where(eq(reports.id, reportId)),
    );
    expect(report?.status).toBe('open');
    expect(await org.policy('Mileage', true)).toEqual({ status: 'saved', switched: [] });
    expect(await org.paid([drive])).toEqual({ [drive]: false });
    // The database refuses a drive paid by the company, whoever asks.
    await expectDbError(
      org.inOrg((tx) =>
        tx.update(expenses).set({ companyPaid: true }).where(eq(expenses.id, drive)),
      ),
      /expenses_drive_not_company_paid/,
    );
  });
});

describe('a person gives an expense its type (FR-EXP-18, Q46)', () => {
  it('follows the policy for its new type unless set by hand, and with no type it is the person’s', async () => {
    const org = await freshOrg('company-pays-classify');
    await org.policy('Airfare', true);
    const fare = await org.addExpense(org.owner, null);
    expect(await org.paid([fare])).toEqual({ [fare]: false });
    const classify = (expenseId: string, type: string) =>
      withMember(app.db, org.owner, (tx) =>
        classifyExpense(tx, org.owner.orgId, expenseId, org.typed(type), org.owner.userId),
      );
    expect(await classify(fare, 'Airfare')).toEqual({ status: 'classified' });
    expect(await org.paid([fare])).toEqual({ [fare]: true });
    const [classified] = await org.events('expense.classified');
    expect(classified?.payload).toMatchObject({ companyPaid: { from: false, to: true } });
    expect(await classify(fare, 'Lodging')).toEqual({ status: 'classified' });
    expect(await org.paid([fare])).toEqual({ [fare]: false });

    const kept = await org.addExpense(org.owner, null, { companyPaidPinned: true });
    await classify(kept, 'Airfare');
    expect(await org.paid([kept])).toEqual({ [kept]: 'false, pinned' });
  });
});

describe('who paid one expense, set by hand (FR-EXP-17, Q46)', () => {
  it('sets it and pins it, hands it back to the policy, and refuses a drive and a submitted expense', async () => {
    const org = await freshOrg('company-paid-switch');
    const fare = await org.addExpense(org.owner, 'Airfare');
    await org.policy('Airfare', true);
    expect(await org.paid([fare])).toEqual({ [fare]: true });
    const set = (expenseId: string, choice: Parameters<typeof setExpensePaidBy>[3]) =>
      withMember(app.db, org.owner, (tx) =>
        setExpensePaidBy(tx, org.owner.orgId, expenseId, choice, org.owner.userId),
      );
    expect(await set(fare, { paidBy: 'claimant' })).toEqual({
      status: 'set',
      companyPaid: false,
      pinned: true,
    });
    // Set by hand, a change of the policy leaves it alone.
    await org.policy('Airfare', false);
    await org.policy('Airfare', true);
    expect(await org.paid([fare])).toEqual({ [fare]: 'false, pinned' });
    expect(await set(fare, { paidBy: 'claimant' })).toEqual({ status: 'unchanged' });
    expect(await set(fare, { byPolicy: true })).toEqual({
      status: 'set',
      companyPaid: true,
      pinned: false,
    });
    const [first, back] = await org.events('expense.paid_by_set');
    expect(first?.payload).toEqual({
      before: { paidBy: 'company', pinned: false },
      after: { paidBy: 'claimant', pinned: true },
      byPolicy: false,
    });
    expect(back?.payload).toEqual({
      before: { paidBy: 'claimant', pinned: true },
      after: { paidBy: 'company', pinned: false },
      byPolicy: true,
    });

    const drive = await org.addExpense(org.owner, null, { source: 'mileage' });
    expect(await set(drive, { paidBy: 'company' })).toEqual({
      status: 'not_changeable',
      problem: 'mileage',
      current: 'ready',
    });
    const submitted = await org.addExpense(org.owner, 'Airfare', { status: 'submitted' });
    expect(await set(submitted, { paidBy: 'claimant' })).toEqual({
      status: 'not_changeable',
      problem: 'locked',
      current: 'submitted',
    });
    expect(await set(newId(), { paidBy: 'company' })).toEqual({ status: 'missing' });
  });

  it('refuses a member switching another member’s expense, as an owner too (ADR-0035)', async () => {
    const org = await freshOrg('company-paid-own');
    const sam = await org.addMember('sam', 'member');
    const samsFare = await org.addExpense(sam, 'Airfare');
    await expectDbError(
      withMember(app.db, org.owner, (tx) =>
        setExpensePaidBy(tx, org.owner.orgId, samsFare, { paidBy: 'company' }, org.owner.userId),
      ),
      /own_records/,
    );
    expect(await org.paid([samsFare])).toEqual({ [samsFare]: false });
    const mine = await withMember(app.db, sam, (tx) =>
      setExpensePaidBy(tx, sam.orgId, samsFare, { paidBy: 'company' }, sam.userId),
    );
    expect(mine).toMatchObject({ status: 'set', companyPaid: true });
  });

  it('lets a member still delete a receipt whose expense the company paid', async () => {
    const org = await freshOrg('company-paid-delete');
    const alex = await org.addMember('alex', 'member');
    let n = 0;
    const receipt = async () => {
      const id = newId();
      const filed = await withMember(app.db, alex, (tx) =>
        fileReceipt(
          tx,
          alex.orgId,
          {
            id,
            memberId: alex.memberId,
            source: 'camera',
            storageKey: `orgs/${alex.orgId}/receipts/${id}`,
            contentType: 'image/jpeg',
            byteSize: 2048,
            sha256: `${id.replaceAll('-', '')}${String(n++).padStart(32, '0')}`.slice(0, 64),
          },
          alex.userId,
        ),
      );
      if (filed.status !== 'filed') throw new Error(`filing answered ${filed.status}`);
      await org.inOrg((tx) =>
        recordExtractionRun(tx, alex.orgId, {
          receiptId: id,
          requestId: filed.event.outboxId,
          extractor: 'claude',
          model: 'model-a',
          promptVersion: 'v1',
          schemaVersion: 'v1',
          outcome: 'confident',
          output: { merchant: 'United Airlines' },
          fieldConfidence: null,
          error: null,
          latencyMs: 900,
          inputTokens: 100,
          outputTokens: 20,
          costMicroUsd: 10,
        }),
      );
      return { receiptId: id, expenseId: filed.receipt.expenseId! };
    };
    const first = await receipt();
    const copy = await receipt();
    const switched = await withMember(app.db, alex, (tx) =>
      setExpensePaidBy(tx, alex.orgId, copy.expenseId, { paidBy: 'company' }, alex.userId),
    );
    expect(switched).toMatchObject({ status: 'set', companyPaid: true });
    await org.inOrg((tx) =>
      tx.insert(receiptDuplicates).values({
        orgId: alex.orgId,
        receiptId: copy.receiptId,
        otherReceiptId: first.receiptId,
        settledStatus: 'needs_review',
      }),
    );
    const deleted = await withMember(app.db, alex, (tx) =>
      deleteDuplicateReceipt(tx, alex.orgId, copy.receiptId, first.receiptId, alex.userId),
    );
    expect(deleted).toMatchObject({ status: 'deleted', kept: first.receiptId });
    const left = await org.inOrg((tx) =>
      tx.select({ id: receipts.id }).from(receipts).where(eq(receipts.memberId, alex.memberId)),
    );
    expect(left).toEqual([{ id: first.receiptId }]);
  });
});

describe('what a report holds, by who paid (FR-EXP-17)', () => {
  it('tallies its trips and local expenses by who paid, and lists what the company paid', async () => {
    const org = await freshOrg('company-paid-report');
    const reportId = newId();
    await org.inOrg((tx) =>
      tx.insert(reports).values({
        id: reportId,
        orgId: org.owner.orgId,
        memberId: org.owner.memberId,
        title: 'September',
        currency: 'USD',
        closesAt: new Date('2026-10-20T00:00:00Z'),
      }),
    );
    const fare = await org.addExpense(org.owner, 'Airfare', { reportId, companyPaid: true });
    const lunch = await org.addExpense(org.owner, null, {
      reportId,
      merchant: 'Zuni Café',
      amountMinor: 4820,
    });
    const tallies = await org.inOrg((tx) => tallyPayers(tx, { reportIds: [reportId] }));
    expect(
      tallies
        .map((t) => [t.reportId, t.tripId, t.currency, t.companyPaid, t.count, t.amountMinor])
        .sort((a, b) => String(a[3]).localeCompare(String(b[3]))),
    ).toEqual([
      [reportId, null, 'USD', false, 1, 4820],
      [reportId, null, 'USD', true, 1, 48_720],
    ]);
    const listed = await org.inOrg((tx) => listCompanyPaid(tx, [reportId]));
    expect(listed.map((e) => [e.id, e.onReportId, e.held])).toEqual([[fare, reportId, false]]);
    const report = await org.inOrg((tx) => getReport(tx, reportId));
    expect(report?.companyPaid?.map((e) => e.id)).toEqual([fare]);
    expect(report?.locals.map((e) => [e.id, e.companyPaid])).toEqual(
      expect.arrayContaining([
        [fare, true],
        [lunch, false],
      ]),
    );
  });
});
