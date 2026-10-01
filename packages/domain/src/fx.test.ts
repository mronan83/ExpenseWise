import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { convert, fxRate } from './fx.ts';
import { money } from './money.ts';

const rate = (base: string, quote: string, value: string) =>
  fxRate({ base, quote, rate: value, asOf: '2026-09-24', source: 'test-fixture' });

describe('convert', () => {
  it.each([
    ['EUR', 'USD', '1.0845', 10000, 10845],
    ['USD', 'JPY', '147.235', 1000, 1472],
    ['JPY', 'USD', '0.0068', 1200, 816],
    ['USD', 'KWD', '0.3071', 10000, 30710],
    ['USD', 'USD', '1', 48936, 48936],
  ])('%s → %s at %s: %d → %d', (base, quote, value, amount, expected) => {
    expect(convert(money(amount, base), rate(base, quote, value))).toEqual(money(expected, quote));
  });

  it('rounds half-even by default and half-up on request', () => {
    const half = rate('USD', 'EUR', '0.5');
    expect(convert(money(5, 'USD'), half).amountMinor).toBe(2);
    expect(convert(money(5, 'USD'), half, 'half-up').amountMinor).toBe(3);
  });

  it('refuses an amount in the wrong currency', () => {
    expect(() => convert(money(1, 'GBP'), rate('EUR', 'USD', '1.1'))).toThrow(/converts EUR/);
  });

  it('validates rates', () => {
    expect(() => rate('EUR', 'USD', '0')).toThrow(/must be positive/);
    expect(() => rate('EUR', 'USD', '-1.1')).toThrow(/must be positive/);
    expect(() =>
      fxRate({ base: 'EUR', quote: 'USD', rate: '1.1', asOf: '2026-02-30', source: 'x' }),
    ).toThrow(/calendar date/);
    expect(() =>
      fxRate({ base: 'EUR', quote: 'USD', rate: '1.1', asOf: '2026-09-24', source: ' ' }),
    ).toThrow(/needs a source/);
  });

  it('is monotonic and nearly additive', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10_000_000_000 }),
        fc.integer({ min: 0, max: 10_000_000_000 }),
        fc.integer({ min: 1, max: 5_000_000 }),
        (a, b, rateMillionths) => {
          const r = rate(
            'EUR',
            'USD',
            `${Math.trunc(rateMillionths / 1_000_000)}.${String(rateMillionths % 1_000_000).padStart(6, '0')}`,
          );
          const ca = convert(money(a, 'EUR'), r).amountMinor;
          const cb = convert(money(b, 'EUR'), r).amountMinor;
          const cab = convert(money(a + b, 'EUR'), r).amountMinor;
          if (a <= b) expect(ca).toBeLessThanOrEqual(cb);
          expect(Math.abs(cab - (ca + cb))).toBeLessThanOrEqual(1);
        },
      ),
    );
  });
});
