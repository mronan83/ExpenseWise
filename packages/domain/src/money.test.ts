import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { SUPPORTED_CURRENCIES, assertCurrency, isCurrencyCode, minorUnits } from './currency.ts';
import {
  add,
  allocate,
  allocateToLargest,
  compare,
  equals,
  format,
  fromDecimal,
  isNegative,
  isZero,
  money,
  negate,
  splitEvenly,
  subtract,
  sum,
  toDecimal,
  zero,
} from './money.ts';

const usd = (cents: number) => money(cents, 'USD');
const safeAmount = fc.integer({ min: -1_000_000_000_000, max: 1_000_000_000_000 });

describe('currency', () => {
  it('knows minor units', () => {
    expect(minorUnits('USD')).toBe(2);
    expect(minorUnits('JPY')).toBe(0);
    expect(minorUnits('KWD')).toBe(3);
  });

  it('rejects unsupported codes', () => {
    expect(isCurrencyCode('usd')).toBe(false);
    expect(isCurrencyCode('toString')).toBe(false);
    expect(() => assertCurrency('XXX')).toThrow(/Unsupported currency/);
  });
});

describe('money', () => {
  it.each([1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'rejects non-integer amount %d',
    (amount) => {
      expect(() => usd(amount)).toThrow(/safe integer/);
    },
  );

  it('normalizes negative zero', () => {
    expect(Object.is(usd(-0).amountMinor, 0)).toBe(true);
  });

  it('adds, subtracts, negates and sums within one currency', () => {
    expect(add(usd(42720), usd(7263))).toEqual(usd(49983));
    expect(subtract(usd(100), usd(250))).toEqual(usd(-150));
    expect(negate(usd(5))).toEqual(usd(-5));
    expect(sum('USD', [usd(41220), usd(2688), usd(3145)])).toEqual(usd(47053));
    expect(sum('USD', [])).toEqual(zero('USD'));
  });

  it('refuses to mix currencies', () => {
    expect(() => add(usd(1), money(1, 'EUR'))).toThrow(/Cannot combine USD with EUR/);
    expect(() => compare(usd(1), money(1, 'EUR'))).toThrow(/Cannot combine/);
  });

  it('compares and tests amounts', () => {
    expect(compare(usd(1), usd(2))).toBe(-1);
    expect(compare(usd(2), usd(2))).toBe(0);
    expect(compare(usd(3), usd(2))).toBe(1);
    expect(equals(usd(2), usd(2))).toBe(true);
    expect(equals(usd(2), money(2, 'EUR'))).toBe(false);
    expect(isZero(zero('USD'))).toBe(true);
    expect(isNegative(usd(-1))).toBe(true);
    expect(isNegative(usd(0))).toBe(false);
  });
});

describe('decimal conversion', () => {
  it.each([
    ['489.36', 'USD', 48936],
    ['1200', 'JPY', 1200],
    ['1.234', 'KWD', 1234],
    ['-12.5', 'EUR', -1250],
  ])('reads %s %s', (amount, currency, minor) => {
    expect(fromDecimal(amount, currency).amountMinor).toBe(minor);
  });

  it('refuses extra precision unless a rounding mode is given', () => {
    expect(() => fromDecimal('1.234', 'USD')).toThrow(/more than 2 decimal places/);
    expect(fromDecimal('0.125', 'USD', 'half-even').amountMinor).toBe(12);
    expect(fromDecimal('0.125', 'USD', 'half-up').amountMinor).toBe(13);
  });

  it('writes plain decimals', () => {
    expect(toDecimal(usd(48936))).toBe('489.36');
    expect(toDecimal(usd(-5))).toBe('-0.05');
    expect(toDecimal(money(1200, 'JPY'))).toBe('1200');
  });

  it('formats for display without floating-point drift', () => {
    expect(format(usd(48936))).toBe('$489.36');
    expect(format(usd(-125000))).toBe('-$1,250.00');
    expect(format(money(1200, 'JPY'))).toBe('¥1,200');
    expect(format(money(900719925474099, 'USD'))).toBe('$9,007,199,254,740.99');
  });

  it('round-trips through the decimal form for every supported currency', () => {
    fc.assert(
      fc.property(safeAmount, fc.constantFrom(...SUPPORTED_CURRENCIES), (amount, currency) => {
        const m = money(amount, currency);
        expect(fromDecimal(toDecimal(m), currency)).toEqual(m);
      }),
    );
  });
});

describe('allocate', () => {
  it('gives the leftover cent to the earliest share', () => {
    expect(allocate(usd(10000), [1, 1, 1]).map((m) => m.amountMinor)).toEqual([3334, 3333, 3333]);
  });

  it('splits by weight and keeps the sign', () => {
    expect(allocate(usd(-1000), [1, 3]).map((m) => m.amountMinor)).toEqual([-250, -750]);
  });

  it('never gives anything to a zero weight', () => {
    expect(allocate(usd(5), [0, 1, 1]).map((m) => m.amountMinor)).toEqual([0, 3, 2]);
  });

  it.each([[[]], [[0, 0]], [[-1, 2]], [[1.5, 1]]])('rejects weights %j', (weights) => {
    expect(() => allocate(usd(100), weights)).toThrow(/weight/i);
  });

  it('always sums to the total, with each share within one minor unit of its exact value', () => {
    fc.assert(
      fc.property(
        safeAmount,
        fc.array(fc.integer({ min: 0, max: 1000 }), { minLength: 1, maxLength: 12 }),
        (amount, weights) => {
          fc.pre(weights.some((w) => w > 0));
          const total = usd(amount);
          const shares = allocate(total, weights);
          const weightSum = weights.reduce((a, b) => a + b, 0);
          expect(sum('USD', shares)).toEqual(total);
          shares.forEach((share, i) => {
            const exactTimesSum = BigInt(amount) * BigInt(weights[i] ?? 0);
            const error = BigInt(share.amountMinor) * BigInt(weightSum) - exactTimesSum;
            expect((error < 0n ? -error : error) < BigInt(weightSum)).toBe(true);
          });
        },
      ),
    );
  });

  it('splits evenly with shares at most one minor unit apart', () => {
    fc.assert(
      fc.property(safeAmount, fc.integer({ min: 1, max: 50 }), (amount, parts) => {
        const shares = splitEvenly(usd(amount), parts).map((m) => m.amountMinor);
        expect(shares).toHaveLength(parts);
        expect(Math.max(...shares) - Math.min(...shares)).toBeLessThanOrEqual(1);
      }),
    );
    expect(() => splitEvenly(usd(1), 0)).toThrow(/positive integer/);
  });
});

describe('allocateToLargest (Q39, ADR-0041)', () => {
  it('spreads across a discount, a negative weight, and still sums exactly', () => {
    // A 10.00 tax over items of 60.00, 50.00 and a discount of −10.00.
    expect(allocateToLargest(usd(1000), [6000, 5000, -1000]).map((m) => m.amountMinor)).toEqual([
      600, 500, -100,
    ]);
    expect(allocateToLargest(usd(-90), [2, 1]).map((m) => m.amountMinor)).toEqual([-60, -30]);
  });

  it('gives every cent left over to the largest share, ties to the earlier', () => {
    expect(allocateToLargest(usd(100), [1, 1, 1]).map((m) => m.amountMinor)).toEqual([34, 33, 33]);
    expect(allocateToLargest(usd(7), [10, 1, 1, 1]).map((m) => m.amountMinor)).toEqual([
      7, 0, 0, 0,
    ]);
    expect(allocateToLargest(usd(5), [1, 3, 3]).map((m) => m.amountMinor)).toEqual([0, 3, 2]);
  });

  it('always sums to the total, the largest share taking what rounding down leaves', () => {
    fc.assert(
      fc.property(
        safeAmount,
        fc.array(fc.integer({ min: -50_000, max: 500_000 }), { minLength: 1, maxLength: 60 }),
        (amount, weights) => {
          const weightSum = weights.reduce((a, b) => a + b, 0);
          fc.pre(weightSum > 0);
          const shares = allocateToLargest(usd(amount), weights);
          expect(sum('USD', shares)).toEqual(usd(amount));
          const largest = weights.indexOf(Math.max(...weights));
          const size = BigInt(Math.abs(amount));
          const sign = amount < 0 ? -1n : 1n;
          shares.forEach((share, i) => {
            const w = BigInt(weights[i] ?? 0);
            // Every other share is its exact value rounded down, toward minus infinity.
            const below = size * w - BigInt(share.amountMinor) * sign * BigInt(weightSum);
            if (i !== largest) {
              expect(below >= 0n && below < BigInt(weightSum)).toBe(true);
              if (w === 0n) expect(share.amountMinor).toBe(0);
            } else {
              expect(below <= 0n).toBe(true);
              expect(-below < BigInt(weightSum) * BigInt(weights.length)).toBe(true);
            }
          });
        },
      ),
    );
  });

  it.each([[[]], [[0, 0]], [[-2, 1]], [[1.5, 1]]])('refuses weights %j', (weights) => {
    expect(() => allocateToLargest(usd(100), weights)).toThrow(/weight/i);
  });
});
