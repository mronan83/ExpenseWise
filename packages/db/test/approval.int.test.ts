import { newId, type MemberRole, type ReceiptCheck } from '@expensewise/domain';
import { asc, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import {
  approvalOf,
  decideReport,
  returnedReports,
  reportsToApprove,
  reviewExpenses,
  setClaimReason,
  submitReport,
  type Decision,
  type ReceiptJudge,
} from '../src/approval.ts';
import { withMember, withOrg, type Transaction } from '../src/client.ts';
import { seedStarterCatalog } from '../src/categories.ts';
import { editExpense } from '../src/expenses.ts';
import { reportCategories } from '../src/itemized.ts';
import { reportForExport } from '../src/report-export.ts';
import { closeDueReports, moveToReport } from '../src/reports.ts';
import {
  auditEvents,
  categories,
  expenseParts,
  expenseRejections,
  expenses,
  expenseTypes,
  members,
  receipts,
  reports,
  trips,
} from '../src/schema.ts';
import { fileExpenseToTrip, setExpenseTrip } from '../src/trips.ts';
import { connectAs, expectDbError, seedOrg } from './helpers.ts';

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

const NOW = new Date('2026-10-05T12:00:00Z');
let sha = 0x7a_0000;

/** Every expense judged as given, and as having no receipt otherwise. */
const judged =
  (checks: Record<string, ReceiptCheck> = {}): ReceiptJudge =>
  (_tx, list) =>
    Promise.resolve(new Map(list.map((e) => [e.id, checks[e.id] ?? { state: 'no_receipt' }])));
const DIFFERS: ReceiptCheck = {
  state: 'differs',
  differences: ['date'],
  over: false,
  needsReason: false,
};

/** An organization of Riley, its owner, and whoever else a test asks for, oldest first. */
async function team(name: string, others: readonly [string, MemberRole][]) {
  const org = await seedOrg(app.db, name);
  const riley: Person = { ...org, role: 'owner' };
  const people: Record<string, Person> = { riley };
  for (const [who, role] of others) {
    const memberId = newId();
    await withOrg(app.db, org.orgId, (tx) =>
      tx.insert(members).values({
        id: memberId,
        orgId: org.orgId,
        userId: `user_${memberId}`,
        email: `${who}@example.com`,
        displayName: who,
        role,
        // Each joins after the one before, so the longest-standing is clear.
        createdAt: new Date(Date.UTC(2026, 8, 1 + Object.keys(people).length)),
      }),
    );
    people[who] = { orgId: org.orgId, memberId, role, userId: `user_${memberId}` };
  }
  await withOrg(app.db, org.orgId, (tx) => seedStarterCatalog(tx, org.orgId));
  return people;
}

/**
 * A closed report of `who`'s, made by the system: a trip with a coffee on it, with a receipt,
 * and a local lunch with its reason, both coded Meals · Business meal; the lunch split in two.
 */
async function closedReport(who: Person) {
  return withOrg(app.db, who.orgId, async (tx) => {
    const [meals] = await tx.select().from(categories).where(eq(categories.starterKey, 'meals'));
    const [meal] = await tx
      .select()
      .from(expenseTypes)
      .where(eq(expenseTypes.starterKey, 'business_meal'));
    const [report] = await tx
      .insert(reports)
      .values({
        orgId: who.orgId,
        memberId: who.memberId,
        title: 'September',
        currency: 'USD',
        status: 'closed',
        closedAt: new Date('2026-10-01T00:00:00Z'),
        closesAt: new Date('2026-10-20T00:00:00Z'),
      })
      .returning({ id: reports.id });
    const [trip] = await tx
      .insert(trips)
      .values({
        orgId: who.orgId,
        memberId: who.memberId,
        name: 'Omaha',
        startDate: '2026-09-21',
        endDate: '2026-09-23',
        reportId: report!.id,
      })
      .returning({ id: trips.id });
    const coded = { categoryId: meals!.id, typeId: meal!.id, classifiedAt: NOW };
    const coffee = newId();
    const lunch = newId();
    await tx.insert(expenses).values([
      {
        id: coffee,
        orgId: who.orgId,
        memberId: who.memberId,
        tripId: trip!.id,
        status: 'ready',
        source: 'camera',
        merchant: 'Blue Bottle',
        transactionDate: '2026-09-22',
        currency: 'USD',
        amountMinor: 650,
        ...coded,
      },
      {
        id: lunch,
        orgId: who.orgId,
        memberId: who.memberId,
        reportId: report!.id,
        status: 'ready',
        source: 'manual',
        merchant: 'Verve',
        transactionDate: '2026-09-28',
        currency: 'USD',
        amountMinor: 2400,
        justification: 'Lunch with the Acme team',
        ...coded,
      },
    ]);
    await tx.insert(receipts).values({
      orgId: who.orgId,
      memberId: who.memberId,
      expenseId: coffee,
      source: 'camera',
      storageKey: `orgs/${who.orgId}/receipts/${coffee}`,
      contentType: 'image/jpeg',
      byteSize: 1024,
      sha256: (sha++).toString(16).padStart(64, '0'),
      status: 'extracted',
    });
    await tx.insert(expenseParts).values([
      {
        orgId: who.orgId,
        expenseId: lunch,
        position: 1,
        basis: 'amounts',
        amountMinor: 1400,
        currency: 'USD',
        categoryId: meals!.id,
        typeId: meal!.id,
      },
      {
        orgId: who.orgId,
        expenseId: lunch,
        position: 2,
        basis: 'amounts',
        amountMinor: 1000,
        currency: 'USD',
        categoryId: meals!.id,
        typeId: meal!.id,
      },
    ]);
    return { reportId: report!.id, tripId: trip!.id, coffee, lunch, categoryId: meals!.id };
  });
}

const submit = (who: Person, reportId: string, judge = judged()) =>
  withMember(app.db, who, (tx) =>
    submitReport(
      tx,
      who.orgId,
      reportId,
      { memberId: who.memberId, userId: who.userId },
      judge,
      NOW,
    ),
  );

const decide = (
  who: Person,
  reportId: string,
  decision: Decision,
  { secondFactor = true, judge = judged() }: { secondFactor?: boolean; judge?: ReceiptJudge } = {},
) =>
  withMember(app.db, who, (tx) =>
    decideReport(
      tx,
      who.orgId,
      reportId,
      { memberId: who.memberId, role: who.role, userId: who.userId, secondFactor },
      decision,
      judge,
      NOW,
    ),
  );

const statusOf = async (who: Person, reportId: string) =>
  withOrg(app.db, who.orgId, async (tx) => {
    const [report] = await tx.select().from(reports).where(eq(reports.id, reportId));
    const onIt = await reviewExpenses(tx, reportId);
    return { report: report!, expenses: onIt.map((e) => e.status) };
  });

const actionsOf = (who: Person, entityId: string) =>
  withOrg(app.db, who.orgId, async (tx) =>
    tx
      .select({ action: auditEvents.action, payload: auditEvents.payload })
      .from(auditEvents)
      .where(eq(auditEvents.entityId, entityId))
      .orderBy(asc(auditEvents.sequence)),
  );

describe('submitting a report for approval (FR-GOV-02, FR-GOV-13)', () => {
  it('submits a closed report to its approver in one step, each expense submitted with its names copied', async () => {
    const t = await team('approval-submit', [
      ['alex', 'member'],
      ['casey', 'approver'],
      ['fin', 'finance_admin'],
    ]);
    const work = await closedReport(t.alex!);
    expect(await submit(t.alex!, work.reportId)).toEqual({
      status: 'submitted',
      stepId: expect.any(String) as string,
      approverMemberId: t.casey!.memberId,
      selfAttests: false,
    });
    const after = await statusOf(t.alex!, work.reportId);
    expect(after.report).toMatchObject({ status: 'in_approval', submittedAt: NOW });
    expect(after.expenses).toEqual(['submitted', 'submitted']);
    const copied = await withOrg(app.db, t.alex!.orgId, async (tx) => ({
      expenses: await tx
        .select({ category: expenses.categoryName, type: expenses.typeName })
        .from(expenses)
        .where(inArray(expenses.id, [work.coffee, work.lunch])),
      parts: await tx
        .select({ category: expenseParts.categoryName, type: expenseParts.typeName })
        .from(expenseParts)
        .where(eq(expenseParts.expenseId, work.lunch)),
    }));
    expect(copied.expenses).toEqual([
      { category: 'Meals', type: 'Business meal' },
      { category: 'Meals', type: 'Business meal' },
    ]);
    expect(copied.parts).toEqual([
      { category: 'Meals', type: 'Business meal' },
      { category: 'Meals', type: 'Business meal' },
    ]);
    const approval = await withMember(app.db, t.alex!, (tx) => approvalOf(tx, work.reportId));
    expect(approval.steps).toEqual([
      expect.objectContaining({ sequence: 1, decision: 'pending', approver: 'casey' }),
    ]);
    expect((await actionsOf(t.alex!, work.reportId)).at(-1)).toEqual({
      action: 'report.submitted',
      payload: expect.objectContaining({
        approverMemberId: t.casey!.memberId,
        selfAttests: false,
        sequence: 1,
      }) as unknown,
    });
  });

  it('refuses one not closed, another member’s, one differing from its receipt without a reason, and one no one else can approve', async () => {
    const t = await team('approval-refuse', [['alex', 'member']]);
    const work = await closedReport(t.alex!);
    expect(await submit(t.riley!, work.reportId)).toEqual({ status: 'not_yours' });
    expect(await submit(t.alex!, work.reportId, judged({ [work.coffee]: DIFFERS }))).toEqual({
      status: 'differs',
      differences: [
        { expenseId: work.coffee, check: DIFFERS, reason: 'Its date isn’t its receipt’s.' },
      ],
    });
    // A lower claim with its reason holds up; review still checks it.
    const explained = await submit(
      t.alex!,
      work.reportId,
      judged({ [work.coffee]: { state: 'explained', by: 'reason' } }),
    );
    expect(explained).toEqual({
      status: 'submitted',
      stepId: expect.any(String) as string,
      approverMemberId: t.riley!.memberId,
      selfAttests: false,
    });
    expect(await submit(t.alex!, work.reportId)).toEqual({
      status: 'not_closed',
      current: 'in_approval',
    });
    // Riley's own: the only other member can't approve it.
    const own = await closedReport(t.riley!);
    expect(await submit(t.riley!, own.reportId)).toEqual({ status: 'no_approver' });
    expect((await statusOf(t.riley!, own.reportId)).report.status).toBe('closed');
  });
});

describe('who sees and decides a report (FR-GOV-03, ADR-0035)', () => {
  it('shows a report routed to an approver, and what is on it, and nothing else of its member’s', async () => {
    const t = await team('approval-see', [
      ['alex', 'member'],
      ['casey', 'approver'],
      ['jordan', 'approver'],
    ]);
    const work = await closedReport(t.alex!);
    const other = await closedReport(t.alex!);
    await submit(t.alex!, work.reportId);
    const seen = (who: Person) =>
      withMember(app.db, who, async (tx: Transaction) => ({
        reports: (await tx.select({ id: reports.id }).from(reports)).map((r) => r.id),
        trips: (await tx.select({ id: trips.id }).from(trips)).map((r) => r.id),
        expenses: (await tx.select({ id: expenses.id }).from(expenses)).map((r) => r.id).sort(),
        receipts: (await tx.select({ id: receipts.expenseId }).from(receipts)).map((r) => r.id),
        toApprove: await reportsToApprove(tx, who.memberId),
      }));
    expect(await seen(t.casey!)).toEqual({
      reports: [work.reportId],
      trips: [work.tripId],
      expenses: [work.coffee, work.lunch].sort(),
      receipts: [work.coffee],
      toApprove: [work.reportId],
    });
    // Another approver sees none of it, and Alex's other report stays Alex's.
    expect(await seen(t.jordan!)).toEqual({
      reports: [],
      trips: [],
      expenses: [],
      receipts: [],
      toApprove: [],
    });
    expect((await seen(t.alex!)).reports.sort()).toEqual([work.reportId, other.reportId].sort());
    expect(await decide(t.jordan!, work.reportId, { kind: 'approve' })).toEqual({
      status: 'missing',
    });
  });

  it('lets the approver decide it, changing only its status and its expenses’, and nothing else of its member’s', async () => {
    const t = await team('approval-change', [
      ['alex', 'member'],
      ['casey', 'approver'],
    ]);
    const work = await closedReport(t.alex!);
    await submit(t.alex!, work.reportId);
    // Even while deciding it, the approver changes nothing but its state.
    await expectDbError(
      withMember(app.db, t.casey!, async (tx) => {
        await tx.execute(`select set_config('app.deciding_report', '${work.reportId}', true)`);
        await tx.update(expenses).set({ amountMinor: 1 }).where(eq(expenses.id, work.coffee));
      }),
      /own_records/,
    );
    // Nor without deciding it: its rejections, its step and its member's expenses are not theirs.
    await expectDbError(
      withMember(app.db, t.casey!, (tx) =>
        tx.update(expenses).set({ status: 'approved' }).where(eq(expenses.id, work.coffee)),
      ),
      /own_records/,
    );
    await expectDbError(
      withMember(app.db, t.alex!, async (tx) => {
        const [step] = (await approvalOf(tx, work.reportId)).steps;
        await tx.insert(expenseRejections).values({
          orgId: t.alex!.orgId,
          stepId: step!.id,
          expenseId: work.coffee,
          reason: 'I reject my own',
        });
        await tx.execute(
          `update approval_steps set decision = 'approved' where id = '${step!.id}'`,
        );
      }),
      /own_records/,
    );

    expect(await decide(t.casey!, work.reportId, { kind: 'approve' })).toEqual({
      status: 'approved',
      basis: 'separation_of_duties',
    });
    const after = await statusOf(t.alex!, work.reportId);
    expect(after.report).toMatchObject({ status: 'approved', approvedAt: NOW });
    expect(after.expenses).toEqual(['approved', 'approved']);
    // Once decided, it is decided: nothing more is changed under it.
    expect(await decide(t.casey!, work.reportId, { kind: 'approve' })).toEqual({
      status: 'not_in_approval',
      current: 'approved',
    });
    await expectDbError(
      withMember(app.db, t.casey!, async (tx) => {
        await tx.execute(`select set_config('app.deciding_report', '${work.reportId}', true)`);
        await tx
          .update(reports)
          .set({ status: 'open', closedAt: null })
          .where(eq(reports.id, work.reportId));
      }),
      /own_records/,
    );
  });

  it('asks for the second factor to approve someone else’s, and never to self-attest alone', async () => {
    const t = await team('approval-aal', [
      ['alex', 'member'],
      ['casey', 'approver'],
    ]);
    const work = await closedReport(t.alex!);
    await submit(t.alex!, work.reportId);
    expect(
      await decide(t.casey!, work.reportId, { kind: 'approve' }, { secondFactor: false }),
    ).toEqual({
      status: 'second_factor_required',
    });
    expect((await statusOf(t.alex!, work.reportId)).report.status).toBe('in_approval');

    const solo = await team('approval-solo', []);
    const own = await closedReport(solo.riley!);
    expect(await submit(solo.riley!, own.reportId)).toMatchObject({
      status: 'submitted',
      approverMemberId: solo.riley!.memberId,
      selfAttests: true,
    });
    expect(
      await decide(solo.riley!, own.reportId, { kind: 'approve' }, { secondFactor: false }),
    ).toEqual({
      status: 'approved',
      basis: 'solo_self_attestation',
    });
    expect((await actionsOf(solo.riley!, own.reportId)).at(-1)).toEqual({
      action: 'report.approved',
      payload: expect.objectContaining({
        basis: 'solo_self_attestation',
        selfAttested: true,
      }) as unknown,
    });
  });

  it('never lets anyone decide their own in a team, and lets an owner or finance admin decide in the approver’s place', async () => {
    const t = await team('approval-own', [
      ['alex', 'member'],
      ['casey', 'approver'],
      ['fin', 'finance_admin'],
    ]);
    const own = await closedReport(t.riley!);
    expect(await submit(t.riley!, own.reportId)).toMatchObject({
      approverMemberId: t.casey!.memberId,
    });
    expect(await decide(t.riley!, own.reportId, { kind: 'approve' })).toEqual({
      status: 'self_approval',
    });
    expect(await decide(t.alex!, own.reportId, { kind: 'approve' })).toEqual({ status: 'missing' });
    expect(await decide(t.fin!, own.reportId, { kind: 'approve' })).toEqual({
      status: 'approved',
      basis: 'separation_of_duties',
    });
    const approval = await withMember(app.db, t.riley!, (tx) => approvalOf(tx, own.reportId));
    expect(approval.steps).toEqual([
      expect.objectContaining({ decision: 'approved', approverMemberId: t.fin!.memberId }),
    ]);
  });
});

describe('returning a report (FR-GOV-10 to FR-GOV-12)', () => {
  it('returns the whole report for one rejected expense, each rejection kept with why, and opens it again', async () => {
    const t = await team('approval-return', [
      ['alex', 'member'],
      ['casey', 'approver'],
    ]);
    const work = await closedReport(t.alex!);
    await submit(t.alex!, work.reportId);
    const judge = judged({ [work.coffee]: DIFFERS });
    expect(await decide(t.casey!, work.reportId, { kind: 'approve' }, { judge })).toEqual({
      status: 'rejected',
      differences: [
        { expenseId: work.coffee, check: DIFFERS, reason: 'Its date isn’t its receipt’s.' },
      ],
    });
    expect(
      await decide(t.casey!, work.reportId, { kind: 'return', comment: ' ', rejections: [] }),
    ).toEqual({ status: 'invalid', message: 'Say why it goes back, for its member to read.' });
    expect(
      await decide(
        t.casey!,
        work.reportId,
        {
          kind: 'return',
          comment: 'Two things to fix, then send it again',
          rejections: [{ expenseId: work.lunch, reason: 'A lunch alone isn’t a business meal' }],
        },
        { secondFactor: false, judge },
      ),
    ).toEqual({ status: 'returned', basis: 'separation_of_duties', rejected: 2 });

    const after = await statusOf(t.alex!, work.reportId);
    expect(after.report).toMatchObject({ status: 'open', closedAt: null });
    expect(after.report.closesAt).toEqual(new Date('2026-10-20T00:00:00Z'));
    expect(after.expenses).toEqual(['ready', 'ready']);
    const back = await withMember(app.db, t.alex!, (tx) => returnedReports(tx, t.alex!.memberId));
    expect(back).toEqual([
      {
        reportId: work.reportId,
        step: expect.objectContaining({
          decision: 'returned',
          comment: 'Two things to fix, then send it again',
        }) as unknown,
        rejections: [
          expect.objectContaining({
            expenseId: work.coffee,
            reason: 'Its date isn’t its receipt’s.',
            automatic: true,
          }),
          expect.objectContaining({
            expenseId: work.lunch,
            reason: 'A lunch alone isn’t a business meal',
            automatic: false,
          }),
        ],
      },
    ]);
    expect((await actionsOf(t.alex!, work.reportId)).at(-1)?.action).toBe('report.returned');

    // Fixed and submitted again, it goes back to its approver, and its rejections stay history.
    await withOrg(app.db, t.alex!.orgId, (tx) =>
      tx
        .update(reports)
        .set({ status: 'closed', closedAt: NOW })
        .where(eq(reports.id, work.reportId)),
    );
    expect(await submit(t.alex!, work.reportId)).toMatchObject({ status: 'submitted' });
    const approval = await withMember(app.db, t.alex!, (tx) => approvalOf(tx, work.reportId));
    expect(approval.steps.map((s) => [s.sequence, s.decision])).toEqual([
      [1, 'returned'],
      [2, 'pending'],
    ]);
    expect(approval.rejections).toEqual([]);
    expect(
      await withMember(app.db, t.alex!, (tx) => returnedReports(tx, t.alex!.memberId)),
    ).toEqual([]);
  });

  it('keeps a returned report that is emptied, and lets its member delete a rejected expense', async () => {
    const t = await team('approval-empty', [
      ['alex', 'member'],
      ['casey', 'approver'],
    ]);
    const work = await closedReport(t.alex!);
    await submit(t.alex!, work.reportId);
    await decide(t.casey!, work.reportId, {
      kind: 'return',
      comment: 'Not this month',
      rejections: [{ expenseId: work.coffee, reason: 'Claim it next month' }],
    });
    // Everything on it moves to another report; it stays, empty, with its history.
    const moved = await withMember(app.db, t.alex!, async (tx) => {
      const trip = await moveToReport(
        tx,
        t.alex!.orgId,
        { tripId: work.tripId },
        { newReport: true },
        t.alex!.userId,
      );
      if (trip.status !== 'moved') throw new Error(`the trip did not move: ${trip.status}`);
      return moveToReport(
        tx,
        t.alex!.orgId,
        { expenseId: work.lunch },
        { reportId: trip.reportId },
        t.alex!.userId,
      );
    });
    expect(moved).toMatchObject({ status: 'moved', dropped: null });
    await withOrg(app.db, t.alex!.orgId, (tx) => closeDueReports(tx, t.alex!.orgId, NOW));
    expect((await statusOf(t.alex!, work.reportId)).report.status).toBe('open');
    // The rejection goes with its expense, when its member deletes the receipt that proves it.
    await withMember(app.db, t.alex!, async (tx) => {
      const [receipt] = await tx
        .select({ id: receipts.id })
        .from(receipts)
        .where(eq(receipts.expenseId, work.coffee));
      await tx.execute(sql`select delete_receipt(${receipt!.id})`);
    });
    const left = await withOrg(app.db, t.alex!.orgId, (tx) =>
      tx.select().from(expenseRejections).where(eq(expenseRejections.expenseId, work.coffee)),
    );
    expect(left).toEqual([]);
  });
});

describe('a submitted claim stays as it went in (NFR-DAT-04, FR-EXP-03)', () => {
  it('keeps a submitted claim’s category and type names when they are renamed later', async () => {
    const t = await team('approval-names', [
      ['alex', 'member'],
      ['casey', 'approver'],
    ]);
    const work = await closedReport(t.alex!);
    await submit(t.alex!, work.reportId);
    await withOrg(app.db, t.alex!.orgId, (tx) =>
      tx
        .update(categories)
        .set({ name: 'Food and drink' })
        .where(eq(categories.id, work.categoryId)),
    );
    const shown = await withMember(app.db, t.alex!, async (tx) => ({
      exported: (await reportForExport(tx, work.reportId))!.expenses.map((e) => [
        e.category,
        e.parts?.map((p) => p.category) ?? null,
      ]),
      totals: (await reportCategories(tx, [work.reportId])).map((e) => [
        e.category,
        e.parts.map((p) => p.category),
      ]),
    }));
    expect(shown.exported).toEqual([
      ['Meals', null],
      ['Meals', ['Meals', 'Meals']],
    ]);
    expect(shown.totals).toEqual([
      ['Meals', []],
      ['Meals', ['Meals', 'Meals']],
    ]);
    // Returned, it can change again, and reads the names as they are now.
    await decide(t.casey!, work.reportId, {
      kind: 'return',
      comment: 'Check the coffee',
      rejections: [],
    });
    const again = await withMember(app.db, t.alex!, async (tx) =>
      (await reportForExport(tx, work.reportId))!.expenses.map((e) => e.category),
    );
    expect(again).toEqual(['Food and drink', 'Food and drink']);
  });

  it('locks an approved expense: an edit, a reason or a move to another trip is refused, by the database too', async () => {
    const t = await team('approval-lock', [
      ['alex', 'member'],
      ['casey', 'approver'],
    ]);
    const work = await closedReport(t.alex!);
    await submit(t.alex!, work.reportId);
    await decide(t.casey!, work.reportId, { kind: 'approve' });
    const asAlex = <T>(work: (tx: Transaction) => Promise<T>) => withMember(app.db, t.alex!, work);
    expect(
      await asAlex((tx) =>
        editExpense(tx, t.alex!.orgId, work.coffee, { amount: '1.00' }, t.alex!.userId),
      ),
    ).toMatchObject({ status: 'not_editable' });
    expect(
      await asAlex((tx) =>
        setClaimReason(tx, t.alex!.orgId, work.coffee, 'Tip left out', t.alex!.userId),
      ),
    ).toEqual({ status: 'not_editable' });
    expect(
      await asAlex((tx) =>
        setExpenseTrip(tx, t.alex!.orgId, work.lunch, { tripId: null }, t.alex!.userId),
      ),
    ).toMatchObject({ status: 'not_movable' });
    // The database holds it too, even for the system's own work.
    await expectDbError(
      withOrg(app.db, t.alex!.orgId, (tx) =>
        tx.update(expenses).set({ amountMinor: 1 }).where(eq(expenses.id, work.coffee)),
      ),
      /locked: expense .* is approved/,
    );
    await expectDbError(
      withOrg(app.db, t.alex!.orgId, (tx) =>
        tx.update(expenses).set({ status: 'ready' }).where(eq(expenses.id, work.coffee)),
      ),
      /locked/,
    );
  });

  it('files an expense dated in a submitted trip as local, and refuses to put one on it', async () => {
    const t = await team('approval-trip', [
      ['alex', 'member'],
      ['casey', 'approver'],
    ]);
    const work = await closedReport(t.alex!);
    await submit(t.alex!, work.reportId);
    const late = newId();
    const filed = await withMember(app.db, t.alex!, async (tx) => {
      await tx.insert(expenses).values({
        id: late,
        orgId: t.alex!.orgId,
        memberId: t.alex!.memberId,
        status: 'ready',
        source: 'manual',
        merchant: 'Late taxi',
        transactionDate: '2026-09-22',
        currency: 'USD',
        amountMinor: 1800,
      });
      await fileExpenseToTrip(tx, t.alex!.orgId, late, { type: 'user', id: t.alex!.userId });
      const [row] = await tx.select().from(expenses).where(eq(expenses.id, late));
      return row!.tripId;
    });
    expect(filed).toBeNull();
    expect(
      await withMember(app.db, t.alex!, (tx) =>
        setExpenseTrip(tx, t.alex!.orgId, late, { tripId: work.tripId }, t.alex!.userId),
      ),
    ).toEqual({ status: 'trip_submitted' });
  });
});

describe('claiming less than a receipt (FR-EXP-10)', () => {
  it('keeps the reason for claiming less, reopening a closed report, and refuses one too long', async () => {
    const t = await team('approval-reason', [['alex', 'member']]);
    const work = await closedReport(t.alex!);
    const asAlex = <T>(work: (tx: Transaction) => Promise<T>) => withMember(app.db, t.alex!, work);
    expect(
      await asAlex((tx) =>
        setClaimReason(tx, t.alex!.orgId, work.coffee, '  The pastry was mine ', t.alex!.userId),
      ),
    ).toEqual({ status: 'saved', reason: 'The pastry was mine' });
    expect((await statusOf(t.alex!, work.reportId)).report.status).toBe('open');
    expect(
      await asAlex((tx) =>
        setClaimReason(tx, t.alex!.orgId, work.coffee, 'x'.repeat(501), t.alex!.userId),
      ),
    ).toEqual({ status: 'invalid', message: 'A reason is at most 500 characters.' });
    expect(
      await asAlex((tx) => setClaimReason(tx, t.alex!.orgId, work.coffee, '', t.alex!.userId)),
    ).toEqual({ status: 'saved', reason: null });
    const events = (await actionsOf(t.alex!, work.coffee)).map((e) => e.action);
    expect(events).toEqual(['expense.claim_reason_set', 'expense.claim_reason_set']);
    // Only its own member gives it a reason.
    await expectDbError(
      withMember(app.db, t.riley!, (tx) =>
        setClaimReason(tx, t.riley!.orgId, work.coffee, 'Not mine to say', t.riley!.userId),
      ),
      /own_records/,
    );
  });
});
