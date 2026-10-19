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
  type MileageReimbursement,
  type MileageRates,
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

/** Longest name a person gives a drive, such as Acme visit and the airport (R-ROUTE-NAME-MAX). */
export const ROUTE_NAME_MAX = 80;

/** Longest reason for claiming other miles than were measured (R-MILES-REASON-MAX). */
export const ROUTE_REASON_MAX = 500;

/** Longest name of a saved place, such as Home or Office. */
export const PLACE_NAME_MAX = 40;

/** Longest name the routing service gives a place it found or suggested. */
export const PLACE_LABEL_MAX = 300;

/** Fewest characters typed in a stop before places are suggested for it (R-SUGGEST-MIN). */
export const SUGGEST_MIN_CHARS = 3;

/** How long typing pauses before places are looked up, in milliseconds (R-SUGGEST-WAIT). */
export const SUGGEST_WAIT_MS = 300;

/** Most places suggested for a stop from the routing service (R-SUGGEST-SHOWN). */
export const SUGGEST_SHOWN = 5;

/** How long a suggestion lookup may take before the stop is simply typed (R-SUGGEST-TIMEOUT). */
export const SUGGEST_TIMEOUT_MS = 3_000;

/** Most places a person has driven to that are offered again for a stop (R-RECENT-PLACES). */
export const RECENT_PLACES = 20;

/** Shown wherever suggested places are, as OpenRouteService's terms ask (ADR-0052). */
export const SUGGEST_ATTRIBUTION =
  'Places © openrouteservice.org by HeiGIT · Map data © OpenStreetMap contributors';

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

/**
 * A place picked for a stop from the suggestions (FR-CAP-14, Q53): the drive is measured from
 * exactly here, and the stop's address is never searched again. Degrees to six places, as text.
 */
export interface StopPin {
  readonly label: string;
  readonly longitude: string;
  readonly latitude: string;
}

const DEGREES = /^-?\d{1,3}\.\d{6}$/;

/** Whether a picked place is whole: a name, and a point on the globe to six places. */
export function isStopPin(pin: StopPin): boolean {
  const label = pin.label.trim();
  if (label === '' || label.length > PLACE_LABEL_MAX) return false;
  if (!DEGREES.test(pin.longitude) || !DEGREES.test(pin.latitude)) return false;
  return Math.abs(Number(pin.longitude)) <= 180 && Math.abs(Number(pin.latitude)) <= 90;
}

/** Degrees to six places, about 10 cm, as a stop's point is kept. */
export const sixPlaces = (degrees: number): string => degrees.toFixed(6);

const samePin = (a: StopPin | null = null, b: StopPin | null = null) =>
  a === null || b === null
    ? a === b
    : a.label === b.label && a.longitude === b.longitude && a.latitude === b.latitude;

/** The points a route goes through, in order: a round trip ends back at its start. */
export function routePoints<T>(stops: readonly T[], roundTrip: boolean): T[] {
  const [start] = stops;
  return roundTrip && start !== undefined ? [...stops, start] : [...stops];
}

export const ROUTE_FIELDS = ['date', 'purpose', 'name', 'stops', 'roundTrip'] as const;
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

/** An address's first part, such as "1520 Harney St" of "1520 Harney St, Omaha, NE". */
const firstPart = (address: string) => address.split(',')[0]!.trim() || address;

/**
 * What a drive is called wherever it is listed, its claim and its report's export among them
 * (FR-CAP-15): the name its person gave it, or else its start and end, such as
 * "Office → Eppley Airfield", and "and back" on a round trip. A stop at one of the person's
 * saved places goes by the place's name; any other by its address's first part.
 */
export function routeDisplayName(
  values: Pick<RouteDriveValues, 'name' | 'stops' | 'roundTrip'>,
  savedNames: ReadonlyMap<string, string> = new Map(),
): string {
  if (values.name) return values.name;
  const called = (address: string) => savedNames.get(address.toLowerCase()) ?? firstPart(address);
  const start = called(values.stops[0] ?? '');
  const end = called(values.stops[values.stops.length - 1] ?? '');
  return `${start} → ${end}${values.roundTrip ? ' and back' : ''}`;
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
  /** The name its person gave it, shown in place of its stops; left out when it has none. */
  readonly name?: string;
  /** The addresses as typed, or as picked, start first and end last. */
  readonly stops: readonly string[];
  /**
   * The place picked for each stop, null for one typed, beside `stops`; left out when no stop
   * was picked (FR-CAP-14).
   */
  readonly pins?: readonly (StopPin | null)[];
  /** It returns to the start after the end. */
  readonly roundTrip: boolean;
}

/** A stop as given: an address typed, or one picked from the suggestions with its place. */
export type RouteStopInput = string | { readonly address: string; readonly pin: StopPin };

/** What a person typed. A field left out stays as it is. */
export interface RouteDriveInput {
  readonly date?: string;
  readonly purpose?: string;
  /** Its name, or null to go back to the name its stops give it. */
  readonly name?: string | null;
  readonly stops?: readonly RouteStopInput[];
  readonly roundTrip?: boolean;
}

export interface RouteDriveChange {
  readonly field: RouteField;
  readonly from: string | boolean | readonly string[] | null;
  /** Null when a name is taken away. */
  readonly to: string | boolean | readonly string[] | null;
}

const sameStops = (a: RouteDriveValues, b: RouteDriveValues) =>
  a.stops.length === b.stops.length &&
  a.stops.every((s, i) => s === b.stops[i] && samePin(a.pins?.[i], b.pins?.[i]));

/** The stops as given, checked: each address, and the place picked for it, if any. */
function checkStopInputs(
  given: readonly RouteStopInput[],
): Result<{ stops: string[]; pins: (StopPin | null)[] | null }, RouteProblem> {
  const checked = checkRouteStops(given.map((s) => (typeof s === 'string' ? s : s.address)));
  if (!checked.ok) return checked;
  const pins = given.map((s) => (typeof s === 'string' ? null : s.pin));
  for (const [i, pin] of pins.entries()) {
    if (pin && !isStopPin(pin)) {
      return problem(
        'stops',
        `The place picked for ${stopName(i, pins.length)} isn’t whole. Pick it again, or type its address.`,
        i,
      );
    }
  }
  return ok({ stops: checked.value, pins: pins.some((p) => p !== null) ? pins : null });
}

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
  table: MileageRates = IRS_BUSINESS_RATES,
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
  let pins = current?.pins ?? null;
  if (input.stops !== undefined) {
    const checked = checkStopInputs(input.stops);
    if (!checked.ok) return checked;
    ({ stops, pins } = checked.value);
  }
  let name = current?.name ?? null;
  if (input.name !== undefined) {
    name = input.name === null ? null : input.name.trim().replace(/\s+/g, ' ') || null;
    if (name !== null && name.length > ROUTE_NAME_MAX) {
      return problem('name', `Keep the name to ${ROUTE_NAME_MAX} characters.`);
    }
  }
  const roundTrip = input.roundTrip ?? current?.roundTrip ?? false;
  if (date === undefined) return problem('date', 'Enter the date.');
  if (purpose === undefined) return problem('purpose', 'Enter what the drive was for.');
  if (stops === undefined) {
    return problem('stops', 'Enter where the drive starts and where it ends.');
  }
  const values: RouteDriveValues = {
    date,
    purpose,
    ...(name !== null ? { name } : {}),
    stops,
    ...(pins ? { pins } : {}),
    roundTrip,
  };

  const changes: RouteDriveChange[] = [];
  if (current?.date !== date)
    changes.push({ field: 'date', from: current?.date ?? null, to: date });
  if (current?.purpose !== purpose) {
    changes.push({ field: 'purpose', from: current?.purpose ?? null, to: purpose });
  }
  if ((current?.name ?? null) !== name) {
    changes.push({ field: 'name', from: current?.name ?? null, to: name });
  }
  if (!current || !sameStops(current, values)) {
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
  table: MileageRates = IRS_BUSINESS_RATES,
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
