import { showDateRange, showDay } from '@expensewise/domain';
import type { CostSplit } from './company-paid';
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
  /** Its cost split by who paid it, while Paid by the company is on (FR-EXP-17). */
  cost?: CostSplit;
  /** The report it is on, once it has joined one. */
  reportId: string | null;
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

/** A trip's dates, e.g. "Sep 22 – 25, 2026". */
export function tripDates(trip: Pick<TripSummary, 'startDate' | 'endDate'>): string {
  return showDateRange(trip.startDate, trip.endDate);
}

/** A day on a trip's timeline, e.g. "Tue, Sep 22, 2026". */
export function dayLabel(date: string): string {
  return showDay(date);
}
