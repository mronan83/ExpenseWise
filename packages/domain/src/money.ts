import { assertCurrency, minorUnits, type CurrencyCode } from './currency.ts';
import { formatUnits, parseDecimal, toSafeInteger, toScale, type RoundingMode } from './decimal.ts';
import { DomainError } from './errors.ts';

/**
 * An exact amount of money: an integer count of the currency's minor unit
 * (cents for USD, yen for JPY, fils for KWD). Floats never represent money.
 */
export interface Money {
  readonly amountMinor: number;
  readonly currency: CurrencyCode;
}

export function money(amountMinor: number, currency: string): Money {
  if (!Number.isSafeInteger(amountMinor)) {
    throw new DomainError(
      'invalid_amount',
      `Amount must be a safe integer of minor units, got ${amountMinor}`,
    );
  }
  // Normalize -0 so equal amounts serialize identically.
  return Object.freeze({
    amountMinor: amountMinor === 0 ? 0 : amountMinor,
    currency: assertCurrency(currency),
  });
}

export function zero(currency: string): Money {
  return money(0, currency);
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new DomainError('currency_mismatch', `Cannot combine ${a.currency} with ${b.currency}`);
  }
}

export function add(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amountMinor + b.amountMinor, a.currency);
}

export function subtract(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amountMinor - b.amountMinor, a.currency);
}

export function negate(a: Money): Money {
  return money(-a.amountMinor, a.currency);
}

export function sum(currency: string, amounts: readonly Money[]): Money {
  return amounts.reduce(add, zero(currency));
}

export function compare(a: Money, b: Money): -1 | 0 | 1 {
  assertSameCurrency(a, b);
  return a.amountMinor < b.amountMinor ? -1 : a.amountMinor > b.amountMinor ? 1 : 0;
}

export function equals(a: Money, b: Money): boolean {
  return a.currency === b.currency && a.amountMinor === b.amountMinor;
}

export function isZero(a: Money): boolean {
  return a.amountMinor === 0;
}

export function isNegative(a: Money): boolean {
  return a.amountMinor < 0;
}

/**
 * Builds Money from a decimal string such as "489.36".
 * By default refuses extra precision ("1.234" USD) rather than rounding it away.
 */
export function fromDecimal(
  amount: string,
  currency: string,
  rounding: RoundingMode | 'exact' = 'exact',
): Money {
  const code = assertCurrency(currency);
  return money(toSafeInteger(toScale(parseDecimal(amount), minorUnits(code), rounding)), code);
}

/** The plain decimal form: 48936 USD → "489.36", 1200 JPY → "1200". */
export function toDecimal(amount: Money): string {
  return formatUnits(BigInt(amount.amountMinor), minorUnits(amount.currency));
}

/** Locale-formatted for display, e.g. "$489.36". Formats the exact decimal string, not a float. */
export function format(amount: Money, locale = 'en-US'): string {
  const digits = minorUnits(amount.currency);
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: amount.currency,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(toDecimal(amount) as `${number}`);
}

/**
 * Splits `total` across integer `weights` so the shares always sum exactly to `total`.
 * Largest-remainder method; ties go to the earlier weight. A zero weight gets zero.
 */
export function allocate(total: Money, weights: readonly number[]): Money[] {
  if (weights.length === 0) {
    throw new DomainError('invalid_weights', 'At least one weight is required');
  }
  if (weights.some((w) => !Number.isSafeInteger(w) || w < 0)) {
    throw new DomainError('invalid_weights', 'Weights must be non-negative integers');
  }
  const weightSum = weights.reduce((acc, w) => acc + w, 0);
  if (weightSum === 0 || !Number.isSafeInteger(weightSum)) {
    throw new DomainError('invalid_weights', 'Weights must sum to a positive safe integer');
  }

  const sign = total.amountMinor < 0 ? -1n : 1n;
  const magnitude = BigInt(Math.abs(total.amountMinor));
  const divisor = BigInt(weightSum);
  const shares = weights.map((w) => (magnitude * BigInt(w)) / divisor);
  let leftover = magnitude - shares.reduce((acc, s) => acc + s, 0n);

  const byRemainder = weights
    .map((w, index) => ({ index, remainder: (magnitude * BigInt(w)) % divisor }))
    .sort((a, b) =>
      a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1,
    );
  for (const { index } of byRemainder) {
    if (leftover === 0n) break;
    shares[index] = (shares[index] ?? 0n) + 1n;
    leftover -= 1n;
  }
  return shares.map((share) => money(Number(share * sign), total.currency));
}

/**
 * Splits `total` across integer `weights` in proportion, so the shares always sum exactly to
 * `total`: each share is the total times its weight over the weights’ sum, rounded down, and
 * the largest share takes every unit left over (Q39), ties to the earlier weight. A weight may
 * be negative, as a discount line is, and takes a negative share; a zero weight gets zero. The
 * weights must sum to more than zero. A negative total is split as its size, then negated.
 */
export function allocateToLargest(total: Money, weights: readonly number[]): Money[] {
  if (weights.length === 0) {
    throw new DomainError('invalid_weights', 'At least one weight is required');
  }
  if (weights.some((w) => !Number.isSafeInteger(w))) {
    throw new DomainError('invalid_weights', 'Weights must be integers');
  }
  const divisor = weights.reduce((acc, w) => acc + BigInt(w), 0n);
  if (divisor <= 0n) {
    throw new DomainError('invalid_weights', 'Weights must sum to more than zero');
  }
  const sign = total.amountMinor < 0 ? -1n : 1n;
  const magnitude = BigInt(Math.abs(total.amountMinor));
  // Rounded down, toward minus infinity, so a negative weight's share is rounded down too.
  const shares = weights.map((w) => {
    const product = magnitude * BigInt(w);
    const share = product / divisor;
    return product % divisor !== 0n && product < 0n ? share - 1n : share;
  });
  const leftover = magnitude - shares.reduce((acc, s) => acc + s, 0n);
  const largest = weights.reduce((best, w, i) => (w > (weights[best] ?? 0) ? i : best), 0);
  shares[largest] = (shares[largest] ?? 0n) + leftover;
  return shares.map((share) => money(Number(share * sign), total.currency));
}

/** Splits `total` into `parts` shares that differ by at most one minor unit. */
export function splitEvenly(total: Money, parts: number): Money[] {
  if (!Number.isSafeInteger(parts) || parts < 1) {
    throw new DomainError('invalid_parts', 'Parts must be a positive integer');
  }
  return allocate(
    total,
    Array.from({ length: parts }, () => 1),
  );
}
