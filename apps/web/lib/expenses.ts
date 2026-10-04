import type { ReceiptSummary } from './receipts';

export type ExpenseStatus =
  'processing' | 'needs_review' | 'ready' | 'submitted' | 'approved' | 'settled';

export interface ExpenseAmount {
  amountMinor: number;
  currency: string;
  decimal: string;
}

export type ExpenseField = 'merchant' | 'date' | 'currency' | 'amount';

export interface ExpenseSummary {
  id: string;
  status: ExpenseStatus;
  source: string;
  owner: string;
  merchant: string | null;
  date: string | null;
  amount: ExpenseAmount | null;
  /** Its receipt, the proof (FR-EXP-08). */
  receiptId: string | null;
  /** The trip it is filed to (FR-EXP-04), or null. */
  trip: { id: string; name: string } | null;
  /** person: someone chose its trip, or no trip, and filing by date leaves it there. */
  tripFiledBy: 'date' | 'person';
  /** Null without a receipt. */
  matchesReceipt: boolean | null;
  /** On no trip, with a date: it needs a justification before its report can close. */
  local: boolean;
  /** Why a local expense was for business. */
  justification: string | null;
  /** The report it is on: its trip’s, or its own when local. */
  reportId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ExpenseDetail extends ExpenseSummary {
  editable: boolean;
  editedAt: string | null;
  proof: {
    receiptId: string;
    status: ReceiptSummary['status'];
    confirmedBy: string | null;
    merchant: string | null;
    date: string | null;
    amount: ExpenseAmount | null;
    differences: ExpenseField[];
  } | null;
}

export const EXPENSE_STATUS: Record<ExpenseStatus, { label: string; tone: string }> = {
  processing: { label: 'Reading…', tone: 'text-ink-2' },
  needs_review: { label: 'Needs a look', tone: 'text-warn' },
  ready: { label: 'Ready', tone: 'text-ok' },
  submitted: { label: 'Submitted', tone: 'text-ink-2' },
  approved: { label: 'Approved', tone: 'text-ok' },
  settled: { label: 'Paid', tone: 'text-ok' },
};

export const EXPENSE_FIELD_LABELS: Record<ExpenseField, string> = {
  merchant: 'Merchant',
  date: 'Date',
  currency: 'Currency',
  amount: 'Amount',
};
