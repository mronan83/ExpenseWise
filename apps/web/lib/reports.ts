import { showDate } from '@expensewise/domain';
import type { ExpenseAmount, ExpenseStatus } from './expenses';
import { formatMoney } from './receipts';
import type { TripSummary } from './trips';

/**
 * What something adds up to in the person's reimbursement currency (FR-EXP-13), while
 * currency conversion is on: what is in it, how many amounts are still converting, and what
 * the rate source has no rate for, as spent.
 */
export interface ReimbursementTotal {
  total: ExpenseAmount;
  converting: number;
  unconverted: ExpenseAmount[];
}

/** The rate an amount was converted at, as copied onto it. */
export interface AppliedRate {
  rate: string;
  /** The day it was published: the purchase date, or the last day before it. */
  date: string;
  source: string;
}

/** One amount in the reimbursement currency. */
export interface Reimbursed {
  kind: 'same' | 'converted' | 'converting' | 'unconverted';
  amount: ExpenseAmount | null;
  rate: AppliedRate | null;
}

export type ReportStatus = 'open' | 'closed' | 'submitted' | 'in_approval' | 'approved' | 'settled';

/** A report (FR-EXP-05, FR-EXP-12): trips that joined after they ended, and local expenses. */
export interface ReportSummary {
  id: string;
  title: string;
  status: ReportStatus;
  owner: string;
  currency: string;
  openedAt: string;
  /** When an open report closes itself: day 28, later if reopened. */
  closesAt: string;
  closedAt: string | null;
  tripNames: string[];
  trips: number;
  localExpenses: number;
  /** Trips with expenses needing review, and local expenses needing review or a reason. */
  needsAttention: number;
  canClose: boolean;
  /** Open, in its last week, with something still needing review. */
  warning: boolean;
  /** Open past day 28, nothing on it ready. */
  overdue: boolean;
  /** One per currency, as spent, never converted. */
  totals: ExpenseAmount[];
  /** In `currency`, while conversion is on. */
  reimbursement?: ReimbursementTotal;
}

export interface ReportLocalItem {
  id: string;
  status: ExpenseStatus;
  merchant: string | null;
  date: string | null;
  amount: ExpenseAmount | null;
  receiptId: string | null;
  justification: string | null;
  /** Held as a possible duplicate: in no total until decided. */
  held: boolean;
  ready: boolean;
  /** In the report's currency, while conversion is on; null with no amount yet. */
  reimbursed?: Reimbursed | null;
}

export interface ReportDetail extends ReportSummary {
  tripItems: (TripSummary & {
    unsettled: number;
    ready: boolean;
    reimbursement?: ReimbursementTotal;
  })[];
  localItems: ReportLocalItem[];
  /** Each rate its amounts were converted at, while conversion is on. */
  rates?: (AppliedRate & { from: string; to: string; expenses: number })[];
}

export const REPORT_STATUS: Record<ReportStatus, { label: string; tone: string }> = {
  open: { label: 'Open', tone: 'text-carbon' },
  closed: { label: 'Closed', tone: 'text-ok' },
  submitted: { label: 'Submitted', tone: 'text-ink-2' },
  in_approval: { label: 'With the approver', tone: 'text-ink-2' },
  approved: { label: 'Approved', tone: 'text-ok' },
  settled: { label: 'Paid', tone: 'text-ok' },
};

/** What a report is called: its trips, or its local expenses when it has no trip. */
export function reportName(report: Pick<ReportSummary, 'tripNames' | 'localExpenses' | 'title'>) {
  const [first, ...rest] = report.tripNames;
  if (!first) return report.localExpenses > 0 ? 'Local expenses' : report.title;
  return rest.length === 0 ? first : `${first} + ${rest.length} more`;
}

const day = (iso: string) => showDate(iso);

/** When it closed, or closes, in a few words. */
export function reportWhen(report: ReportSummary): string {
  if (report.status === 'open') {
    return report.overdue ? `Was due ${day(report.closesAt)}` : `Closes ${day(report.closesAt)}`;
  }
  return report.closedAt ? `Closed ${day(report.closedAt)}` : REPORT_STATUS[report.status].label;
}

/** What it still needs, in a few words, and in which tone. */
export function reportProgress(report: ReportSummary): {
  text: string;
  tone: 'ok' | 'warn' | 'none';
} {
  if (report.status !== 'open') return { text: REPORT_STATUS[report.status].label, tone: 'none' };
  if (report.needsAttention > 0) {
    const n = report.needsAttention;
    return { text: n === 1 ? '1 needs you' : `${n} need you`, tone: 'warn' };
  }
  return report.canClose ? { text: 'Ready to close', tone: 'ok' } : { text: 'Empty', tone: 'none' };
}

/** What a report holds, e.g. "2 trips · 1 local expense". */
export function reportHolds(report: Pick<ReportSummary, 'trips' | 'localExpenses'>): string {
  const parts = [
    ...(report.trips > 0 ? [`${report.trips} ${report.trips === 1 ? 'trip' : 'trips'}`] : []),
    ...(report.localExpenses > 0
      ? [`${report.localExpenses} local ${report.localExpenses === 1 ? 'expense' : 'expenses'}`]
      : []),
  ];
  return parts.join(' · ') || 'Nothing on it';
}

/** Amounts as spent, one per currency, e.g. "$1,284.37 + €412.80". */
export const asSpent = (amounts: readonly ExpenseAmount[]) =>
  amounts.map((t) => formatMoney(t)).join(' + ') || '–';

/**
 * A report's total in a few characters: in the reimbursement currency while conversion is on,
 * with anything the source has no rate for after it as spent; otherwise each currency apart.
 */
export function reportTotal(r: Pick<ReportSummary, 'totals' | 'reimbursement'>): string {
  if (!r.reimbursement) return asSpent(r.totals);
  return [r.reimbursement.total, ...r.reimbursement.unconverted]
    .map((t) => formatMoney(t))
    .join(' + ');
}

/** What a reimbursement total leaves out, in a few words, or null for nothing. */
export function leftOut(r: ReimbursementTotal): string | null {
  const parts = [
    ...(r.converting > 0
      ? [r.converting === 1 ? '1 amount converting' : `${r.converting} amounts converting`]
      : []),
    ...(r.unconverted.length > 0 ? [`${asSpent(r.unconverted)} not converted`] : []),
  ];
  return parts.length > 0 ? parts.join(' · ') : null;
}

const published = (iso: string) => showDate(iso);

/** Where a rate came from: "ECB reference rate, Sep 25, 2026". */
export const rateSource = (r: AppliedRate) =>
  `${r.source === 'ECB' ? 'ECB reference rate' : r.source}, ${published(r.date)}`;
