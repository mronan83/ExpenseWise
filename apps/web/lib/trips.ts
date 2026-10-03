import type { ExpenseAmount, ExpenseSummary } from './expenses';

export interface TripSummary {
  id: string;
  name: string;
  purpose: string | null;
  primaryCity: string | null;
  startDate: string;
  endDate: string;
  days: number;
  owner: string;
  expenseCount: number;
  /** Ready, or further along. */
  readyCount: number;
  needsReviewCount: number;
  /** One per currency, never converted. */
  totals: ExpenseAmount[];
  createdAt: string;
}

export interface TripDetail extends TripSummary {
  /** In date order; those with no date yet last. */
  expenses: ExpenseSummary[];
}

/** Today in the viewer's own time zone, as YYYY-MM-DD. */
export function localToday(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

// Calendar dates are shown as written: built at noon UTC and formatted in UTC, so no time
// zone can move them a day.
const calendar = (date: string) => new Date(`${date}T12:00:00Z`);
const fmt = (options: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat(undefined, { ...options, timeZone: 'UTC' });

/** A trip's dates, e.g. "Sep 22 – 25, 2026". */
export function tripDates(trip: Pick<TripSummary, 'startDate' | 'endDate'>): string {
  return fmt({ month: 'short', day: 'numeric', year: 'numeric' }).formatRange(
    calendar(trip.startDate),
    calendar(trip.endDate),
  );
}

/** A day on a trip's timeline, e.g. "Mon, Sep 22". */
export function dayLabel(date: string): string {
  return fmt({ weekday: 'short', month: 'short', day: 'numeric' }).format(calendar(date));
}
