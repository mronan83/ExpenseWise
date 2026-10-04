import type { IsoDate } from './dates.ts';
import type { ExpenseStatus } from './lifecycle/expense.ts';
import { addDays, addDaysIn, dateIn, LAST_TIME_ZONE, startOfDayIn } from './time-zones.ts';

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
 * When something dated `day` joins a report: 24 hours after that day has ended (FR-EXP-05,
 * FR-EXP-14). A trip goes by its return date, a local expense by its own. With no time zone,
 * the day is counted where it ends last, UTC−12, so no one sees a trip join early: noon UTC two
 * days later, which is up to 50 hours after the day ends at UTC+14. The organization's time zone
 * (FR-PLT-11) counts it where the organization is, so the wait is 24 hours there.
 */
export function joinsReportAt(day: string, timeZone: string = LAST_TIME_ZONE): Date {
  const ends = startOfDayIn(addDays(day, 1), timeZone);
  return new Date(ends.getTime() + DAY_MS);
}

/**
 * The latest date whose 24 hours after its end have passed at `now`: whatever is dated on or
 * before it joins a report. The same rule as joinsReportAt(), asked the other way round, so the
 * database compares dates.
 */
export function lastDayToJoin(now: Date, timeZone: string = LAST_TIME_ZONE): IsoDate {
  return addDays(dateIn(new Date(now.getTime() - DAY_MS), timeZone), -1);
}

/**
 * When a report opened at `openedAt` closes itself: 28 days on. With a time zone, 28 days on
 * the organization's calendar at the same time of day, so a clock change doesn't move day 28
 * to the day before; without one, 28 days of 24 hours.
 */
export function reportClosesAt(openedAt: Date, timeZone?: string | null): Date {
  if (timeZone) return addDaysIn(openedAt, REPORT_WINDOW_DAYS, timeZone);
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
