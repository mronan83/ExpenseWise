import { daysBetween, isIsoDate, type IsoDate } from './dates.ts';
import { divRound, formatUnits, parseDecimal, pow10, toSafeInteger } from './decimal.ts';
import { DomainError } from './errors.ts';
import {
  IRS_BUSINESS_RATES,
  MILEAGE_DAYS_AHEAD,
  plainMiles,
  quoteMileage,
  rateOn,
  type MileageProblem,
  type MileageRate,
  type MileageRateTable,
  type MileageReimbursement,
} from './mileage.ts';
import { JUSTIFICATION_MAX } from './reports.ts';
import { err, ok, type Result } from './result.ts';

/*
 * Route-based mileage (FR-CAP-04, ADR-0039): a drive given as its start, its stops in order and
 * its end, measured by a routing service. The service's distance is in metres; the claim is in
 * miles, worked out here with integer arithmetic, then paid at the rate in force on the drive's
 * date by the same rules as a drive logged by hand (ADR-0038).
 */

/**
 * Where a route drive's measurement stands: being measured, measured, or not measured, with
 * the reason in plain words for the person to fix the stops or enter the miles by hand.
 */
export const ROUTE_STATUSES = ['measuring', 'measured', 'failed'] as const;
export type RouteStatus = (typeof ROUTE_STATUSES)[number];

/** The routing services a drive can be measured by. */
export const ROUTE_PROVIDERS = ['openrouteservice'] as const;
export type RouteProvider = (typeof ROUTE_PROVIDERS)[number];

/** How OpenRouteService is asked to route: by car. */
export const ROUTE_PROFILE = 'driving-car';

/** An international mile is exactly 1,609.344 metres: 1,609,344 millimetres. */
export const MILLIMETRES_PER_MILE = 1_609_344;

/** Most places one drive goes through, its start and end included (R-ROUTE-STOPS). */
export const ROUTE_MAX_STOPS = 25;

/** Longest address kept for a stop or a saved place: as long as a drive's destination. */
export const ROUTE_ADDRESS_MAX = 200;

/** Longest reason for claiming other miles than were measured (R-MILES-REASON-MAX). */
export const ROUTE_REASON_MAX = 500;

/** Longest name of a saved place, such as Home or Office. */
export const PLACE_NAME_MAX = 40;

/** Shown wherever a measured route is, as OpenRouteService's terms ask (ADR-0039). */
export const ROUTE_ATTRIBUTION =
  'Route © openrouteservice.org by HeiGIT · Map data © OpenStreetMap contributors';

/**
 * Miles from whole metres, to the hundredth of a mile, rounded half up: 1,609 m is 1 mile and
 * 61,800 m is 38.4. metres × 100 ÷ 1,609.344 is metres × 100,000 ÷ 1,609,344, exactly.
 */
export function milesFromMetres(metres: number): string {
  if (!Number.isSafeInteger(metres) || metres < 0) {
    throw new DomainError('invalid_distance', `Not a distance in whole metres: ${metres}`);
  }
  const hundredths = divRound(BigInt(metres) * 100_000n, BigInt(MILLIMETRES_PER_MILE), 'half-up');
  return plainMiles(formatUnits(hundredths, 2));
}

/** The furthest a routing service is believed for one leg: a million kilometres. */
const METRES_BELIEVED = 1_000_000_000;

/**
 * A distance a routing service gave in metres, such as 12345.6, to the whole metre, rounded
 * half up. It is read through its decimal digits, never rounded as a float.
 */
export function wholeMetres(distance: number): number {
  if (!Number.isFinite(distance) || distance < 0 || distance > METRES_BELIEVED) {
    throw new DomainError('invalid_distance', `Not a distance in metres: ${distance}`);
  }
  const text = distance.toString();
  const d = parseDecimal(/e/i.test(text) ? distance.toFixed(6) : text);
  return toSafeInteger(divRound(d.units, pow10(d.scale), 'half-up'));
}

/** The points a route goes through, in order: a round trip ends back at its start. */
export function routePoints<T>(stops: readonly T[], roundTrip: boolean): T[] {
  const [start] = stops;
  return roundTrip && start !== undefined ? [...stops, start] : [...stops];
}

export const ROUTE_FIELDS = ['date', 'purpose', 'stops', 'roundTrip'] as const;
export type RouteField = (typeof ROUTE_FIELDS)[number];

/** What is wrong with a route drive, a claimed distance or a saved place, and where. */
export interface RouteProblem {
  readonly field: RouteField | 'miles' | 'reason' | 'name' | 'address';
  readonly message: string;
  /** The stop it is about, from 0 for the start. */
  readonly stop?: number;
}

const problem = (field: RouteProblem['field'], message: string, stop?: number) =>
  err<RouteProblem>(stop === undefined ? { field, message } : { field, message, stop });

/** "the start", "stop 2", "the end": how a person finds a stop on the form. */
export function stopName(index: number, count: number): string {
  if (index === 0) return 'the start';
  if (index === count - 1) return 'the end';
  return `stop ${index + 1}`;
}

/**
 * The stops as typed, each trimmed: a start and an end at least, at most ROUTE_MAX_STOPS, each
 * one an address of up to ROUTE_ADDRESS_MAX characters. Each address is sent as typed to the
 * routing service whenever the drive is measured; nothing else is (Q32).
 */
export function checkRouteStops(typed: readonly string[]): Result<string[], RouteProblem> {
  if (typed.length < 2) return problem('stops', 'Enter where the drive starts and where it ends.');
  if (typed.length > ROUTE_MAX_STOPS) {
    return problem(
      'stops',
      `A drive goes through at most ${ROUTE_MAX_STOPS} places, its start and end included: log a longer one in parts.`,
    );
  }
  const stops: string[] = [];
  for (const [i, raw] of typed.entries()) {
    const address = raw.trim().replace(/\s+/g, ' ');
    const name = stopName(i, typed.length);
    if (address === '') return problem('stops', `Enter the address of ${name}, or remove it.`, i);
    if (address.length > ROUTE_ADDRESS_MAX) {
      return problem('stops', `Keep the address of ${name} to ${ROUTE_ADDRESS_MAX} characters.`, i);
    }
    stops.push(address);
  }
  return ok(stops);
}

/** A route drive: when, why and where it went. */
export interface RouteDriveValues {
  readonly date: IsoDate;
  /** Why the drive was for business. It is also its expense's justification. */
  readonly purpose: string;
  /** The addresses as typed, start first and end last. */
  readonly stops: readonly string[];
  /** It returns to the start after the end. */
  readonly roundTrip: boolean;
}

/** What a person typed. A field left out stays as it is. */
export interface RouteDriveInput {
  readonly date?: string;
  readonly purpose?: string;
  readonly stops?: readonly string[];
  readonly roundTrip?: boolean;
}

export interface RouteDriveChange {
  readonly field: RouteField;
  readonly from: string | boolean | readonly string[] | null;
  readonly to: string | boolean | readonly string[];
}

const sameStops = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((s, i) => s === b[i]);

/**
 * Applies what a person typed to a route drive, or makes a new one when there is none (a new
 * one needs its date, purpose and stops). The date takes the same checks as a drive logged by
 * hand: a real day, at most MILEAGE_DAYS_AHEAD after today, with a rate in `table`, and `rate`
 * is that day's rate whenever the date is new. `remeasure` says the stops or the round trip
 * changed, so the drive is measured again; nothing else ever measures it again (Q33).
 */
export function applyRouteDriveInput(
  current: RouteDriveValues | null,
  input: RouteDriveInput,
  today: IsoDate,
  table: MileageRateTable = IRS_BUSINESS_RATES,
): Result<
  {
    readonly values: RouteDriveValues;
    readonly changes: RouteDriveChange[];
    readonly remeasure: boolean;
    /** The rate in force on the drive's date, when the date is new or changed. */
    readonly rate: MileageRate | null;
  },
  RouteProblem | MileageProblem
> {
  let date = current?.date;
  if (input.date !== undefined) {
    const typed = input.date.trim();
    if (!isIsoDate(typed)) return problem('date', 'Enter a date as YYYY-MM-DD.');
    if (daysBetween(today, typed) > MILEAGE_DAYS_AHEAD) {
      return problem('date', 'Log a drive once it is made: the date can’t be after today.');
    }
    date = typed;
  }
  let purpose = current?.purpose;
  if (input.purpose !== undefined) {
    purpose = input.purpose.trim();
    if (purpose === '') return problem('purpose', 'Say what the drive was for.');
    if (purpose.length > JUSTIFICATION_MAX) {
      return problem('purpose', `Keep it to ${JUSTIFICATION_MAX} characters.`);
    }
  }
  let stops = current?.stops;
  if (input.stops !== undefined) {
    const checked = checkRouteStops(input.stops);
    if (!checked.ok) return checked;
    stops = checked.value;
  }
  const roundTrip = input.roundTrip ?? current?.roundTrip ?? false;
  if (date === undefined) return problem('date', 'Enter the date.');
  if (purpose === undefined) return problem('purpose', 'Enter what the drive was for.');
  if (stops === undefined) {
    return problem('stops', 'Enter where the drive starts and where it ends.');
  }
  const values: RouteDriveValues = { date, purpose, stops, roundTrip };

  const changes: RouteDriveChange[] = [];
  if (current?.date !== date)
    changes.push({ field: 'date', from: current?.date ?? null, to: date });
  if (current?.purpose !== purpose) {
    changes.push({ field: 'purpose', from: current?.purpose ?? null, to: purpose });
  }
  if (!current || !sameStops(current.stops, stops)) {
    changes.push({ field: 'stops', from: current?.stops ?? null, to: stops });
  }
  if (current && current.roundTrip !== roundTrip) {
    changes.push({ field: 'roundTrip', from: current.roundTrip, to: roundTrip });
  }
  let rate: MileageRate | null = null;
  if (changes.some((c) => c.field === 'date')) {
    const inForce = rateOn(date, table);
    if (!inForce.ok) return inForce;
    rate = inForce.value;
  }
  const remeasure = changes.some((c) => c.field === 'stops' || c.field === 'roundTrip');
  return ok({ values, changes, remeasure, rate });
}

/**
 * The miles a person claims for a route drive (Q33), priced at the rate in force on its date
 * as a drive logged by hand is. Claiming the miles measured needs no reason, and drops one;
 * other miles, or miles for a drive that could not be measured, need a reason.
 */
export function claimRouteMiles(
  input: { readonly miles: string; readonly reason?: string | null },
  measured: string | null,
  date: IsoDate,
  today: IsoDate,
  table: MileageRateTable = IRS_BUSINESS_RATES,
): Result<
  { readonly miles: string; readonly reason: string | null; readonly claim: MileageReimbursement },
  RouteProblem | MileageProblem
> {
  const quote = quoteMileage({ date, miles: input.miles }, today, table);
  if (!quote.ok) return quote;
  const claim = quote.value;
  const miles = claim.distance;
  if (measured !== null && miles === plainMiles(measured)) {
    return ok({ miles, reason: null, claim });
  }
  const reason = input.reason?.trim() ?? '';
  if (reason === '') {
    return problem(
      'reason',
      measured === null
        ? 'Say why you are entering the miles by hand.'
        : `Say why you claim ${miles} miles rather than the ${plainMiles(measured)} measured.`,
    );
  }
  if (reason.length > ROUTE_REASON_MAX) {
    return problem('reason', `Keep the reason to ${ROUTE_REASON_MAX} characters.`);
  }
  return ok({ miles, reason, claim });
}

/** A place a member keeps to start or end drives from, such as Home or Office. */
export interface SavedPlaceValues {
  readonly name: string;
  readonly address: string;
}

/** A saved place as typed, or changed: a name and an address, each trimmed. */
export function applyPlaceInput(
  current: SavedPlaceValues | null,
  input: { readonly name?: string; readonly address?: string },
): Result<SavedPlaceValues, RouteProblem> {
  const name = (input.name ?? current?.name ?? '').trim().replace(/\s+/g, ' ');
  if (name === '') return problem('name', 'Give the place a name, such as Home or Office.');
  if (name.length > PLACE_NAME_MAX) {
    return problem('name', `Keep the name to ${PLACE_NAME_MAX} characters.`);
  }
  const address = (input.address ?? current?.address ?? '').trim().replace(/\s+/g, ' ');
  if (address === '') return problem('address', 'Enter the place’s address.');
  if (address.length > ROUTE_ADDRESS_MAX) {
    return problem('address', `Keep the address to ${ROUTE_ADDRESS_MAX} characters.`);
  }
  return ok({ name, address });
}
