import type { ExpenseRecord } from '@expensewise/db';
import {
  isCurrencyCode,
  isExpenseEditable,
  money,
  toDecimal,
  type ExpenseValues,
} from '@expensewise/domain';
import { proofDifferences } from '@expensewise/extraction';
import type { ExpensesWithProof } from './expenses.ts';
import { currentReview, receiptSummary } from './receipt-views.ts';
import type { ReceiptWithReadings } from './receipts.ts';

const amountView = (amountMinor: number | null, currency: string | null) =>
  amountMinor === null || currency === null || !isCurrencyCode(currency)
    ? null
    : { amountMinor, currency, decimal: toDecimal(money(amountMinor, currency)) };

/**
 * What an expense's receipt shows: what a person confirmed on it, else the reading its status
 * rests on (ADR-0021, ADR-0022). Empty while it is read.
 */
export function proofOf(proof: ReceiptWithReadings) {
  const { receipt, runs, reviews } = proof;
  const summary = receiptSummary(receipt, runs, reviews);
  const values: ExpenseValues = {
    merchant: summary.merchant,
    transactionDate: summary.date,
    currency: summary.total?.currency ?? null,
    amountMinor: summary.total?.amountMinor ?? null,
  };
  return {
    values,
    receiptId: receipt.id,
    status: receipt.status,
    confirmedBy: currentReview(receipt, runs, reviews)?.reviewedBy ?? null,
  };
}

export function expenseSummary(expense: ExpenseRecord, proof: ReceiptWithReadings | null) {
  const shown = proof ? proofOf(proof) : null;
  return {
    id: expense.id,
    status: expense.status,
    source: expense.source,
    owner: expense.owner,
    merchant: expense.merchant,
    date: expense.transactionDate,
    amount: amountView(expense.amountMinor, expense.currency),
    receiptId: expense.receiptId,
    trip: expense.tripId ? { id: expense.tripId, name: expense.tripName ?? '' } : null,
    tripFiledBy: expense.tripPinned ? ('person' as const) : ('date' as const),
    matchesReceipt: shown ? proofDifferences(expense, shown.values).length === 0 : null,
    createdAt: expense.createdAt.toISOString(),
    updatedAt: expense.updatedAt.toISOString(),
  };
}

export function expenseDetail(expense: ExpenseRecord, proof: ReceiptWithReadings | null) {
  const shown = proof ? proofOf(proof) : null;
  return {
    ...expenseSummary(expense, proof),
    editable: isExpenseEditable(expense.status),
    editedAt: expense.editedAt?.toISOString() ?? null,
    proof: shown
      ? {
          receiptId: shown.receiptId,
          status: shown.status,
          confirmedBy: shown.confirmedBy,
          merchant: shown.values.merchant,
          date: shown.values.transactionDate,
          amount: amountView(shown.values.amountMinor, shown.values.currency),
          differences: proofDifferences(expense, shown.values),
        }
      : null,
  };
}

/** Each expense's summary, with whether it matches its receipt. */
export function expenseSummaries(found: ExpensesWithProof) {
  const { expenses, receipts, runs, reviews } = found;
  return expenses.map((e) => {
    const receipt = receipts.find((r) => r.id === e.receiptId);
    return expenseSummary(e, receipt ? { receipt, runs, reviews } : null);
  });
}
