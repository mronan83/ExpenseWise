import type { ExpenseAmount, ExpenseStatus } from './expenses';
import type { TripSummary } from './trips';

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
  /** One per currency, never converted. */
  totals: ExpenseAmount[];
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
}

export interface ReportDetail extends ReportSummary {
  tripItems: (TripSummary & { unsettled: number; ready: boolean })[];
  localItems: ReportLocalItem[];
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

const day = (iso: string) =>
  new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' }).format(new Date(iso));

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
