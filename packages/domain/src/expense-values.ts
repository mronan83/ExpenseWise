import { isCurrencyCode } from './currency.ts';
import { isIsoDate } from './dates.ts';
import { DomainError } from './errors.ts';
import { isExpenseEditable, type ExpenseStatus } from './lifecycle/expense.ts';
import { fromDecimal, isNegative, money, toDecimal } from './money.ts';
import { err, ok, type Result } from './result.ts';

/**
 * What an expense claims: the four fields that decide whether it can be filed. Money is integer
 * minor units in `currency`; the date is a local calendar date.
 */
export interface ExpenseValues {
  readonly merchant: string | null;
  readonly transactionDate: string | null;
  readonly currency: string | null;
  readonly amountMinor: number | null;
}

export const EXPENSE_FIELDS = ['merchant', 'date', 'currency', 'amount'] as const;
export type ExpenseField = (typeof EXPENSE_FIELDS)[number];

export const NO_VALUES: ExpenseValues = {
  merchant: null,
  transactionDate: null,
  currency: null,
  amountMinor: null,
};

/** Every filing field is filled in. */
export function isComplete(v: ExpenseValues): boolean {
  return (
    v.merchant !== null &&
    v.merchant.trim() !== '' &&
    v.transactionDate !== null &&
    v.currency !== null &&
    v.amountMinor !== null
  );
}

/** A receipt's status as far as its expense is concerned (the receipt_status values). */
export type ProofStatus = 'processing' | 'extracted' | 'needs_review' | 'failed';

/**
 * The status of an expense made from a receipt (ADR-0022). It is Ready only when its proof is
 * settled, meaning the receipt is Ready, and its claim is complete; while the receipt is read
 * it is processing; otherwise it needs review. Null once the expense is submitted or later:
 * from then on its receipt can't move it.
 */
export function receiptExpenseStatus(
  current: ExpenseStatus | null,
  proof: ProofStatus,
  values: ExpenseValues,
): ExpenseStatus | null {
  if (current !== null && current !== 'processing' && !isExpenseEditable(current)) return null;
  if (proof === 'processing') return 'processing';
  return proof === 'extracted' && isComplete(values) ? 'ready' : 'needs_review';
}

/**
 * What a person typed, field by field: any text for the merchant, an ISO date, an ISO 4217
 * code, and a plain decimal such as "12.50" for the amount, in the expense's currency.
 */
export interface ExpenseEdit {
  readonly merchant?: string;
  readonly date?: string;
  readonly currency?: string;
  readonly amount?: string;
}

/** One field a person changed, as shown: amounts as plain decimals. */
export interface ExpenseChange {
  readonly field: ExpenseField;
  readonly from: string | null;
  readonly to: string;
}

export interface ExpenseEditProblem {
  readonly field: ExpenseField;
  readonly message: string;
}

const MERCHANT_MAX = 200;

const shown = (v: ExpenseValues, field: ExpenseField): string | null => {
  switch (field) {
    case 'merchant':
      return v.merchant;
    case 'date':
      return v.transactionDate;
    case 'currency':
      return v.currency;
    case 'amount':
      return v.amountMinor === null || v.currency === null || !isCurrencyCode(v.currency)
        ? null
        : toDecimal(money(v.amountMinor, v.currency));
  }
};

/**
 * Applies a person's edit to an expense's values (FR-EXP-09). Nothing is rounded: an amount
 * with more decimals than its currency allows is refused. A corrected currency keeps the
 * amount as written, so "12.50" EUR becomes "12.50" USD, never a conversion.
 */
export function applyExpenseEdit(
  current: ExpenseValues,
  edit: ExpenseEdit,
): Result<{ values: ExpenseValues; changes: ExpenseChange[] }, ExpenseEditProblem> {
  const invalid = (field: ExpenseField, message: string) => err({ field, message });

  const merchant = edit.merchant?.trim();
  if (merchant !== undefined && (merchant === '' || merchant.length > MERCHANT_MAX)) {
    return invalid('merchant', `Enter the merchant's name, up to ${MERCHANT_MAX} characters.`);
  }
  const date = edit.date?.trim();
  if (date !== undefined && !isIsoDate(date)) {
    return invalid('date', 'Enter a date as YYYY-MM-DD.');
  }
  const code = edit.currency?.trim().toUpperCase();
  if (code !== undefined && !isCurrencyCode(code)) {
    return invalid('currency', `${code || 'That'} is not a currency ExpenseWise supports.`);
  }
  const currency = code ?? current.currency;

  let amountMinor = current.amountMinor;
  const typed = edit.amount?.trim();
  const source = typed ?? (code !== undefined ? shown(current, 'amount') : null);
  if (source !== null && source !== undefined) {
    if (currency === null) return invalid('currency', 'Choose the currency first.');
    try {
      const value = fromDecimal(source, currency);
      if (isNegative(value)) return invalid('amount', 'Enter an amount of zero or more.');
      amountMinor = value.amountMinor;
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      return typed === undefined
        ? invalid('amount', `The amount doesn't fit ${currency}; enter it again.`)
        : invalid('amount', `Enter an amount in ${currency}, such as 12.50.`);
    }
  }

  const values: ExpenseValues = {
    merchant: merchant ?? current.merchant,
    transactionDate: date ?? current.transactionDate,
    currency,
    amountMinor,
  };
  const changes = EXPENSE_FIELDS.flatMap((field) => {
    const from = shown(current, field);
    const to = shown(values, field);
    return to !== null && to !== from ? [{ field, from, to }] : [];
  });
  return ok({ values, changes });
}
