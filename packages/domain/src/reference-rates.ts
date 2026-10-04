import { assertCurrency, type CurrencyCode } from './currency.ts';
import { assertIsoDate, daysBetween, type IsoDate } from './dates.ts';
import { divRound, formatUnits, parseDecimal, pow10 } from './decimal.ts';
import { fxRate, type FxRate } from './fx.ts';

/**
 * Where reference rates come from: the European Central Bank's euro foreign exchange reference
 * rates, published each working day at about 16:00 CET, free and with no key (ADR-0034).
 */
export const REFERENCE_RATE_SOURCE = 'ECB';

/** The currencies of ours the ECB publishes against the euro. Any other stays unconverted. */
// prettier-ignore
export const ECB_CURRENCIES: ReadonlySet<CurrencyCode> = new Set<CurrencyCode>([
  'AUD', 'BRL', 'CAD', 'CHF', 'CNY', 'CZK', 'DKK', 'GBP', 'HKD', 'HUF', 'IDR', 'ILS', 'INR',
  'ISK', 'JPY', 'KRW', 'MXN', 'MYR', 'NOK', 'NZD', 'PHP', 'PLN', 'SEK', 'SGD', 'THB', 'TRY',
  'USD', 'ZAR',
]);

/**
 * How many days before a purchase the last published rate may be. A weekend, or a holiday such
 * as Easter (Good Friday to Easter Monday), has no rate of its own, so the last one before it
 * applies; past this, the source has no rate for the day.
 */
export const REFERENCE_RATE_LOOKBACK_DAYS = 10;

/** Significant digits a rate crossed through the euro is kept to, before it is stored. */
export const CROSS_RATE_DIGITS = 10;

/** Whether the source publishes a rate for this currency: the euro, or one it quotes. */
export function hasReferenceRate(currency: CurrencyCode): boolean {
  return currency === 'EUR' || ECB_CURRENCIES.has(currency);
}

/** A published rate: one euro bought `rate` of `currency` on `date`. */
export interface EuroRate {
  readonly currency: CurrencyCode;
  readonly date: IsoDate;
  readonly rate: string;
}

export function euroRate(input: { currency: string; date: string; rate: string }): EuroRate {
  // fxRate refuses a rate of zero or less, and checks the date.
  const checked = fxRate({
    base: 'EUR',
    quote: input.currency,
    rate: input.rate,
    asOf: input.date,
    source: REFERENCE_RATE_SOURCE,
  });
  return Object.freeze({ currency: checked.quote, date: checked.asOf, rate: checked.rate });
}

/**
 * Whether a purchase's own rate can be published yet. The ECB publishes a day's rate that
 * afternoon, so a purchase dated today, or later, waits for tomorrow rather than taking the
 * rate of the day before (Q25: the purchase date's rate).
 */
export function referenceRateDue(purchaseDate: IsoDate, now: Date): boolean {
  return daysBetween(purchaseDate, now.toISOString().slice(0, 10)) >= 1;
}

/** The days a purchase's rate may come from: its own and the lookback before it, newest first. */
export function lookbackDays(purchaseDate: IsoDate): IsoDate[] {
  const [y = 0, m = 1, d = 1] = assertIsoDate(purchaseDate).split('-').map(Number);
  return Array.from({ length: REFERENCE_RATE_LOOKBACK_DAYS + 1 }, (_, back) =>
    new Date(Date.UTC(y, m - 1, d - back)).toISOString().slice(0, 10),
  );
}

/** `numerator / denominator` to `digits` significant digits, half-even, as a plain decimal. */
function significant(numerator: bigint, denominator: bigint, digits: number): string {
  // The quotient's integer digits: 10^k <= n/d < 10^(k+1).
  let k = numerator.toString().length - denominator.toString().length;
  const atLeast = (exp: number) =>
    exp >= 0 ? numerator >= denominator * pow10(exp) : numerator * pow10(-exp) >= denominator;
  if (!atLeast(k)) k--;
  const scale = Math.max(0, digits - 1 - k);
  const units = divRound(numerator * pow10(scale), denominator, 'half-even');
  const text = formatUnits(units, scale);
  return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text;
}

/**
 * The reference rate for a purchase in `from`, reimbursed in `to` (Q25): the rate published on
 * the purchase date, or on the last day before it that the source published both currencies,
 * at most REFERENCE_RATE_LOOKBACK_DAYS back. Its date is the day it was published, not the
 * purchase date. Crossed through the euro and kept to CROSS_RATE_DIGITS significant digits,
 * so the stored rate alone gives the converted amount. Undefined when no rate is in reach.
 */
export function referenceRate(
  rates: readonly EuroRate[],
  from: CurrencyCode,
  to: CurrencyCode,
  purchaseDate: IsoDate,
): FxRate | undefined {
  const base = assertCurrency(from);
  const quote = assertCurrency(to);
  const on = (currency: CurrencyCode, date: IsoDate) =>
    currency === 'EUR'
      ? { units: 1n, scale: 0 }
      : (() => {
          const found = rates.find((r) => r.currency === currency && r.date === date);
          return found ? parseDecimal(found.rate) : undefined;
        })();
  for (const date of lookbackDays(purchaseDate)) {
    const eurToBase = on(base, date);
    const eurToQuote = on(quote, date);
    if (!eurToBase || !eurToQuote) continue;
    // One `from` buys eurToQuote / eurToBase of `to`.
    const numerator = eurToQuote.units * pow10(eurToBase.scale);
    const denominator = eurToBase.units * pow10(eurToQuote.scale);
    return fxRate({
      base,
      quote,
      rate: significant(numerator, denominator, CROSS_RATE_DIGITS),
      asOf: date,
      source: REFERENCE_RATE_SOURCE,
    });
  }
  return undefined;
}
