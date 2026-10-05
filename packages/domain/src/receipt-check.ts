import type { ExpenseField } from './expense-values.ts';

/*
 * Whether an expense holds up against its receipt, for submitting and reviewing a report
 * (FR-EXP-10, FR-GOV-10, FR-GOV-13, Q6). The merchant (loosely), date and currency must be the
 * receipt's. The amount must be the receipt's, or lower with a reason, never higher. A lower
 * claim's reason is the person's own words, or the lines they left out of it, each of which
 * carries its reason (FR-EXP-16, #82). A drive, or an expense typed in by hand, has no receipt
 * to differ from. A split expense is one expense with one receipt, so its parts, which always
 * add up to its claim, are checked as that one claim.
 */

/** What an expense and its receipt say, as the check needs them. */
export interface ReceiptCheckInput {
  /**
   * Where the expense differs from its receipt, field by field, merchants compared loosely
   * (proofDifferences() in the extraction package). Null when it has no receipt.
   */
  readonly differences: readonly ExpenseField[] | null;
  /** What it claims and what its receipt totals, in minor units of each one's currency. */
  readonly claimedMinor: number | null;
  readonly claimedCurrency: string | null;
  readonly receiptMinor: number | null;
  readonly receiptCurrency: string | null;
  /** Why it claims less than its receipt, in the person's words; null when they gave none. */
  readonly reason: string | null;
  /** How many of its receipt's lines it leaves out of the claim, each with its reason. */
  readonly excludedLines: number;
}

/**
 * no_receipt: nothing to differ from. matches: it is what the receipt shows. explained: it
 * claims less than its receipt, and says why. differs: the fields that differ, whether it
 * claims more than the receipt, and whether a reason would settle it.
 */
export type ReceiptCheck =
  | { readonly state: 'no_receipt' }
  | { readonly state: 'matches' }
  | { readonly state: 'explained'; readonly by: 'reason' | 'lines' }
  | {
      readonly state: 'differs';
      readonly differences: readonly ExpenseField[];
      readonly over: boolean;
      readonly needsReason: boolean;
    };

/** Whether an expense matches its receipt, claims less with a reason, or differs (Q6). */
export function checkAgainstReceipt(input: ReceiptCheckInput): ReceiptCheck {
  const { differences } = input;
  if (differences === null) return { state: 'no_receipt' };
  if (differences.length === 0) return { state: 'matches' };
  const amountOnly = differences.length === 1 && differences[0] === 'amount';
  const comparable =
    input.claimedMinor !== null &&
    input.receiptMinor !== null &&
    input.claimedCurrency !== null &&
    input.claimedCurrency === input.receiptCurrency;
  const over = comparable && input.claimedMinor > input.receiptMinor;
  const less = comparable && input.claimedMinor < input.receiptMinor;
  if (amountOnly && less) {
    if (input.reason !== null && input.reason.trim() !== '') {
      return { state: 'explained', by: 'reason' };
    }
    if (input.excludedLines > 0) return { state: 'explained', by: 'lines' };
    return { state: 'differs', differences, over: false, needsReason: true };
  }
  return { state: 'differs', differences, over, needsReason: false };
}

/** Whether a report can go on with this expense: anything but an unexplained difference. */
export function holdsUp(check: ReceiptCheck): boolean {
  return check.state !== 'differs';
}

const FIELD_NAMES: Readonly<Record<ExpenseField, string>> = {
  merchant: 'merchant',
  date: 'date',
  currency: 'currency',
  amount: 'amount',
};

const listed = (words: readonly string[]) =>
  words.length <= 1
    ? (words[0] ?? '')
    : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;

/**
 * Why an expense doesn't hold up against its receipt, in a sentence: what a report's review
 * records when it rejects one on its own (FR-GOV-10), and what stops a submission (FR-GOV-13).
 */
export function receiptDifferenceText(check: ReceiptCheck): string | null {
  if (check.state !== 'differs') return null;
  if (check.over) return 'It claims more than its receipt.';
  if (check.needsReason) return 'It claims less than its receipt, and doesn’t say why.';
  const fields = check.differences.map((f) => FIELD_NAMES[f]);
  return `Its ${listed(fields)} ${fields.length === 1 ? 'isn’t' : 'aren’t'} its receipt’s.`;
}
