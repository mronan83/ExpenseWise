import type { CurrencyCode } from './currency.ts';
import type { IsoDate } from './dates.ts';
import { convert, type FxRate } from './fx.ts';
import { add, zero, type Money } from './money.ts';

/**
 * A conversion as it was recorded on an expense (NFR-DAT-02, NFR-DAT-04): the amount as spent
 * and its purchase date, the currency it was reimbursed in, and either the rate it was
 * converted at, with that rate's date and source, or that the source had no rate for it.
 */
export type ConversionRecord = {
  readonly amount: Money;
  readonly purchaseDate: IsoDate;
  readonly into: CurrencyCode;
} & (
  | { readonly outcome: 'converted'; readonly converted: Money; readonly rate: FxRate }
  | { readonly outcome: 'unavailable'; readonly source: string }
);

/** An amount on a report, in the currency the person is reimbursed in (FR-EXP-13). */
export type Reimbursed =
  /** Already in it, as when a card converted it at purchase (Q22): counted as it is. */
  | { readonly kind: 'same'; readonly amount: Money }
  | {
      readonly kind: 'converted';
      readonly amount: Money;
      readonly converted: Money;
      readonly rate: FxRate;
    }
  /** Its rate isn't recorded yet: the background work is fetching it. */
  | { readonly kind: 'converting'; readonly amount: Money }
  /** The source publishes no rate for it, so it stays as spent and is said so. */
  | { readonly kind: 'unconverted'; readonly amount: Money; readonly source: string };

/**
 * Whether a recorded conversion still applies to an amount: the same currency, purchase date
 * and reimbursement currency. Its rate then holds, whatever rates have done since (NFR-DAT-04).
 */
export function conversionApplies(
  record: ConversionRecord,
  amount: Money,
  purchaseDate: IsoDate,
  into: CurrencyCode,
): boolean {
  return (
    record.amount.currency === amount.currency &&
    record.purchaseDate === purchaseDate &&
    record.into === into
  );
}

/**
 * Whether a recorded conversion is the one for exactly this amount, so nothing needs
 * recording again.
 */
export function conversionCurrent(
  record: ConversionRecord,
  amount: Money,
  purchaseDate: IsoDate,
  into: CurrencyCode,
): boolean {
  return (
    conversionApplies(record, amount, purchaseDate, into) &&
    record.amount.amountMinor === amount.amountMinor
  );
}

/**
 * An amount spent on `purchaseDate`, in the reimbursement currency `into`. A recorded
 * conversion whose currency, date and target still apply gives its rate, even when the amount
 * has been edited since: the rate is what was copied on, and the converted amount follows
 * from it exactly. Without one, the amount is converting.
 */
export function reimbursed(
  amount: Money,
  purchaseDate: IsoDate,
  into: CurrencyCode,
  record?: ConversionRecord,
): Reimbursed {
  if (amount.currency === into) return { kind: 'same', amount };
  if (!record || !conversionApplies(record, amount, purchaseDate, into)) {
    return { kind: 'converting', amount };
  }
  if (record.outcome === 'unavailable') {
    return { kind: 'unconverted', amount, source: record.source };
  }
  return { kind: 'converted', amount, converted: convert(amount, record.rate), rate: record.rate };
}

/** What a report adds up to in the reimbursement currency, and what that leaves out. */
export interface ReimbursementTotal {
  /** The amounts already in it and those converted: what is reimbursed so far. */
  readonly total: Money;
  /** How many amounts are still converting, and so not in the total yet. */
  readonly converting: number;
  /** What the source has no rate for, as spent, one sum per currency. */
  readonly unconverted: readonly Money[];
}

export function reimbursementTotal(
  into: CurrencyCode,
  amounts: readonly Reimbursed[],
): ReimbursementTotal {
  let total = zero(into);
  let converting = 0;
  const unconverted = new Map<string, Money>();
  for (const a of amounts) {
    if (a.kind === 'same') total = add(total, a.amount);
    else if (a.kind === 'converted') total = add(total, a.converted);
    else if (a.kind === 'converting') converting++;
    else {
      const sofar = unconverted.get(a.amount.currency);
      unconverted.set(a.amount.currency, sofar ? add(sofar, a.amount) : a.amount);
    }
  }
  return {
    total,
    converting,
    unconverted: [...unconverted.values()].sort((a, b) => a.currency.localeCompare(b.currency)),
  };
}
