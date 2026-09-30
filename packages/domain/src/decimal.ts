import { DomainError } from './errors.ts';

/**
 * How to round a value that falls exactly halfway between two integers.
 * `half-even` (banker's rounding) avoids bias across many conversions.
 * `half-up` rounds halves away from zero, the convention people expect on a single amount.
 */
export type RoundingMode = 'half-even' | 'half-up';

/** An exact decimal number: `units / 10^scale`. */
export interface Decimal {
  readonly units: bigint;
  readonly scale: number;
}

const DECIMAL_PATTERN = /^(-)?(\d+)(?:\.(\d+))?$/;

/** Parses a plain decimal string such as "489.36" or "-0.5". No exponents, no separators. */
export function parseDecimal(input: string): Decimal {
  const match = DECIMAL_PATTERN.exec(input.trim());
  if (!match) {
    throw new DomainError('invalid_decimal', `Not a plain decimal number: "${input}"`);
  }
  const [, sign, whole = '0', fraction = ''] = match;
  const magnitude = BigInt(`${whole}${fraction}`);
  return { units: sign ? -magnitude : magnitude, scale: fraction.length };
}

export function pow10(exponent: number): bigint {
  return 10n ** BigInt(exponent);
}

/** Integer division with explicit rounding. Never loses precision silently. */
export function divRound(numerator: bigint, denominator: bigint, mode: RoundingMode): bigint {
  if (denominator === 0n) throw new DomainError('division_by_zero', 'Division by zero');
  const n = denominator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  const quotient = n / d; // truncates toward zero
  const remainder = n % d; // carries the sign of n
  if (remainder === 0n) return quotient;
  const twiceRemainder = (remainder < 0n ? -remainder : remainder) * 2n;
  const awayFromZero = n < 0n ? quotient - 1n : quotient + 1n;
  if (twiceRemainder > d) return awayFromZero;
  if (twiceRemainder < d) return quotient;
  if (mode === 'half-up') return awayFromZero;
  return quotient % 2n === 0n ? quotient : awayFromZero;
}

/**
 * Expresses `value` as an integer count of `10^-scale` units.
 * With `exact`, refuses to drop digits instead of rounding them.
 */
export function toScale(value: Decimal, scale: number, rounding: RoundingMode | 'exact'): bigint {
  if (scale >= value.scale) return value.units * pow10(scale - value.scale);
  const divisor = pow10(value.scale - scale);
  if (rounding === 'exact') {
    if (value.units % divisor !== 0n) {
      throw new DomainError(
        'precision_loss',
        `${formatUnits(value.units, value.scale)} has more than ${scale} decimal places`,
      );
    }
    return value.units / divisor;
  }
  return divRound(value.units, divisor, rounding);
}

/** Formats `units / 10^scale` as a plain decimal string, e.g. (48936n, 2) → "489.36". */
export function formatUnits(units: bigint, scale: number): string {
  const negative = units < 0n;
  const digits = (negative ? -units : units).toString().padStart(scale + 1, '0');
  const whole = scale === 0 ? digits : digits.slice(0, -scale);
  const fraction = scale === 0 ? '' : `.${digits.slice(-scale)}`;
  return `${negative ? '-' : ''}${whole}${fraction}`;
}

/** Converts a bigint to a number, refusing values JavaScript can't represent exactly. */
export function toSafeInteger(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new DomainError('amount_out_of_range', `${value} is outside the safe integer range`);
  }
  return Number(value);
}
