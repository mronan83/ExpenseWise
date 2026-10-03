import type { ExpenseField, ExpenseValues } from '@expensewise/domain';
import type { ConfirmedReading } from './confirm.ts';
import type { NormalizedExtraction } from './normalize.ts';
import { sameMerchant } from './review.ts';

/** What a reading would file an expense with; any field it lacks stays empty. */
export function valuesOfReading(reading: NormalizedExtraction | null): ExpenseValues {
  const total = reading?.total?.value ?? null;
  return {
    merchant: reading?.merchant?.value ?? null,
    transactionDate: reading?.date?.value ?? null,
    currency: reading?.currency?.value ?? total?.currency ?? null,
    amountMinor: total?.amountMinor ?? null,
  };
}

/** What a confirmed reading files an expense with (ADR-0021). */
export function valuesOfConfirmed(confirmed: ConfirmedReading): ExpenseValues {
  return {
    merchant: confirmed.merchant,
    transactionDate: confirmed.date,
    currency: confirmed.currency,
    amountMinor: confirmed.total.amountMinor,
  };
}

/**
 * Where an expense differs from its receipt, its proof (FR-EXP-08, FR-GOV-10). Merchant names
 * match loosely, as two readings do; date, currency and amount must be the same. A field the
 * receipt doesn't show can't differ. Shown while editing; enforcing it at review is #24 (Q6).
 */
export function proofDifferences(expense: ExpenseValues, proof: ExpenseValues): ExpenseField[] {
  const differs: Record<ExpenseField, boolean> = {
    merchant:
      proof.merchant !== null &&
      (expense.merchant === null || !sameMerchant(proof.merchant, expense.merchant)),
    date: proof.transactionDate !== null && expense.transactionDate !== proof.transactionDate,
    currency: proof.currency !== null && expense.currency !== proof.currency,
    amount:
      proof.amountMinor !== null &&
      (expense.amountMinor !== proof.amountMinor || expense.currency !== proof.currency),
  };
  return (['merchant', 'date', 'currency', 'amount'] as const).filter((f) => differs[f]);
}
