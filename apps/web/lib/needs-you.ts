import { formatMoney, needsYou, RECEIPT_STATUS, type InboxItem } from './receipts';
import { reportHolds, reportName, type ReportSummary } from './reports';

/** One card in Needs you, whatever needs the person: a receipt, a report or an expense. */
export interface InboxCard {
  key: string;
  title: string;
  amount: string | null;
  /** A date, then a status in its own colour, when there is one. */
  when: string;
  status: { label: string; tone: string } | null;
  text: string;
  action: string;
  href: string;
  /** The colour of the card's edge: bad for what nothing could read, ok for a report to close. */
  edge: 'warn' | 'bad' | 'ok';
}

const totalsText = (report: ReportSummary) =>
  report.totals.map((t) => formatMoney(t)).join(' + ') || null;

const day = (iso: string) =>
  new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' }).format(new Date(iso));

/** What an inbox item says, and the one thing to do about it (FR-EXP-02). */
export function inboxCard(item: InboxItem): InboxCard {
  switch (item.kind) {
    case 'receipt': {
      const { receipt } = item;
      return {
        key: `receipt-${receipt.id}`,
        title: receipt.merchant ?? 'A receipt',
        amount: receipt.total ? formatMoney(receipt.total) : null,
        when: receipt.date ?? new Date(receipt.createdAt).toLocaleDateString(),
        status: RECEIPT_STATUS[receipt.status],
        ...needsYou(item),
        edge: receipt.status === 'failed' ? 'bad' : 'warn',
      };
    }
    case 'expense': {
      const { expense } = item;
      return {
        key: `expense-${expense.id}`,
        title: expense.merchant ?? 'An expense',
        amount: expense.amount ? formatMoney(expense.amount) : null,
        when: expense.date ?? '',
        status: { label: 'Local', tone: 'text-ink-2' },
        text: 'It’s on no trip: say why it was for business before its report can close.',
        action: 'Add a reason',
        href: `/expenses/${expense.id}`,
        edge: 'warn',
      };
    }
    case 'report': {
      const { report, reason } = item;
      const close = day(report.closesAt);
      const n = report.needsAttention;
      const things = n === 1 ? '1 thing still needs you' : `${n} things still need you`;
      const text =
        reason.code === 'ready_to_close'
          ? 'Everything on it is ready. Close it, then submit it for reimbursement.'
          : reason.code === 'overdue'
            ? `It was due to close ${close}, but ${things}. Reimbursement waits until you finish.`
            : `Close it by ${close}, or reimbursement will be delayed: ${things}.`;
      return {
        key: `report-${report.id}`,
        title: reportName(report),
        amount: totalsText(report),
        when: reportHolds(report),
        status: null,
        text,
        action: reason.code === 'ready_to_close' ? 'Close it' : 'Open the report',
        href: `/reports/${report.id}`,
        edge: reason.code === 'ready_to_close' ? 'ok' : 'warn',
      };
    }
  }
}
