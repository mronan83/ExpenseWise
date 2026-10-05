import type { ExpenseStatus } from '@expensewise/domain';
import { and, asc, count, desc, eq, gt, gte, isNull, lt, lte, ne, not, or, sql } from 'drizzle-orm';
import type { Transaction } from './client.ts';
import { heldAsDuplicate } from './duplicates.ts';
import { expenses, mileageLogs, mileageRoutes, receipts, trips } from './schema.ts';
import { safeMinor, tallyTrips, tripsWithOwner, type TripRecord, type TripTally } from './trips.ts';

/** This month's expenses, counted and summed by status, currency and whether on a trip. */
export interface MonthTally {
  readonly status: ExpenseStatus;
  readonly currency: string | null;
  readonly onTrip: boolean;
  readonly count: number;
  /** Integer minor units; null where no amount is known yet. */
  readonly amountMinor: number | null;
}

/** What Home shows one member on one day (FR-INS-01), read in one transaction. */
export interface HomeSnapshot {
  /** The trip whose dates include the day; the latest to start if several do. */
  readonly tripNow: TripRecord | null;
  /** With no trip under way, the next to start within `soonDays`. */
  readonly tripNext: TripRecord | null;
  /** The last trips to end before the day, latest first. */
  readonly recentTrips: readonly TripRecord[];
  /** What is on each of those trips. */
  readonly tallies: readonly TripTally[];
  /** The month the day falls in: its first day, and the first day of the next. */
  readonly month: { readonly from: string; readonly until: string };
  readonly monthExpenses: readonly MonthTally[];
  /** Trips that overlap the month. */
  readonly monthTrips: number;
  /** The member's receipts still being read. */
  readonly reading: number;
  /**
   * The miles each of the member's drives dated this month claims, as plain decimals
   * (FR-INS-01): a drive logged by hand, and a route drive once it is measured. A route drive
   * still being measured, or one not measured and not yet claimed by hand, claims none.
   * Absent only from a snapshot made without them, such as a test's.
   */
  readonly monthDrives?: readonly string[];
}

/** The first day of the month `day` falls in, and of the month after. */
export function monthOf(day: string): { from: string; until: string } {
  const [y = 0, m = 1] = day.split('-').map(Number);
  const next = m === 12 ? [y + 1, 1] : [y, m + 1];
  const iso = (year: number, month: number) => `${year}-${String(month).padStart(2, '0')}-01`;
  return { from: iso(y, m), until: iso(next[0]!, next[1]!) };
}

/**
 * Everything Home shows `memberId` on `day`, their own records only. Call inside withOrg().
 * The day is the person's own, from their device, so a trip starts on their calendar.
 */
export async function homeSnapshot(
  tx: Transaction,
  memberId: string,
  day: string,
  { soonDays = 14, recent = 3 }: { soonDays?: number; recent?: number } = {},
): Promise<HomeSnapshot> {
  const mine = eq(trips.memberId, memberId);
  const [tripNow] = await tripsWithOwner(tx)
    .where(and(mine, lte(trips.startDate, day), gte(trips.endDate, day)))
    .orderBy(desc(trips.startDate), desc(trips.createdAt), desc(trips.id))
    .limit(1);
  const [tripNext] = tripNow
    ? []
    : await tripsWithOwner(tx)
        .where(
          and(
            mine,
            gt(trips.startDate, day),
            lte(trips.startDate, sql`(${day}::date + ${soonDays}::int)`),
          ),
        )
        .orderBy(asc(trips.startDate), asc(trips.createdAt), asc(trips.id))
        .limit(1);
  const recentTrips = await tripsWithOwner(tx)
    .where(and(mine, lt(trips.endDate, day)))
    .orderBy(desc(trips.endDate), desc(trips.startDate), desc(trips.id))
    .limit(recent);
  const shown = [tripNow, tripNext, ...recentTrips].filter((t): t is TripRecord => !!t);

  const month = monthOf(day);
  const rows = await tx
    .select({
      status: expenses.status,
      currency: expenses.currency,
      onTrip: sql<boolean>`${expenses.tripId} is not null`,
      count: sql<number>`count(*)::int`,
      // Summed as text so a large total is never squeezed through a float.
      amountMinor: sql<string | null>`sum(${expenses.amountMinor})::text`,
    })
    .from(expenses)
    .where(
      and(
        eq(expenses.memberId, memberId),
        gte(expenses.transactionDate, month.from),
        lt(expenses.transactionDate, month.until),
        not(heldAsDuplicate(expenses.id)),
      ),
    )
    .groupBy(expenses.status, expenses.currency, sql`${expenses.tripId} is not null`);
  const [trip] = await tx
    .select({ n: count() })
    .from(trips)
    .where(and(mine, lt(trips.startDate, month.until), gte(trips.endDate, month.from)));
  const [read] = await tx
    .select({ n: count() })
    .from(receipts)
    .where(and(eq(receipts.memberId, memberId), eq(receipts.status, 'processing')));
  const drives = await tx
    .select({ miles: mileageLogs.distance })
    .from(mileageLogs)
    .innerJoin(
      expenses,
      and(eq(expenses.orgId, mileageLogs.orgId), eq(expenses.id, mileageLogs.expenseId)),
    )
    .leftJoin(
      mileageRoutes,
      and(eq(mileageRoutes.orgId, mileageLogs.orgId), eq(mileageRoutes.expenseId, expenses.id)),
    )
    .where(
      and(
        eq(expenses.memberId, memberId),
        gte(expenses.transactionDate, month.from),
        lt(expenses.transactionDate, month.until),
        eq(mileageLogs.unit, 'mi'),
        // A route drive claims its miles once measured; until then its log holds none.
        or(isNull(mileageRoutes.status), ne(mileageRoutes.status, 'measuring')),
        gt(mileageLogs.distance, '0'),
      ),
    )
    .orderBy(expenses.transactionDate, expenses.id);

  return {
    tripNow: tripNow ?? null,
    tripNext: tripNext ?? null,
    recentTrips,
    tallies: await tallyTrips(
      tx,
      shown.map((t) => t.id),
    ),
    month,
    monthExpenses: rows.map((r) => ({
      ...r,
      amountMinor: r.amountMinor === null ? null : safeMinor(r.amountMinor),
    })),
    monthTrips: trip?.n ?? 0,
    reading: read?.n ?? 0,
    monthDrives: drives.map((d) => d.miles),
  };
}
