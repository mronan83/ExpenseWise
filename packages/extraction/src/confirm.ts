import {
  DomainError,
  equals,
  err,
  fromDecimal,
  isCurrencyCode,
  isIsoDate,
  isNegative,
  ok,
  toDecimal,
  zero,
  type CurrencyCode,
  type Money,
  type Result,
} from '@expensewise/domain';
import { assumedZeros, type NormalizedExtraction } from './normalize.ts';

/** The fields a person can correct on a receipt that needs a look (FR-INT-15). */
export const CORRECTABLE_FIELDS = [
  'merchant',
  'date',
  'currency',
  'total',
  'taxTotal',
  'tip',
] as const;
export type CorrectableField = (typeof CORRECTABLE_FIELDS)[number];

/**
 * What a person typed, field by field: any text for the merchant, an ISO date, an ISO 4217
 * code, and plain decimals such as "12.50" for amounts, in the receipt's currency.
 */
export type Corrections = Partial<Record<CorrectableField, string>>;

/** A reading a person has confirmed: what the receipt is filed with. */
export interface ConfirmedReading {
  readonly merchant: string;
  readonly date: string;
  readonly currency: CurrencyCode;
  readonly total: Money;
  readonly taxTotal: Money | null;
  readonly tip: Money | null;
}

/**
 * One field the person changed: what the model read (null when it read nothing) and what
 * they entered. Each is a candidate for the eval set (ADR-0012), so both are kept.
 */
export interface Correction {
  readonly field: CorrectableField;
  readonly read: string | null;
  readonly corrected: string;
}

export type ConfirmProblem =
  | { readonly kind: 'invalid'; readonly field: CorrectableField; readonly message: string }
  | { readonly kind: 'missing'; readonly fields: readonly CorrectableField[] };

const MERCHANT_MAX = 200;

/**
 * Confirms a reading as it is, or with the fields a person corrected (ADR-0021). A receipt
 * is only filed with a merchant, date, currency and total, so any of those the reading lacks
 * must be entered. A tax or tip the receipt doesn't print counts as zero, as it is shown
 * (FR-INT-14). A corrected currency keeps the amounts as printed: "12.50" EUR becomes
 * "12.50" USD, never a conversion.
 */
export function confirmReading(
  reading: NormalizedExtraction | null,
  corrections: Corrections = {},
): Result<{ confirmed: ConfirmedReading; corrections: Correction[] }, ConfirmProblem> {
  const invalid = (field: CorrectableField, message: string) =>
    err({ kind: 'invalid' as const, field, message });

  const merchant = corrections.merchant?.trim();
  if (merchant !== undefined && (merchant === '' || merchant.length > MERCHANT_MAX)) {
    return invalid('merchant', `Enter the merchant's name, up to ${MERCHANT_MAX} characters.`);
  }
  const date = corrections.date?.trim();
  if (date !== undefined && !isIsoDate(date)) {
    return invalid('date', 'Enter a date as YYYY-MM-DD.');
  }
  const code = corrections.currency?.trim().toUpperCase();
  if (code !== undefined && !isCurrencyCode(code)) {
    return invalid('currency', `${code || 'That'} is not a currency ExpenseWise supports.`);
  }

  const readCurrency = reading?.currency?.value ?? reading?.total?.value.currency ?? null;
  const currency = code ?? readCurrency;
  const assumed = reading ? assumedZeros(reading) : [];

  // An amount the person typed, or the one read, restated in the confirmed currency.
  const amount = (field: 'total' | 'taxTotal' | 'tip'): Result<Money | null, ConfirmProblem> => {
    const typed = corrections[field]?.trim();
    const read = reading?.[field]?.value ?? null;
    if (!currency) return ok(null);
    const source = typed ?? (read ? toDecimal(read) : null);
    if (source === null) {
      return ok(field !== 'total' && assumed.includes(field) ? zero(currency) : null);
    }
    try {
      const value = fromDecimal(source, currency);
      if (isNegative(value)) return invalid(field, 'Enter an amount of zero or more.');
      return ok(value);
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      return typed === undefined
        ? invalid(field, `The amount read doesn't fit ${currency}; enter it again.`)
        : invalid(field, `Enter an amount in ${currency}, such as 12.50.`);
    }
  };
  const total = amount('total');
  if (!total.ok) return total;
  const taxTotal = amount('taxTotal');
  if (!taxTotal.ok) return taxTotal;
  const tip = amount('tip');
  if (!tip.ok) return tip;

  const finalMerchant = merchant ?? reading?.merchant?.value ?? null;
  const finalDate = date ?? reading?.date?.value ?? null;
  const missing = (
    [
      ['merchant', finalMerchant],
      ['date', finalDate],
      ['currency', currency],
      ['total', total.value],
    ] as const
  )
    .filter(([, value]) => value === null)
    .map(([field]) => field);
  if (missing.length > 0 || !finalMerchant || !finalDate || !currency || !total.value) {
    return err({ kind: 'missing', fields: missing });
  }

  const confirmed: ConfirmedReading = {
    merchant: finalMerchant,
    date: finalDate,
    currency,
    total: total.value,
    taxTotal: taxTotal.value,
    tip: tip.value,
  };

  // Only what the person actually changed counts as a correction.
  const changed: Correction[] = [];
  const note = (field: CorrectableField, read: string | null, corrected: string) => {
    if (corrections[field] !== undefined && read !== corrected) {
      changed.push({ field, read, corrected });
    }
  };
  note('merchant', reading?.merchant?.value ?? null, confirmed.merchant);
  note('date', reading?.date?.value ?? null, confirmed.date);
  note('currency', readCurrency, confirmed.currency);
  for (const field of ['total', 'taxTotal', 'tip'] as const) {
    const read = reading?.[field]?.value ?? null;
    const now = confirmed[field];
    // A zero entered for a tax or tip the receipt doesn't print is what was shown already.
    const shown = read ?? (field !== 'total' && assumed.includes(field) ? zero(currency) : null);
    if (now && !(shown && equals(shown, now))) {
      note(field, read ? toDecimal(read) : null, toDecimal(now));
    }
  }
  return ok({ confirmed, corrections: changed });
}
