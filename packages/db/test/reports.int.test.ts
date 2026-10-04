import { newId, type ExpenseStatus } from '@expensewise/domain';
import { asc, eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { withOrg } from '../src/client.ts';
import { editExpense } from '../src/expenses.ts';
import {
  closeDueReports,
  closeReport,
  getReport,
  joinDueItems,
  justifyExpense,
  listReports,
  moveToReport,
  reopenReport,
  reportItems,
  reportWorkDue,
  runReportSchedule,
} from '../src/reports.ts';
import { auditEvents, expenses, members, reports, trips } from '../src/schema.ts';
import { createTrip, fileExpenseToTrip } from '../src/trips.ts';
import { connectAs, expectDbError, seedOrg } from './helpers.ts';

const app = connectAs('app');
afterAll(async () => {
  await app.pool.end();
});

const houston = { name: 'Houston', startDate: '2026-09-22', endDate: '2026-09-25' };
const omaha = { name: 'Omaha', startDate: '2026-09-29', endDate: '2026-10-01' };
/** Houston’s return day, 25 Sep, has ended everywhere by 26 Sep 12:00 UTC; a day later it joins. */
const HOUSTON_JOINS = new Date('2026-09-27T12:00:00Z');
const at = (iso: string) => new Date(iso);

async function workspace(name: string) {
  const org = await seedOrg(app.db, name);
  const inOrg = <T>(work: Parameters<typeof withOrg<T>>[2]) => withOrg(app.db, org.orgId, work);
  const actor = { type: 'user', id: org.userId } as const;
  const trip = async (input: Parameters<typeof createTrip>[3], memberId = org.memberId) => {
    const made = await inOrg((tx) => createTrip(tx, org.orgId, memberId, input, org.userId));
    if (made.status !== 'saved') throw new Error(`expected a trip, got ${made.status}`);
    return made.tripId;
  };
  const expense = (
    date: string | null,
    over: { status?: ExpenseStatus; amountMinor?: number; memberId?: string } = {},
  ) =>
    inOrg(async (tx) => {
      const id = newId();
      await tx.insert(expenses).values({
        id,
        orgId: org.orgId,
        memberId: over.memberId ?? org.memberId,
        status: over.status ?? 'ready',
        source: 'manual',
        merchant: 'Uber',
        transactionDate: date,
        currency: 'USD',
        amountMinor: over.amountMinor ?? 3145,
      });
      await fileExpenseToTrip(tx, org.orgId, id, actor);
      return id;
    });
  const run = (now: Date) => runReportSchedule(app.db, org.orgId, now);
  const report = (id: string) => inOrg((tx) => getReport(tx, id));
  const reportOfTrip = async (tripId: string) =>
    (await inOrg((tx) => tx.select().from(trips).where(eq(trips.id, tripId))))[0]?.reportId ?? null;
  const reportOfExpense = async (id: string) =>
    (await inOrg((tx) => tx.select().from(expenses).where(eq(expenses.id, id))))[0]?.reportId ??
    null;
  const actions = (entityId: string) =>
    inOrg(async (tx) =>
      (
        await tx
          .select({ action: auditEvents.action })
          .from(auditEvents)
          .where(eq(auditEvents.entityId, entityId))
          .orderBy(asc(auditEvents.sequence))
      ).map((e) => e.action),
    );
  const colleague = async () => {
    const id = newId();
    await inOrg((tx) =>
      tx.insert(members).values({
        id,
        orgId: org.orgId,
        userId: `user_${id}`,
        email: `${id}@example.com`,
        displayName: 'Jordan',
        role: 'member',
      }),
    );
    return id;
  };
  return {
    org,
    inOrg,
    trip,
    expense,
    run,
    report,
    reportOfTrip,
    reportOfExpense,
    actions,
    colleague,
  };
}

describe('trips and local expenses joining a report (FR-EXP-05, FR-EXP-14)', () => {
  it('puts a trip on a new report 24 hours after its return day, not before', async () => {
    const w = await workspace('rep-join');
    const h = await w.trip(houston);
    const onTrip = await w.expense('2026-09-23');
    const empty = await w.trip({ name: 'Denver', startDate: '2026-09-10', endDate: '2026-09-12' });

    expect(await w.run(at('2026-09-27T11:59:59Z'))).toMatchObject({
      joined: { trips: 0, expenses: 0, opened: 0 },
    });
    expect(await w.reportOfTrip(h)).toBeNull();

    expect((await w.run(HOUSTON_JOINS)).joined).toEqual({ trips: 1, expenses: 0, opened: 1 });
    const reportId = await w.reportOfTrip(h);
    expect(reportId).not.toBeNull();
    // A trip with nothing on it waits until something is.
    expect(await w.reportOfTrip(empty)).toBeNull();
    // An expense on a trip goes with the trip, never on the report itself.
    expect(await w.reportOfExpense(onTrip)).toBeNull();

    const contents = await w.report(reportId!);
    expect(contents?.report).toMatchObject({
      status: 'open',
      currency: 'USD',
      closesAt: at('2026-10-25T12:00:00Z'),
      closedAt: null,
    });
    expect(contents?.trips.map((t) => t.id)).toEqual([h]);
    expect(reportItems(contents!)).toEqual([{ id: h, ready: true }]);
    expect(await w.actions(reportId!)).toEqual(['report.opened', 'report.trip_added']);

    // Nothing joins twice.
    expect((await w.run(at('2026-10-01T00:00:00Z'))).joined).toEqual({
      trips: 0,
      expenses: 0,
      opened: 0,
    });
  });

  it('puts later trips and local expenses on the report already open', async () => {
    const w = await workspace('rep-later');
    const h = await w.trip(houston);
    await w.expense('2026-09-23');
    await w.run(HOUSTON_JOINS);
    const reportId = await w.reportOfTrip(h);

    const o = await w.trip(omaha);
    await w.expense('2026-09-30');
    const lunch = await w.expense('2026-10-02');
    const tooSoon = await w.expense('2026-10-03');
    const undated = await w.expense(null, { status: 'needs_review' });

    expect((await w.run(at('2026-10-04T12:00:00Z'))).joined).toEqual({
      trips: 1,
      expenses: 1,
      opened: 0,
    });
    expect(await w.reportOfTrip(o)).toBe(reportId);
    expect(await w.reportOfExpense(lunch)).toBe(reportId);
    expect(await w.reportOfExpense(tooSoon)).toBeNull();
    expect(await w.reportOfExpense(undated)).toBeNull();
  });

  it('tells the schedule which organizations have work due, and no more than their ids', async () => {
    const w = await workspace('rep-due');
    const h = await w.trip(houston);
    await w.expense('2026-09-23');
    expect(await reportWorkDue(app.db, at('2026-09-27T11:59:59Z'))).not.toContain(w.org.orgId);
    expect(await reportWorkDue(app.db, HOUSTON_JOINS)).toContain(w.org.orgId);
    await w.run(HOUSTON_JOINS);
    expect(await reportWorkDue(app.db, at('2026-10-01T00:00:00Z'))).not.toContain(w.org.orgId);
    // Day 28 is work again.
    expect(await reportWorkDue(app.db, at('2026-10-25T12:00:00Z'))).toContain(w.org.orgId);
    expect(await w.reportOfTrip(h)).not.toBeNull();
    // Outside withOrg the app sees no report itself.
    expect(await app.db.select().from(reports)).toEqual([]);
  });
});

describe('closing and reopening a report (FR-EXP-12)', () => {
  it('refuses while anything needs review or a justification, then closes', async () => {
    const w = await workspace('rep-close');
    const h = await w.trip(houston);
    const unsure = await w.expense('2026-09-23', { status: 'needs_review' });
    const lunch = await w.expense('2026-09-27');
    await w.run(at('2026-09-29T12:00:00Z'));
    const reportId = (await w.reportOfTrip(h))!;
    expect(await w.reportOfExpense(lunch)).toBe(reportId);

    const close = () =>
      w.inOrg((tx) => closeReport(tx, w.org.orgId, reportId, w.org.userId, at('2026-10-01')));
    expect(await close()).toEqual({ status: 'needs_attention', blocking: [h, lunch] });

    await w.inOrg((tx) =>
      editExpense(tx, w.org.orgId, unsure, { merchant: 'Uber Technologies' }, w.org.userId),
    );
    expect(
      await w.inOrg((tx) =>
        justifyExpense(tx, w.org.orgId, lunch, '  Lunch with the Acme team  ', w.org.userId),
      ),
    ).toEqual({ status: 'justified', justification: 'Lunch with the Acme team' });
    expect(await close()).toEqual({ status: 'closed' });
    expect((await w.report(reportId))?.report).toMatchObject({
      status: 'closed',
      closedAt: at('2026-10-01'),
    });
    expect(await close()).toEqual({ status: 'not_open', current: 'closed' });

    const reopened = await w.inOrg((tx) =>
      reopenReport(tx, w.org.orgId, reportId, w.org.userId, at('2026-10-25T00:00:00Z')),
    );
    // Its day 28 was 27 Oct; reopened on 25 Oct it gets a week.
    expect(reopened).toEqual({ status: 'reopened', closesAt: at('2026-11-01T00:00:00Z') });
    expect(await w.actions(reportId)).toEqual([
      'report.opened',
      'report.trip_added',
      'report.expense_added',
      'report.closed',
      'report.reopened',
    ]);
  });

  it('reopens a closed report when something on it changes', async () => {
    const w = await workspace('rep-touch');
    const h = await w.trip(houston);
    const ride = await w.expense('2026-09-23');
    await w.run(HOUSTON_JOINS);
    const reportId = (await w.reportOfTrip(h))!;
    await w.inOrg((tx) => closeReport(tx, w.org.orgId, reportId, w.org.userId));

    await w.inOrg((tx) => editExpense(tx, w.org.orgId, ride, { amount: '41.45' }, w.org.userId));
    expect((await w.report(reportId))?.report.status).toBe('open');
    expect((await w.actions(reportId)).at(-1)).toBe('report.reopened');
  });

  it('refuses a justification on a trip’s expense, or one too long', async () => {
    const w = await workspace('rep-justify');
    await w.trip(houston);
    const ride = await w.expense('2026-09-23');
    const lunch = await w.expense('2026-09-27');
    const justify = (id: string, text: string) =>
      w.inOrg((tx) => justifyExpense(tx, w.org.orgId, id, text, w.org.userId));
    expect(await justify(ride, 'Client visit')).toEqual({ status: 'not_local' });
    expect(await justify(lunch, 'x'.repeat(501))).toMatchObject({ status: 'invalid' });
    expect(await justify(lunch, 'Client lunch')).toMatchObject({ status: 'justified' });
    expect(await justify(lunch, 'Client lunch')).toEqual({ status: 'unchanged' });
  });
});

describe('day 28 (FR-EXP-12, Q20)', () => {
  it('closes with what is ready and moves what still needs review to the next report', async () => {
    const w = await workspace('rep-day28');
    const h = await w.trip(houston);
    await w.expense('2026-09-23');
    const o = await w.trip(omaha);
    await w.expense('2026-09-30', { status: 'needs_review' });
    await w.run(at('2026-10-03T12:00:00Z'));
    const first = (await w.reportOfTrip(h))!;
    expect(await w.reportOfTrip(o)).toBe(first);

    const result = await w.run(at('2026-10-31T12:00:00Z'));
    expect(result.closed).toEqual({ closed: 1, moved: 1, dropped: 0 });
    expect((await w.report(first))?.report.status).toBe('closed');
    const next = (await w.reportOfTrip(o))!;
    expect(next).not.toBe(first);
    expect((await w.report(next))?.report).toMatchObject({
      status: 'open',
      closesAt: at('2026-11-28T12:00:00Z'),
    });
  });

  it('leaves a report with nothing ready open, overdue, and drops one holding nothing', async () => {
    const w = await workspace('rep-overdue');
    const h = await w.trip(houston);
    const unsure = await w.expense('2026-09-23', { status: 'needs_review' });
    await w.run(HOUSTON_JOINS);
    const reportId = (await w.reportOfTrip(h))!;
    await w.run(at('2026-11-01T00:00:00Z'));
    expect((await w.report(reportId))?.report.status).toBe('open');

    // Its only expense moves off the trip: nothing is left to claim, so the report is dropped
    // and the empty trip comes off it, to join again once something is on it.
    await w.inOrg((tx) =>
      editExpense(tx, w.org.orgId, unsure, { date: '2026-08-01' }, w.org.userId),
    );
    expect(await reportWorkDue(app.db, at('2026-11-01T01:00:00Z'))).toContain(w.org.orgId);
    const swept = await w.inOrg((tx) =>
      closeDueReports(tx, w.org.orgId, at('2026-11-01T01:00:00Z')),
    );
    expect(swept.dropped).toBe(1);
    expect(await w.reportOfTrip(h)).toBeNull();
    expect(await w.report(reportId)).toBeUndefined();
  });
});

describe('moving trips and local expenses between reports (FR-EXP-05)', () => {
  it('moves a trip to a new report, dropping the one it leaves empty', async () => {
    const w = await workspace('rep-move');
    const h = await w.trip(houston);
    await w.expense('2026-09-23');
    await w.run(HOUSTON_JOINS);
    const first = (await w.reportOfTrip(h))!;

    const moved = await w.inOrg((tx) =>
      moveToReport(tx, w.org.orgId, { tripId: h }, { newReport: true }, w.org.userId),
    );
    expect(moved).toMatchObject({ status: 'moved', dropped: first });
    expect(await w.reportOfTrip(h)).toBe(moved.status === 'moved' ? moved.reportId : null);
    expect(await w.report(first)).toBeUndefined();
  });

  it('moves a local expense, and refuses a closed report, a trip’s expense or another member’s', async () => {
    const w = await workspace('rep-move-refuse');
    const h = await w.trip(houston);
    const ride = await w.expense('2026-09-23');
    const lunch = await w.expense('2026-09-27');
    await w.run(at('2026-09-29T12:00:00Z'));
    const first = (await w.reportOfTrip(h))!;
    const move = (
      item: Parameters<typeof moveToReport>[2],
      choice: Parameters<typeof moveToReport>[3],
    ) => w.inOrg((tx) => moveToReport(tx, w.org.orgId, item, choice, w.org.userId));

    expect(await move({ expenseId: ride }, { newReport: true })).toEqual({ status: 'not_local' });
    const second = await move({ expenseId: lunch }, { newReport: true });
    expect(second).toMatchObject({ status: 'moved', dropped: null });
    const secondId = second.status === 'moved' ? second.reportId : '';
    expect(await move({ expenseId: lunch }, { reportId: secondId })).toEqual({
      status: 'unchanged',
    });

    await w.inOrg((tx) => justifyExpense(tx, w.org.orgId, lunch, 'Client lunch', w.org.userId));
    await w.inOrg((tx) => closeReport(tx, w.org.orgId, secondId, w.org.userId));
    expect(await move({ tripId: h }, { reportId: secondId })).toEqual({ status: 'not_open' });
    expect(await move({ expenseId: lunch }, { reportId: first })).toEqual({ status: 'not_open' });

    const theirTrip = await w.trip(omaha, await w.colleague());
    expect(await move({ tripId: theirTrip }, { reportId: first })).toEqual({
      status: 'other_member',
    });
  });

  it('holds only its member’s trips and expenses, and a closed time only when closed', async () => {
    const w = await workspace('rep-constraints');
    const h = await w.trip(houston);
    await w.expense('2026-09-23');
    await w.run(HOUSTON_JOINS);
    const reportId = (await w.reportOfTrip(h))!;
    const theirs = await w.trip(omaha, await w.colleague());
    await expectDbError(
      w.inOrg((tx) => tx.update(trips).set({ reportId }).where(eq(trips.id, theirs))),
      /trips_report_fk/,
    );
    const ride = await w.expense('2026-09-23');
    await expectDbError(
      w.inOrg((tx) => tx.update(expenses).set({ reportId }).where(eq(expenses.id, ride))),
      /expenses_report_only_when_local/,
    );
    await expectDbError(
      w.inOrg((tx) => tx.update(reports).set({ status: 'closed' }).where(eq(reports.id, reportId))),
      /reports_closed_when_closed/,
    );
  });

  it('lists a member’s reports newest first', async () => {
    const w = await workspace('rep-list');
    const h = await w.trip(houston);
    await w.expense('2026-09-23');
    await w.run(HOUSTON_JOINS);
    const listed = await w.inOrg((tx) => listReports(tx, 10, { memberId: w.org.memberId }));
    expect(listed.map((r) => r.report.id)).toEqual([await w.reportOfTrip(h)]);
    expect(listed[0]?.tallies).toMatchObject([{ tripId: h, count: 1, amountMinor: 3145 }]);
    expect(await w.inOrg((tx) => joinDueItems(tx, w.org.orgId, at('2026-12-01')))).toEqual({
      trips: 0,
      expenses: 0,
      opened: 0,
    });
  });
});
