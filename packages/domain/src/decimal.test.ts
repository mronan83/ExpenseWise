import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { divRound, formatUnits, parseDecimal, toSafeInteger, toScale } from './decimal.ts';

describe('parseDecimal', () => {
  it.each([
    ['489.36', 48936n, 2],
    ['-0.5', -5n, 1],
    ['1200', 1200n, 0],
    [' 7.10 ', 710n, 2],
  ])('parses %s', (input, units, scale) => {
    expect(parseDecimal(input)).toEqual({ units, scale });
  });

  it.each(['1e5', '1,000', '', '.5', '5.', 'abc', '--1', '0x10'])('rejects %j', (input) => {
    expect(() => parseDecimal(input)).toThrow(/Not a plain decimal/);
  });
});

describe('divRound', () => {
  it.each([
    [5n, 2n, 2n, 3n],
    [7n, 2n, 4n, 4n],
    [-5n, 2n, -2n, -3n],
    [-7n, 2n, -4n, -4n],
    [10n, 4n, 2n, 3n],
    [1n, 3n, 0n, 0n],
    [2n, 3n, 1n, 1n],
    [-2n, 3n, -1n, -1n],
    [5n, -2n, -2n, -3n],
    [6n, 3n, 2n, 2n],
  ])('%d / %d → half-even %d, half-up %d', (n, d, halfEven, halfUp) => {
    expect(divRound(n, d, 'half-even')).toBe(halfEven);
    expect(divRound(n, d, 'half-up')).toBe(halfUp);
  });

  it('refuses division by zero', () => {
    expect(() => divRound(1n, 0n, 'half-even')).toThrow(/Division by zero/);
  });

  it('is never more than half a unit away from the exact quotient', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: -(10n ** 18n), max: 10n ** 18n }),
        fc.bigInt({ min: 1n, max: 10n ** 9n }),
        fc.boolean(),
        fc.constantFrom('half-even' as const, 'half-up' as const),
        (n, dMag, negateD, mode) => {
          const d = negateD ? -dMag : dMag;
          const q = divRound(n, d, mode);
          const error = n - q * d;
          const absError = error < 0n ? -error : error;
          expect(absError * 2n <= dMag).toBe(true);
        },
      ),
    );
  });
});

describe('toScale', () => {
  it('pads to a larger scale', () => {
    expect(toScale(parseDecimal('1.5'), 2, 'exact')).toBe(150n);
  });

  it('refuses to drop digits in exact mode', () => {
    expect(() => toScale(parseDecimal('1.234'), 2, 'exact')).toThrow(/more than 2 decimal places/);
  });

  it('rounds when asked', () => {
    expect(toScale(parseDecimal('0.125'), 2, 'half-even')).toBe(12n);
    expect(toScale(parseDecimal('0.125'), 2, 'half-up')).toBe(13n);
  });
});

describe('formatUnits', () => {
  it.each([
    [5n, 2, '0.05'],
    [-5n, 2, '-0.05'],
    [1200n, 0, '1200'],
    [48936n, 2, '489.36'],
    [0n, 3, '0.000'],
  ])('formats (%d, %d) as %s', (units, scale, expected) => {
    expect(formatUnits(units, scale)).toBe(expected);
  });

  it('round-trips with parseDecimal', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: -(10n ** 15n), max: 10n ** 15n }), fc.nat(6), (units, scale) => {
        expect(parseDecimal(formatUnits(units, scale))).toEqual({ units, scale });
      }),
    );
  });
});

describe('toSafeInteger', () => {
  it('rejects values outside the safe range', () => {
    expect(() => toSafeInteger(BigInt(Number.MAX_SAFE_INTEGER) + 1n)).toThrow(/safe integer/);
    expect(() => toSafeInteger(BigInt(Number.MIN_SAFE_INTEGER) - 1n)).toThrow(/safe integer/);
    expect(toSafeInteger(42n)).toBe(42);
  });
});
