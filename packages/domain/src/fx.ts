import { assertCurrency, minorUnits, type CurrencyCode } from './currency.ts';
import { assertIsoDate, type IsoDate } from './dates.ts';
import { divRound, parseDecimal, pow10, toSafeInteger, type RoundingMode } from './decimal.ts';
import { DomainError } from './errors.ts';
import { money, type Money } from './money.ts';

/** One unit of `base` buys `rate` units of `quote`, as published by `source` for `asOf`. */
export interface FxRate {
  readonly base: CurrencyCode;
  readonly quote: CurrencyCode;
  readonly rate: string;
  readonly asOf: IsoDate;
  readonly source: string;
}

export function fxRate(input: {
  base: string;
  quote: string;
  rate: string;
  asOf: string;
  source: string;
}): FxRate {
  if (parseDecimal(input.rate).units <= 0n) {
    throw new DomainError('invalid_rate', `FX rate must be positive, got "${input.rate}"`);
  }
  if (input.source.trim() === '') {
    throw new DomainError('invalid_rate', 'FX rate needs a source');
  }
  return Object.freeze({
    base: assertCurrency(input.base),
    quote: assertCurrency(input.quote),
    rate: input.rate,
    asOf: assertIsoDate(input.asOf),
    source: input.source,
  });
}

/**
 * Converts `amount` into the rate's quote currency with exact integer math.
 * Store the rate alongside the result: a converted amount without its rate is unauditable.
 */
export function convert(amount: Money, rate: FxRate, rounding: RoundingMode = 'half-even'): Money {
  if (amount.currency !== rate.base) {
    throw new DomainError(
      'currency_mismatch',
      `Rate converts ${rate.base}, but the amount is in ${amount.currency}`,
    );
  }
  const r = parseDecimal(rate.rate);
  const baseExp = minorUnits(rate.base);
  const quoteExp = minorUnits(rate.quote);
  // quoteMinor = amountMinor × rate × 10^(quoteExp − baseExp)
  let numerator = BigInt(amount.amountMinor) * r.units;
  let denominator = pow10(r.scale);
  if (quoteExp >= baseExp) numerator *= pow10(quoteExp - baseExp);
  else denominator *= pow10(baseExp - quoteExp);
  return money(toSafeInteger(divRound(numerator, denominator, rounding)), rate.quote);
}
