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
  /** Null without a receipt. */
  matchesReceipt: boolean | null;
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
