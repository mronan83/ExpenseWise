import { DomainError } from './errors.ts';

/**
 * ISO 4217 minor-unit exponents for the currencies we support.
 * Add a currency here, with its ISO exponent, before accepting it anywhere.
 */
// prettier-ignore
const MINOR_UNITS = {
  AED: 2, ARS: 2, AUD: 2, BHD: 3, BRL: 2, CAD: 2, CHF: 2, CLP: 0, CNY: 2, COP: 2,
  CZK: 2, DKK: 2, EGP: 2, EUR: 2, GBP: 2, HKD: 2, HUF: 2, IDR: 2, ILS: 2, INR: 2,
  ISK: 0, JOD: 3, JPY: 0, KRW: 0, KWD: 3, MXN: 2, MYR: 2, NOK: 2, NZD: 2, OMR: 3,
  PEN: 2, PHP: 2, PLN: 2, QAR: 2, SAR: 2, SEK: 2, SGD: 2, THB: 2, TND: 3, TRY: 2,
  TWD: 2, USD: 2, VND: 0, ZAR: 2,
} as const satisfies Record<string, number>;

export type CurrencyCode = keyof typeof MINOR_UNITS;

export const SUPPORTED_CURRENCIES = Object.keys(MINOR_UNITS) as readonly CurrencyCode[];

export function isCurrencyCode(value: string): value is CurrencyCode {
  return Object.hasOwn(MINOR_UNITS, value);
}

export function assertCurrency(value: string): CurrencyCode {
  if (!isCurrencyCode(value)) {
    throw new DomainError('unsupported_currency', `Unsupported currency: "${value}"`);
  }
  return value;
}

/** Number of decimal places in the currency's minor unit: USD 2, JPY 0, KWD 3. */
export function minorUnits(currency: CurrencyCode): number {
  return MINOR_UNITS[currency];
}
