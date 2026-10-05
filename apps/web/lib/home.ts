import type { ExpenseAmount } from './expenses';
import type { InboxItem } from './receipts';
import type { ReportSummary } from './reports';
import type { TripSummary } from './trips';

/** What Home shows (GET /v1/home): the person's own records only. */
export interface Home {
  day: string;
  needsYou: { count: number; items: InboxItem[] };
  /** now: under way today. next: starts within 14 days. */
  trip: { when: 'now' | 'next'; day: number; startsIn: number; trip: TripSummary } | null;
  month: {
    from: string;
    expenses: number;
    ready: number;
    spent: ExpenseAmount[];
    trips: number;
    notOnTrip: { expenses: number; spent: ExpenseAmount[] };
    /**
     * Business miles: the person's drives dated this month, added up exactly as a plain
     * decimal such as "79.4". Only while mileage is on, and only when a drive claims miles.
     */
    miles?: { total: string; drives: number };
  };
  reading: number;
  /** Reports to finish: open and closed ones, newest first. */
  reports: ReportSummary[];
  recentTrips: TripSummary[];
}

/** The last day of the month that starts on `from`, as YYYY-MM-DD. */
export function monthEnd(from: string): string {
  const [y = 0, m = 1] = from.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

/** The month's name, e.g. "October", from its first day. */
export function monthName(from: string): string {
  return new Intl.DateTimeFormat(undefined, { month: 'long', timeZone: 'UTC' }).format(
    new Date(`${from}T12:00:00Z`),
  );
}

/** How far into a trip, or how soon it starts. */
export function tripWhen(trip: NonNullable<Home['trip']>): string {
  if (trip.when === 'now') return `Day ${trip.day} of ${trip.trip.days}`;
  return trip.startsIn === 1 ? 'Starts tomorrow' : `Starts in ${trip.startsIn} days`;
}

/** Whether a trip's expenses are all Ready, in a few words. */
export function tripProgress(trip: TripSummary): { text: string; tone: 'ok' | 'warn' | 'none' } {
  if (trip.needsReviewCount > 0) {
    const n = trip.needsReviewCount;
    return { text: n === 1 ? '1 needs a look' : `${n} need a look`, tone: 'warn' };
  }
  if (trip.expenseCount === 0) return { text: 'No expenses', tone: 'none' };
  if (trip.readyCount === trip.expenseCount) return { text: 'All Ready', tone: 'ok' };
  return { text: `${trip.readyCount} of ${trip.expenseCount} Ready`, tone: 'none' };
}
