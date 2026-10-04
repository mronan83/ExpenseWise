import type { ExpenseRecord } from '@expensewise/db';
import { isExpenseEditable, type ExpenseValues } from '@expensewise/domain';
import { proofDifferences } from '@expensewise/extraction';
import type { ExpensesWithProof } from './expenses.ts';
import { detailsOf } from '@expensewise/extraction/place';
import { amountView, currentReview, filedReading, receiptSummary } from './receipt-views.ts';
import type { ReceiptWithReadings } from './receipts.ts';

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
    details: detailsOf(filedReading(receipt, runs, reviews)),
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
    local: expense.tripId === null && expense.transactionDate !== null,
    justification: expense.justification,
    reportId: expense.reportId ?? expense.tripReportId,
    createdAt: expense.createdAt.toISOString(),
    updatedAt: expense.updatedAt.toISOString(),
  };
}

/** Where the expense's time or place differs from what its receipt prints. */
const PROOF_DETAILS = ['time', 'address', 'city', 'country'] as const;

export function expenseDetail(expense: ExpenseRecord, proof: ReceiptWithReadings | null) {
  const shown = proof ? proofOf(proof) : null;
  return {
    ...expenseSummary(expense, proof),
    // When and where it was bought (FR-INT-17); any part may be blank.
    time: expense.time,
    timeZone: expense.timeZone,
    address: expense.address,
    city: expense.city,
    region: expense.region,
    country: expense.country,
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
          time: shown.details.time,
          address: shown.details.address,
          city: shown.details.city,
          country: shown.details.country,
          // A difference shows, but doesn't by itself reject the expense at review.
          detailDifferences: PROOF_DETAILS.filter(
            (f) => shown.details[f] !== null && shown.details[f] !== expense[f],
          ),
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
