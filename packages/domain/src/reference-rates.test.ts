import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { divRound } from './decimal.ts';
import { convert } from './fx.ts';
import { money } from './money.ts';
import {
  ECB_CURRENCIES,
  euroRate,
  hasReferenceRate,
  lookbackDays,
  referenceRate,
  referenceRateDue,
  REFERENCE_RATE_LOOKBACK_DAYS,
  REFERENCE_RATE_SOURCE,
} from './reference-rates.ts';

// What the ECB published on Friday 25 September 2026, and on Monday the 28th.
const FRIDAY = [
  euroRate({ currency: 'USD', date: '2026-09-25', rate: '1.1712' }),
  euroRate({ currency: 'GBP', date: '2026-09-25', rate: '0.87265' }),
  euroRate({ currency: 'JPY', date: '2026-09-25', rate: '174.79' }),
];
const MONDAY = [
  euroRate({ currency: 'USD', date: '2026-09-28', rate: '1.1723' }),
  euroRate({ currency: 'GBP', date: '2026-09-28', rate: '0.87301' }),
];
const RATES = [...FRIDAY, ...MONDAY];

describe('the reference rate for a purchase (Q25, ADR-0034)', () => {
  it('takes the purchase date’s own rate, against the euro as published', () => {
    expect(referenceRate(RATES, 'EUR', 'USD', '2026-09-28')).toEqual({
      base: 'EUR',
      quote: 'USD',
      rate: '1.1723',
      asOf: '2026-09-28',
      source: REFERENCE_RATE_SOURCE,
    });
  });

  it('uses the last rate published before a weekend, and records that rate’s own date', () => {
    for (const sunday of ['2026-09-26', '2026-09-27']) {
      const rate = referenceRate(RATES, 'EUR', 'USD', sunday);
      expect(rate).toMatchObject({ rate: '1.1712', asOf: '2026-09-25' });
    }
  });

  it('crosses two currencies through the euro, to ten significant digits', () => {
    expect(referenceRate(RATES, 'USD', 'EUR', '2026-09-27')?.rate).toBe('0.8538251366');
    expect(referenceRate(RATES, 'GBP', 'USD', '2026-09-27')?.rate).toBe('1.342118833');
    expect(referenceRate(RATES, 'JPY', 'USD', '2026-09-27')?.rate).toBe('0.006700612163');
    expect(referenceRate(RATES, 'USD', 'JPY', '2026-09-27')?.rate).toBe('149.2400956');
  });

  it('gives the converted amount exactly from the stored rate alone', () => {
    const rate = referenceRate(RATES, 'EUR', 'USD', '2026-09-28')!;
    expect(convert(money(41280, 'EUR'), rate)).toEqual(money(48393, 'USD'));
    const crossed = referenceRate(RATES, 'GBP', 'USD', '2026-09-26')!;
    expect(convert(money(4520, 'GBP'), crossed)).toEqual(money(6066, 'USD'));
  });

  it('has no rate past the lookback, or for a day both currencies weren’t published', () => {
    expect(REFERENCE_RATE_LOOKBACK_DAYS).toBe(10);
    expect(lookbackDays('2026-10-05')).toHaveLength(11);
    expect(lookbackDays('2026-10-05').at(-1)).toBe('2026-09-25');
    expect(referenceRate(RATES, 'EUR', 'USD', '2026-10-05')).toMatchObject({ asOf: '2026-09-28' });
    expect(referenceRate(FRIDAY, 'EUR', 'USD', '2026-10-05')).toMatchObject({ asOf: '2026-09-25' });
    expect(referenceRate(FRIDAY, 'EUR', 'USD', '2026-10-06')).toBeUndefined();
    expect(referenceRate(RATES, 'EUR', 'USD', '2026-09-24')).toBeUndefined();
    // JPY was not published on the 28th, so a JPY purchase that day crosses Friday's rates.
    expect(referenceRate(RATES, 'JPY', 'GBP', '2026-09-28')).toMatchObject({ asOf: '2026-09-25' });
  });

  it('knows which currencies the source publishes', () => {
    expect(hasReferenceRate('EUR')).toBe(true);
    expect(hasReferenceRate('USD')).toBe(true);
    expect(hasReferenceRate('AED')).toBe(false);
    expect(hasReferenceRate('KWD')).toBe(false);
    expect(ECB_CURRENCIES.has('EUR')).toBe(false);
  });

  it('waits for the day after a purchase, when that day’s rate is published', () => {
    expect(referenceRateDue('2026-10-04', new Date('2026-10-04T23:59:59Z'))).toBe(false);
    expect(referenceRateDue('2026-10-04', new Date('2026-10-05T00:00:00Z'))).toBe(true);
    expect(referenceRateDue('2026-10-09', new Date('2026-10-05T12:00:00Z'))).toBe(false);
  });

  it('refuses a published rate of zero, or on a day that doesn’t exist', () => {
    expect(() => euroRate({ currency: 'USD', date: '2026-09-25', rate: '0' })).toThrow(/positive/);
    expect(() => euroRate({ currency: 'USD', date: '2026-02-30', rate: '1.1' })).toThrow(/date/);
    expect(() => euroRate({ currency: 'XXX', date: '2026-09-25', rate: '1.1' })).toThrow(
      /Unsupported/,
    );
  });

  it('converts up to 100,000.00 within a cent of the exact cross rate', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 5_000, max: 200_000 }),
        fc.integer({ min: 5_000, max: 200_000 }),
        fc.integer({ min: 0, max: 10_000_000 }),
        (toUnits, fromUnits, amount) => {
          // Rates of 0.5 to 20 to the euro with four decimals, as the ECB publishes most.
          const dec = (u: number) =>
            `${Math.trunc(u / 10_000)}.${String(u % 10_000).padStart(4, '0')}`;
          const rates = [
            euroRate({ currency: 'USD', date: '2026-09-25', rate: dec(toUnits) }),
            euroRate({ currency: 'GBP', date: '2026-09-25', rate: dec(fromUnits) }),
          ];
          const rate = referenceRate(rates, 'GBP', 'USD', '2026-09-25')!;
          const stored = convert(money(amount, 'GBP'), rate).amountMinor;
          const exact = divRound(BigInt(amount) * BigInt(toUnits), BigInt(fromUnits), 'half-even');
          expect(Math.abs(stored - Number(exact))).toBeLessThanOrEqual(1);
        },
      ),
    );
  });
});
