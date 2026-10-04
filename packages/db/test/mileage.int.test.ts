import { mileageRate, newId, type MileageRateTable } from '@expensewise/domain';
import { and, asc, eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { withOrg } from '../src/client.ts';
import { editExpense, getExpense, listExpenses } from '../src/expenses.ts';
import { editMileage, getMileage, logMileage } from '../src/mileage.ts';
import { closeReport, getReport, joinDueItems, justifyExpense } from '../src/reports.ts';
import { auditEvents, expenses, members, mileageLogs } from '../src/schema.ts';
import { createTrip, tallyTrips } from '../src/trips.ts';
import { connectAs, seedOrg } from './helpers.ts';

const app = connectAs('app');
afterAll(async () => {
  await app.pool.end();
});

const TODAY = '2026-10-04';
const houston = { name: 'Houston · Acme onsite', startDate: '2026-09-22', endDate: '2026-09-25' };
const toAirport = {
  date: '2026-09-22',
  destination: 'IAH, George Bush Intercontinental',
  purpose: 'Drive to the airport for the Acme onsite',
  miles: '38.4',
};

/** A table of one org-policy rate, standing in for a rate change after a drive was logged. */
const policy = (perUnit: string): MileageRateTable => ({
  rates: [
    mileageRate({
      currency: 'USD',
      perUnit,
      unit: 'mi',
      effectiveFrom: '2026-01-01',
      source: 'org-policy',
    }),
  ],
  through: '2026-12-31',
});

async function workspace(name: string) {
  const org = await seedOrg(app.db, name);
  const inOrg = <T>(work: Parameters<typeof withOrg<T>>[2]) => withOrg(app.db, org.orgId, work);
  const log = async (
    input: Partial<typeof toAirport> = {},
    { memberId = org.memberId, rates }: { memberId?: string; rates?: MileageRateTable } = {},
  ) => {
    const logged = await inOrg((tx) =>
      logMileage(tx, org.orgId, memberId, { ...toAirport, ...input }, org.userId, TODAY, rates),
    );
    if (logged.status !== 'logged') throw new Error(`expected a drive, got ${logged.status}`);
    return logged.expenseId;
  };
  const edit = (
    id: string,
    input: Parameters<typeof editMileage>[4],
    { memberId = org.memberId, rates }: { memberId?: string; rates?: MileageRateTable } = {},
  ) => inOrg((tx) => editMileage(tx, org.orgId, memberId, id, input, org.userId, TODAY, rates));
  const mileage = (id: string, memberId = org.memberId) =>
    inOrg((tx) => getMileage(tx, memberId, id));
  const expense = (id: string) => inOrg((tx) => getExpense(tx, id));
  const trip = async (input: typeof houston) => {
    const made = await inOrg((tx) => createTrip(tx, org.orgId, org.memberId, input, org.userId));
    if (made.status !== 'saved') throw new Error(`expected a trip, got ${made.status}`);
    return made.tripId;
  };
  const audit = (entityId: string) =>
    inOrg((tx) =>
      tx
        .select({ action: auditEvents.action, payload: auditEvents.payload })
        .from(auditEvents)
        .where(and(eq(auditEvents.entityId, entityId), eq(auditEvents.entityType, 'expense')))
        .orderBy(asc(auditEvents.sequence)),
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
  return { org, inOrg, log, edit, mileage, expense, trip, audit, colleague };
}

describe('logging a drive (FR-CAP-03, ADR-0038)', () => {
  it('logs a drive as a Ready expense of miles times the rate on the day, with the rate copied on', async () => {
    const w = await workspace('mileage-log');
    const id = await w.log();

    expect(await w.expense(id)).toMatchObject({
      status: 'ready',
      source: 'mileage',
      merchant: toAirport.destination,
      transactionDate: '2026-09-22',
      // 38.4 mi × $0.725
      amountMinor: 2784,
      currency: 'USD',
      justification: toAirport.purpose,
      receiptId: null,
    });
    expect(await w.mileage(id)).toMatchObject({
      expenseId: id,
      method: 'manual',
      date: '2026-09-22',
      destination: toAirport.destination,
      purpose: toAirport.purpose,
      miles: '38.4',
      unit: 'mi',
      amountMinor: 2784,
      rate: {
        currency: 'USD',
        perUnit: '0.7250',
        unit: 'mi',
        effectiveFrom: '2026-01-01',
        source: 'irs-business',
      },
    });
    const [created] = await w.audit(id);
    expect(created).toMatchObject({
      action: 'expense.created',
      payload: {
        source: 'mileage',
        status: 'ready',
        miles: '38.4',
        rate: { perUnit: '0.725', effectiveFrom: '2026-01-01', source: 'irs-business' },
        amountMinor: 2784,
        currency: 'USD',
      },
    });
  });

  it('refuses a drive that is not valid, and records nothing', async () => {
    const w = await workspace('mileage-invalid');
    const result = await w.inOrg((tx) =>
      logMileage(
        tx,
        w.org.orgId,
        w.org.memberId,
        { ...toAirport, miles: '0' },
        w.org.userId,
        TODAY,
      ),
    );
    expect(result).toEqual({
      status: 'invalid',
      problem: { field: 'miles', message: 'Enter more than zero miles.' },
    });
    expect(await w.inOrg((tx) => tx.select().from(expenses))).toEqual([]);
    expect(await w.inOrg((tx) => tx.select().from(auditEvents))).toEqual([]);
  });

  it('keeps the rate it was logged at when the rates change later', async () => {
    const w = await workspace('mileage-snapshot');
    const id = await w.log({}, { rates: policy('0.70') });
    // The rates change: 80 cents a mile from the same day.
    const renamed = await w.edit(id, { destination: 'Hobby Airport' }, { rates: policy('0.80') });
    expect(renamed).toMatchObject({ status: 'edited', repriced: false });
    expect((await w.mileage(id))?.rate).toMatchObject({ perUnit: '0.7000', source: 'org-policy' });
    expect((await w.expense(id))?.amountMinor).toBe(2688);
  });
});

describe('a drive is an expense like any other', () => {
  it('files a drive to the trip its date falls in, and counts it in the trip’s totals', async () => {
    const w = await workspace('mileage-trip');
    const tripId = await w.trip(houston);
    const id = await w.log();

    expect((await w.expense(id))?.tripId).toBe(tripId);
    expect(await w.inOrg((tx) => tallyTrips(tx, [tripId]))).toEqual([
      { tripId, status: 'ready', currency: 'USD', count: 1, amountMinor: 2784 },
    ]);
    const listed = await w.inOrg((tx) => listExpenses(tx, 10));
    expect(listed.map((e) => [e.id, e.source])).toEqual([[id, 'mileage']]);
  });

  it('joins its trip’s report, and a local drive joins one with its purpose as its reason', async () => {
    const w = await workspace('mileage-report');
    const tripId = await w.trip(houston);
    const onTrip = await w.log();
    const local = await w.log({ date: '2026-09-28', destination: 'Client office', miles: '12.3' });

    const joined = await w.inOrg((tx) =>
      joinDueItems(tx, w.org.orgId, new Date('2026-10-01T12:00:00Z')),
    );
    expect(joined).toEqual({ trips: 1, expenses: 1, opened: 1 });
    const { reportId } = (await w.expense(local))!;
    expect(reportId).not.toBeNull();
    const report = (await w.inOrg((tx) => getReport(tx, reportId!)))!;
    expect(report.trips.map((t) => t.id)).toEqual([tripId]);
    expect(report.tallies).toEqual([
      { tripId, status: 'ready', currency: 'USD', count: 1, amountMinor: 2784 },
    ]);
    // 12.3 mi × $0.725 = $8.9175, rounded half-up to $8.92
    expect(report.locals.map((e) => [e.id, e.amountMinor, e.justification])).toEqual([
      [local, 892, toAirport.purpose],
    ]);
    expect((await w.expense(onTrip))?.tripReportId).toBe(reportId);
    // Its purpose is its reason, so nothing holds the report open.
    expect(await w.inOrg((tx) => closeReport(tx, w.org.orgId, reportId!, w.org.userId))).toEqual({
      status: 'closed',
    });
  });
});

describe('correcting a drive before it is submitted', () => {
  it('prices it again at the rate on its new date or for its new miles, and files it again by date', async () => {
    const w = await workspace('mileage-edit');
    const tripId = await w.trip(houston);
    const id = await w.log();

    const moved = await w.edit(id, { date: '2025-12-30' });
    expect(moved).toEqual({
      status: 'edited',
      changes: [{ field: 'date', from: '2026-09-22', to: '2025-12-30' }],
      repriced: true,
    });
    // 38.4 mi × $0.70, the rate in force on its new date, and off the trip.
    expect(await w.expense(id)).toMatchObject({ amountMinor: 2688, tripId: null });
    expect((await w.mileage(id))?.rate).toMatchObject({
      perUnit: '0.7000',
      effectiveFrom: '2025-01-01',
    });

    await w.edit(id, { date: '2026-09-23', miles: '40' });
    expect(await w.expense(id)).toMatchObject({ amountMinor: 2900, tripId });
    expect(await w.edit(id, { miles: '40.00' })).toEqual({ status: 'unchanged' });

    const edits = (await w.audit(id)).filter((e) => e.action === 'expense.edited');
    expect(edits.map((e) => e.payload)).toEqual([
      expect.objectContaining({ amountMinor: 2688, previousAmountMinor: 2784 }),
      expect.objectContaining({ amountMinor: 2900, previousAmountMinor: 2688 }),
    ]);
  });

  it('refuses a change once it is submitted, and refuses editing it as an ordinary expense', async () => {
    const w = await workspace('mileage-locked');
    const id = await w.log();

    expect(await w.inOrg((tx) => editExpense(tx, w.org.orgId, id, { amount: '99' }, 'u'))).toEqual({
      status: 'mileage',
    });
    for (const status of ['submitted', 'approved'] as const) {
      await w.inOrg((tx) => tx.update(expenses).set({ status }).where(eq(expenses.id, id)));
      expect(await w.edit(id, { miles: '50' })).toEqual({
        status: 'not_editable',
        current: status,
      });
    }
    expect((await w.expense(id))?.amountMinor).toBe(2784);
  });

  it('changes its business purpose when its reason changes on its report, and never clears it', async () => {
    const w = await workspace('mileage-reason');
    const id = await w.log({ date: '2026-09-28' });
    const justify = (text: string) =>
      w.inOrg((tx) => justifyExpense(tx, w.org.orgId, id, text, w.org.userId));

    expect(await justify('Client workshop at Acme')).toEqual({
      status: 'justified',
      justification: 'Client workshop at Acme',
    });
    expect((await w.mileage(id))?.purpose).toBe('Client workshop at Acme');
    expect(await justify('  ')).toMatchObject({ status: 'invalid' });
    expect((await w.expense(id))?.justification).toBe('Client workshop at Acme');
  });
});

describe('a member’s drives are their own', () => {
  it('finds no other member’s drive, to open or to change', async () => {
    const w = await workspace('mileage-members');
    const jordan = await w.colleague();
    const theirs = await w.log({}, { memberId: jordan });

    expect(await w.mileage(theirs)).toBeUndefined();
    expect(await w.edit(theirs, { miles: '1' })).toEqual({ status: 'missing' });
    expect((await w.mileage(theirs, jordan))?.miles).toBe('38.4');
  });

  it('keeps drives inside their organization', async () => {
    const w = await workspace('mileage-tenant-a');
    const other = await workspace('mileage-tenant-b');
    const id = await w.log();

    expect(await other.inOrg((tx) => tx.select().from(mileageLogs))).toEqual([]);
    expect(await other.mileage(id, w.org.memberId)).toBeUndefined();
  });
});
