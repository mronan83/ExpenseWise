import { assertCurrency, minorUnits, type CurrencyCode } from './currency.ts';
import { assertIsoDate, daysBetween, isIsoDate, type IsoDate } from './dates.ts';
import { divRound, formatUnits, parseDecimal, pow10, toSafeInteger } from './decimal.ts';
import { DomainError } from './errors.ts';
import { money, type Money } from './money.ts';
import { JUSTIFICATION_MAX } from './reports.ts';
import { err, ok, type Result } from './result.ts';

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

/** Where a rate came from: the IRS standard mileage rate for business use. */
export const IRS_BUSINESS_SOURCE = 'irs-business';

const irs = (perUnit: string, effectiveFrom: string) =>
  mileageRate({ currency: 'USD', perUnit, unit: 'mi', effectiveFrom, source: IRS_BUSINESS_SOURCE });

/** Rates, each from the day it took effect, and the last day they are known for. */
export interface MileageRateTable {
  readonly rates: readonly MileageRate[];
  /** After this day the next rate isn't known yet, so a later date has none. */
  readonly through: IsoDate;
}

/**
 * The last day ExpenseWise holds the IRS rate for. The IRS announces each year's rate in
 * December; until it is added below, a later drive is refused rather than paid at last year's.
 */
export const IRS_BUSINESS_RATES_THROUGH = '2026-12-31';

/**
 * The rates mileage is paid at (ADR-0038): the IRS standard mileage rate for business use, in
 * dollars a mile, each from the day it took effect. 2022's changed on 1 July.
 */
export const IRS_BUSINESS_RATES: MileageRateTable = Object.freeze({
  rates: Object.freeze([
    irs('0.585', '2022-01-01'),
    irs('0.625', '2022-07-01'),
    irs('0.655', '2023-01-01'),
    irs('0.67', '2024-01-01'),
    irs('0.70', '2025-01-01'),
    irs('0.725', '2026-01-01'),
  ]),
  through: IRS_BUSINESS_RATES_THROUGH,
});

/** The most miles one entry claims: a longer drive is logged day by day. */
export const MILEAGE_MAX_MILES = 1000;

/** How many days after today, in UTC, a drive can be dated: for a person ahead of UTC. */
export const MILEAGE_DAYS_AHEAD = 1;

const DESTINATION_MAX = 200;

/** Trailing zeros dropped, keeping at least `keep` decimal places: ("38.40", 0) is "38.4". */
function trimmed(value: string, keep: number): string {
  let { units, scale } = parseDecimal(value);
  while (scale > keep && units % 10n === 0n) {
    units /= 10n;
    scale--;
  }
  return formatUnits(units, scale);
}

/** A rate as shown: "0.7250" is "0.725", and "0.7000" keeps its cents, "0.70". */
export function rateDecimal(rate: Pick<MileageRate, 'perUnit' | 'currency'>): string {
  return trimmed(rate.perUnit, minorUnits(rate.currency));
}

/** Miles as shown and compared: "38.40" is "38.4", and "12.00" is "12". */
export const plainMiles = (miles: string): string => trimmed(miles, 0);

export const MILEAGE_FIELDS = ['date', 'destination', 'purpose', 'miles'] as const;
export type MileageField = (typeof MILEAGE_FIELDS)[number];

/** A drive logged by hand (FR-CAP-03): the elements IRS Publication 463 asks for. */
export interface MileageValues {
  readonly date: IsoDate;
  readonly destination: string;
  /** Why the drive was for business. It is also its expense's justification. */
  readonly purpose: string;
  /** A plain decimal with at most two places, such as "38.4". */
  readonly miles: string;
}

/** What a person typed. A field left out stays as it is. */
export type MileageInput = { readonly [F in MileageField]?: string };

export interface MileageProblem {
  readonly field: MileageField;
  readonly message: string;
}

export interface MileageChange {
  readonly field: MileageField;
  readonly from: string | null;
  readonly to: string;
}

const problem = (field: MileageField, message: string) => err({ field, message });

/** Miles typed as a plain decimal: more than zero, two places at most, within one entry's. */
function checkMiles(typed: string): Result<string, MileageProblem> {
  const text = typed.trim();
  if (!/^\d+(\.\d+)?$/.test(text)) {
    return problem('miles', 'Enter the miles as a number, such as 38.4.');
  }
  const d = parseDecimal(text);
  if (d.scale > 2) return problem('miles', 'Enter the miles to two decimal places at most.');
  if (d.units <= 0n) return problem('miles', 'Enter more than zero miles.');
  if (d.units > BigInt(MILEAGE_MAX_MILES) * pow10(d.scale)) {
    return problem(
      'miles',
      `One entry claims at most ${MILEAGE_MAX_MILES} miles: log a longer drive day by day.`,
    );
  }
  return ok(plainMiles(text));
}

/** The rate in force on `date` in `table`, or why there is none. */
export function rateOn(
  date: IsoDate,
  table: MileageRateTable = IRS_BUSINESS_RATES,
): Result<MileageRate, MileageProblem> {
  if (date > table.through) {
    return problem(
      'date',
      `ExpenseWise doesn’t have the mileage rate for dates after ${table.through} yet.`,
    );
  }
  const first = table.rates.reduce<IsoDate>(
    (min, r) => (r.effectiveFrom < min ? r.effectiveFrom : min),
    table.through,
  );
  if (date < first) return problem('date', `There is no mileage rate before ${first}.`);
  return ok(selectRate(table.rates, date, 'mi'));
}

/** A travel date that exists, isn't after today, and has a rate. */
function checkDate(
  typed: string,
  today: IsoDate,
  table: MileageRateTable,
): Result<IsoDate, MileageProblem> {
  const date = typed.trim();
  if (!isIsoDate(date)) return problem('date', 'Enter a date as YYYY-MM-DD.');
  if (daysBetween(today, date) > MILEAGE_DAYS_AHEAD) {
    return problem('date', 'Log a drive once it is made: the date can’t be after today.');
  }
  const rate = rateOn(date, table);
  return rate.ok ? ok(date) : rate;
}

/**
 * What a drive of `miles` on `date` would pay, before it is logged: the rate in force that day
 * and miles × rate, rounded half-up to the cent.
 */
export function quoteMileage(
  input: { readonly date: string; readonly miles: string },
  today: IsoDate,
  table: MileageRateTable = IRS_BUSINESS_RATES,
): Result<MileageReimbursement, MileageProblem> {
  const date = checkDate(input.date, today, table);
  if (!date.ok) return date;
  const miles = checkMiles(input.miles);
  if (!miles.ok) return miles;
  const rate = rateOn(date.value, table);
  return rate.ok ? ok(reimburse(miles.value, 'mi', rate.value)) : rate;
}

const FIELD_NAMES: Record<MileageField, string> = {
  date: 'the date',
  destination: 'where you drove to',
  purpose: 'what the drive was for',
  miles: 'the miles',
};

/**
 * Applies what a person typed to a mileage entry, or makes a new one when there is none yet
 * (FR-CAP-03): a new one needs all four fields. `claim` is what it pays, worked out at the rate
 * in force on its date when it is new and whenever its date or miles change, and null when
 * they don't, so the rate copied onto it stays (NFR-DAT-04).
 */
export function applyMileageInput(
  current: MileageValues | null,
  input: MileageInput,
  today: IsoDate,
  table: MileageRateTable = IRS_BUSINESS_RATES,
): Result<
  {
    readonly values: MileageValues;
    readonly changes: MileageChange[];
    readonly claim: MileageReimbursement | null;
  },
  MileageProblem
> {
  const text = (
    field: 'destination' | 'purpose',
    max: number,
  ): Result<string | undefined, MileageProblem> => {
    const typed = input[field];
    if (typed === undefined) return ok(current?.[field]);
    const value = typed.trim();
    if (value === '') return problem(field, `Say ${FIELD_NAMES[field]}.`);
    if (value.length > max) return problem(field, `Keep it to ${max} characters.`);
    return ok(value);
  };

  let date = current?.date;
  if (input.date !== undefined) {
    const checked = checkDate(input.date, today, table);
    if (!checked.ok) return checked;
    date = checked.value;
  }
  const destination = text('destination', DESTINATION_MAX);
  if (!destination.ok) return destination;
  const purpose = text('purpose', JUSTIFICATION_MAX);
  if (!purpose.ok) return purpose;
  let miles = current === null ? undefined : plainMiles(current.miles);
  if (input.miles !== undefined) {
    const checked = checkMiles(input.miles);
    if (!checked.ok) return checked;
    miles = checked.value;
  }
  const given = { date, destination: destination.value, purpose: purpose.value, miles };
  const missing = MILEAGE_FIELDS.find((f) => given[f] === undefined);
  if (missing) return problem(missing, `Enter ${FIELD_NAMES[missing]}.`);
  const values = given as MileageValues;

  const was = (field: MileageField) =>
    current === null ? null : field === 'miles' ? plainMiles(current.miles) : current[field];
  const changes = MILEAGE_FIELDS.flatMap((field) =>
    values[field] === was(field) ? [] : [{ field, from: was(field), to: values[field] }],
  );
  const repriced =
    current === null || changes.some((c) => c.field === 'date' || c.field === 'miles');
  if (!repriced) return ok({ values, changes, claim: null });
  const rate = rateOn(values.date, table);
  if (!rate.ok) return rate;
  return ok({ values, changes, claim: reimburse(values.miles, 'mi', rate.value) });
}
