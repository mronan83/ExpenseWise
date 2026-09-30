import { assertCurrency, minorUnits, type CurrencyCode } from './currency.ts';
import { assertIsoDate, type IsoDate } from './dates.ts';
import { divRound, parseDecimal, pow10, toSafeInteger } from './decimal.ts';
import { DomainError } from './errors.ts';
import { money, type Money } from './money.ts';

export const DISTANCE_UNITS = ['mi', 'km'] as const;
export type DistanceUnit = (typeof DISTANCE_UNITS)[number];

/** A reimbursement rate that applies from `effectiveFrom` until a later rate replaces it. */
export interface MileageRate {
  readonly currency: CurrencyCode;
  /** Major currency units per distance unit, e.g. "0.70" dollars per mile. */
  readonly perUnit: string;
  readonly unit: DistanceUnit;
  readonly effectiveFrom: IsoDate;
  /** Where the rate came from, e.g. "org-policy" or "irs-standard". */
  readonly source: string;
}

export function mileageRate(input: {
  currency: string;
  perUnit: string;
  unit: DistanceUnit;
  effectiveFrom: string;
  source: string;
}): MileageRate {
  if (parseDecimal(input.perUnit).units < 0n) {
    throw new DomainError('invalid_rate', 'A mileage rate cannot be negative');
  }
  return Object.freeze({
    currency: assertCurrency(input.currency),
    perUnit: input.perUnit,
    unit: input.unit,
    effectiveFrom: assertIsoDate(input.effectiveFrom),
    source: input.source,
  });
}

/** The rate in force on the travel date: the latest one whose effective date is not after it. */
export function selectRate(
  rates: readonly MileageRate[],
  travelDate: string,
  unit: DistanceUnit,
): MileageRate {
  const date = assertIsoDate(travelDate);
  const inForce = rates.filter((r) => r.unit === unit && r.effectiveFrom <= date);
  const latest = inForce.reduce<MileageRate | undefined>(
    (best, r) => (best === undefined || r.effectiveFrom > best.effectiveFrom ? r : best),
    undefined,
  );
  if (latest === undefined) {
    throw new DomainError('no_mileage_rate', `No ${unit} rate is in effect on ${date}`);
  }
  return latest;
}

export interface MileageReimbursement {
  readonly amount: Money;
  readonly distance: string;
  readonly unit: DistanceUnit;
  /** A copy of the rate used, so a later rate change never alters this claim. */
  readonly rate: MileageRate;
}

/** distance × rate, rounded half-up to the currency's minor unit (38.4 mi × $0.70 = $26.88). */
export function reimburse(
  distance: string,
  unit: DistanceUnit,
  rate: MileageRate,
): MileageReimbursement {
  if (unit !== rate.unit) {
    throw new DomainError(
      'unit_mismatch',
      `Distance is in ${unit} but the rate is per ${rate.unit}`,
    );
  }
  const d = parseDecimal(distance);
  if (d.units < 0n) throw new DomainError('invalid_distance', 'Distance cannot be negative');
  const p = parseDecimal(rate.perUnit);
  const numerator = d.units * p.units * pow10(minorUnits(rate.currency));
  const amountMinor = toSafeInteger(divRound(numerator, pow10(d.scale + p.scale), 'half-up'));
  return Object.freeze({ amount: money(amountMinor, rate.currency), distance, unit, rate });
}
