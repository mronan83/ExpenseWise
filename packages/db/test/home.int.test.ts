import { newId, type ExpenseStatus } from '@expensewise/domain';
import { afterAll, describe, expect, it } from 'vitest';
import { withOrg } from '../src/client.ts';
import { homeSnapshot, monthOf } from '../src/home.ts';
import { logMileage } from '../src/mileage.ts';
import {
  claimMilesForRoute,
  logRouteMileage,
  recordRouteMeasurement,
} from '../src/mileage-routes.ts';
import { fileReceipt } from '../src/receipts.ts';
import { expenses, members } from '../src/schema.ts';
import { createTrip, fileExpenseToTrip } from '../src/trips.ts';
import { connectAs, seedOrg } from './helpers.ts';

const app = connectAs('app');
afterAll(async () => {
  await app.pool.end();
});

/** A fresh organization, with helpers to make trips, expenses and receipts in it. */
async function workspace(name: string) {
  const org = await seedOrg(app.db, name);
  const inOrg = <T>(work: Parameters<typeof withOrg<T>>[2]) => withOrg(app.db, org.orgId, work);
  const actor = { type: 'user', id: org.userId } as const;
  const trip = async (startDate: string, endDate: string, memberId = org.memberId) => {
    const made = await inOrg((tx) =>
      createTrip(
        tx,
        org.orgId,
        memberId,
        { name: `${startDate} trip`, startDate, endDate },
        org.userId,
      ),
    );
    if (made.status !== 'saved') throw new Error(`expected a trip, got ${made.status}`);
    return made.tripId;
  };
  const expense = (
    date: string,
    over: {
      amountMinor?: number;
      currency?: string;
      status?: ExpenseStatus;
      memberId?: string;
    } = {},
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
        currency: over.currency ?? 'USD',
        amountMinor: over.amountMinor ?? 1000,
      });
      await fileExpenseToTrip(tx, org.orgId, id, actor);
      return id;
    });
  const colleague = async () => {
    const id = newId();
    await inOrg((tx) =>
      tx.insert(members).values({
        id,
        orgId: org.orgId,
        userId: `user_${id}`,
        email: `${id}@example.com`,
        displayName: 'Casey',
        role: 'member',
      }),
    );
    return id;
  };
  const snapshot = (day: string, memberId = org.memberId) =>
    inOrg((tx) => homeSnapshot(tx, memberId, day));
  return { org, inOrg, trip, expense, colleague, snapshot };
}

describe('monthOf', () => {
  it('gives the first day of the month and of the next, across a year end', () => {
    expect(monthOf('2026-10-03')).toEqual({ from: '2026-10-01', until: '2026-11-01' });
    expect(monthOf('2026-12-31')).toEqual({ from: '2026-12-01', until: '2027-01-01' });
  });
});

describe('what Home shows', () => {
  it('finds the trip under way, or else the next within two weeks', async () => {
    const w = await workspace('home-trips');
    const austin = await w.trip('2026-10-02', '2026-10-04');
    const chicago = await w.trip('2026-10-20', '2026-10-23');
    await w.trip('2026-12-01', '2026-12-03');

    const during = await w.snapshot('2026-10-03');
    expect(during.tripNow?.id).toBe(austin);
    expect(during.tripNext).toBeNull();

    // Oct 6: Chicago is 14 days off, so it is next; on Oct 5 it is 15 and isn't.
    expect((await w.snapshot('2026-10-06')).tripNext?.id).toBe(chicago);
    expect((await w.snapshot('2026-10-05')).tripNext).toBeNull();
    expect((await w.snapshot('2026-10-05')).tripNow).toBeNull();
  });

  it('lists the last three trips to end before the day, with what is on them', async () => {
    const w = await workspace('home-recent');
    const trips: string[] = [];
    for (const [from, to] of [
      ['2026-08-03', '2026-08-05'],
      ['2026-09-01', '2026-09-02'],
      ['2026-09-14', '2026-09-18'],
      ['2026-09-22', '2026-09-25'],
    ] as const) {
      trips.push(await w.trip(from, to));
    }
    await w.expense('2026-09-23', { amountMinor: 4250 });
    await w.expense('2026-09-24', { amountMinor: 1800, status: 'needs_review' });

    const home = await w.snapshot('2026-10-03');
    expect(home.recentTrips.map((t) => t.id)).toEqual([trips[3], trips[2], trips[1]]);
    const houston = home.tallies.filter((t) => t.tripId === trips[3]);
    expect(houston.map((t) => [t.status, t.count, t.amountMinor]).sort()).toEqual([
      ['needs_review', 1, 1800],
      ['ready', 1, 4250],
    ]);
  });

  it('tallies this month’s expenses by status, currency and whether on a trip', async () => {
    const w = await workspace('home-month');
    await w.trip('2026-10-02', '2026-10-04');
    await w.expense('2026-10-03', { amountMinor: 41_280 });
    await w.expense('2026-10-03', { amountMinor: 9_900, currency: 'EUR' });
    await w.expense('2026-10-12', { amountMinor: 1_475 }); // everyday spend, no trip
    await w.expense('2026-09-30', { amountMinor: 99_999 }); // last month

    const home = await w.snapshot('2026-10-15');
    const row = (currency: string, onTrip: boolean) =>
      home.monthExpenses.find((m) => m.currency === currency && m.onTrip === onTrip);
    expect(row('USD', true)).toMatchObject({ status: 'ready', count: 1, amountMinor: 41_280 });
    expect(row('EUR', true)).toMatchObject({ count: 1, amountMinor: 9_900 });
    expect(row('USD', false)).toMatchObject({ count: 1, amountMinor: 1_475 });
    expect(home.monthExpenses.reduce((n, m) => n + m.count, 0)).toBe(3);
    expect(home.monthTrips).toBe(1);
  });

  it('counts the member’s receipts still being read', async () => {
    const w = await workspace('home-reading');
    await w.inOrg((tx) =>
      fileReceipt(
        tx,
        w.org.orgId,
        {
          id: newId(),
          memberId: w.org.memberId,
          source: 'camera',
          storageKey: `orgs/${w.org.orgId}/receipts/x`,
          contentType: 'image/jpeg',
          byteSize: 1234,
          sha256: 'a'.repeat(64),
        },
        w.org.userId,
      ),
    );
    expect((await w.snapshot('2026-10-03')).reading).toBe(1);
  });

  it('shows each member only their own trips, expenses and receipts', async () => {
    const w = await workspace('home-mine');
    const casey = await w.colleague();
    await w.trip('2026-10-02', '2026-10-04', casey);
    await w.expense('2026-10-03', { memberId: casey });

    const mine = await w.snapshot('2026-10-03');
    expect(mine.tripNow).toBeNull();
    expect(mine.monthExpenses).toEqual([]);
    expect(mine.monthTrips).toBe(0);
    expect((await w.snapshot('2026-10-03', casey)).tripNow).not.toBeNull();
  });

  it('lists the miles of the member’s drives this month, a route drive’s once measured', async () => {
    const w = await workspace('home-miles');
    const casey = await w.colleague();
    const today = '2026-10-20';
    const { orgId, userId } = w.org;
    const byHand = (date: string, miles: string, memberId = w.org.memberId) =>
      w.inOrg(async (tx) => {
        const input = { date, destination: 'Acme HQ', purpose: 'Client visit', miles };
        const logged = await logMileage(tx, orgId, memberId, input, userId, today);
        if (logged.status !== 'logged') throw new Error(`expected a drive, got ${logged.status}`);
      });
    const byRoute = async (date: string, measured: boolean) => {
      const stops = ['12 Elm St, Omaha', 'Acme HQ, 1520 Harney St, Omaha'];
      const input = { date, purpose: 'Client visit', stops };
      const logged = await w.inOrg((tx) =>
        logRouteMileage(tx, orgId, w.org.memberId, input, userId, today),
      );
      if (logged.status !== 'logged') throw new Error(`expected a drive, got ${logged.status}`);
      if (measured) {
        await w.inOrg((tx) =>
          recordRouteMeasurement(tx, orgId, logged.expenseId, logged.event.outboxId, {
            kind: 'measured',
            provider: 'openrouteservice',
            profile: 'driving-car',
            places: stops.map((label) => ({ label, longitude: '-95.9', latitude: '41.2' })),
            legs: [61_800],
            measuredAt: new Date('2026-10-20T12:00:00Z'),
          }),
        );
      }
      return logged.expenseId;
    };
    await byHand('2026-10-02', '38.4');
    await byHand('2026-10-14', '12');
    await byHand('2026-09-30', '99'); // last month
    await byHand('2026-10-03', '50', casey); // a colleague's
    await byRoute('2026-10-05', true); // measured: 61,800 m is 38.40 miles
    const claimed = await byRoute('2026-10-06', true);
    await w.inOrg((tx) =>
      claimMilesForRoute(
        tx,
        orgId,
        w.org.memberId,
        claimed,
        { miles: '41', reason: 'Road closed at the bridge' },
        userId,
        today,
      ),
    );
    await byRoute('2026-10-07', false); // still being measured: no miles yet

    const home = await w.snapshot('2026-10-15');
    expect(home.monthDrives).toEqual(['38.40', '38.40', '41.00', '12.00']);
    expect((await w.snapshot('2026-10-15', casey)).monthDrives).toEqual(['50.00']);
    expect((await w.snapshot('2026-09-15')).monthDrives).toEqual(['99.00']);
  });
});
