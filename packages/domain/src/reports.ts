import { assertIsoDate } from './dates.ts';
import type { ExpenseStatus } from './lifecycle/expense.ts';

/** Days a report stays open before it closes itself (FR-EXP-12). */
export const REPORT_WINDOW_DAYS = 28;
/** Days before that when a report still needing review warns that reimbursement will wait. */
export const REPORT_WARNING_DAYS = 7;
/** A reopened report closes itself no sooner than this many days after reopening. */
export const REOPEN_GRACE_DAYS = 7;
/** The longest justification a local expense keeps. */
export const JUSTIFICATION_MAX = 500;

const DAY_MS = 86_400_000;

/**
 * When something dated `day` joins a report: 24 hours after that day has ended everywhere,
 * which is noon UTC two days later. The day ends last at UTC−12, so no one sees a trip join
 * early; at UTC+14 it joins 26 hours after their day ends. A trip goes by its return date,
 * a local expense by its own (FR-EXP-05, FR-EXP-14).
 */
export function joinsReportAt(day: string): Date {
  const [y = 0, m = 1, d = 1] = assertIsoDate(day).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + 2, 12));
}

/** When a report opened at `openedAt` closes itself. */
export function reportClosesAt(openedAt: Date): Date {
  return new Date(openedAt.getTime() + REPORT_WINDOW_DAYS * DAY_MS);
}

/** A reopened report keeps its day 28, or gets a week from reopening if that is later. */
export function reopenedClosesAt(closesAt: Date, now: Date): Date {
  const grace = now.getTime() + REOPEN_GRACE_DAYS * DAY_MS;
  return new Date(Math.max(closesAt.getTime(), grace));
}

/** Whether a report closing at `closesAt` is in its last week, or past it. */
export function reportWarns(closesAt: Date, now: Date): boolean {
  return now.getTime() >= closesAt.getTime() - REPORT_WARNING_DAYS * DAY_MS;
}

/** An expense still being read, or needing a look, holds its report open. */
const UNSETTLED: readonly ExpenseStatus[] = ['processing', 'needs_review'];

/** A trip is ready for its report to close when none of its expenses needs review. */
export function tripReady(statuses: readonly ExpenseStatus[]): boolean {
  return statuses.every((s) => !UNSETTLED.includes(s));
}

/** A local expense is ready when it needs no review and says why it was for business. */
export function localExpenseReady(status: ExpenseStatus, justification: string | null): boolean {
  return !UNSETTLED.includes(status) && justification !== null && justification.trim() !== '';
}

/**
 * A justification as kept: trimmed, at most JUSTIFICATION_MAX characters, or null when blank.
 * Returns an error message for one too long.
 */
export function cleanJustification(text: string): { value: string | null } | { error: string } {
  const value = text.trim();
  if (value === '') return { value: null };
  if (value.length > JUSTIFICATION_MAX) {
    return { error: `A justification is at most ${JUSTIFICATION_MAX} characters.` };
  }
  return { value };
}

export interface ReportItemState {
  readonly id: string;
  readonly ready: boolean;
}

/**
 * What day 28 does to an open report (FR-EXP-12, Q20). drop: it holds nothing. stay_open:
 * nothing in it is ready, so it waits, overdue, rather than moving everything on. close:
 * it closes with what is ready, and the rest move to the next report.
 */
export type AutoClosePlan =
  | { readonly action: 'drop' }
  | { readonly action: 'stay_open' }
  | { readonly action: 'close'; readonly move: readonly string[] };

export function planAutoClose(items: readonly ReportItemState[]): AutoClosePlan {
  if (items.length === 0) return { action: 'drop' };
  const unready = items.filter((i) => !i.ready).map((i) => i.id);
  if (unready.length === items.length) return { action: 'stay_open' };
  return { action: 'close', move: unready };
}
