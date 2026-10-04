import { err, ok, type Result } from './result.ts';

/**
 * When and where a purchase happened, as its receipt prints it (FR-INT-17). Every part may be
 * blank, and a blank part never makes an expense need a look.
 */
export interface ExpenseDetails {
  /** Local time of the purchase, HH:MM on a 24-hour clock. */
  readonly time: string | null;
  /** The IANA time zone the time is in, worked out from the place or set by the person. */
  readonly timeZone: string | null;
  /** The merchant's address, as printed. */
  readonly address: string | null;
  readonly city: string | null;
  /** State, province or region, as printed. */
  readonly region: string | null;
  /** ISO 3166-1 alpha-2. */
  readonly country: string | null;
}

export const NO_DETAILS: ExpenseDetails = {
  time: null,
  timeZone: null,
  address: null,
  city: null,
  region: null,
  country: null,
};

export const DETAIL_FIELDS = ['time', 'timeZone', 'address', 'city', 'region', 'country'] as const;
export type DetailField = (typeof DETAIL_FIELDS)[number];

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Whether a value is a time of day as HH:MM, 00:00 to 23:59. */
export const isTimeOfDay = (value: string): boolean => TIME.test(value);

/** Whether a value is an ISO 3166-1 alpha-2 shape: two capital letters. */
export const isCountryCode = (value: string): boolean => /^[A-Z]{2}$/.test(value);

/** Whether the runtime knows this IANA time zone, such as America/Chicago. */
export function isTimeZone(value: string): boolean {
  if (!/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)*$/.test(value)) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** The most text any detail keeps; an address runs longest. */
const MAX = { time: 5, timeZone: 64, address: 300, city: 100, region: 100, country: 2 };

/**
 * A time as read: HH:MM, with a single-digit hour padded ("9:05" is "09:05") and seconds
 * dropped. Null for anything that isn't a time of day.
 */
export function readTime(value: string): string | null {
  const match = /^\s*(\d{1,2}):(\d{2})(?::\d{2})?\s*$/.exec(value);
  if (!match) return null;
  const time = `${match[1]!.padStart(2, '0')}:${match[2]}`;
  return isTimeOfDay(time) ? time : null;
}

/** A person's change to the details. A blank string clears a field. */
export type DetailsEdit = { readonly [F in DetailField]?: string };

export interface DetailChange {
  readonly field: DetailField;
  readonly from: string | null;
  readonly to: string | null;
}

export interface DetailsEditProblem {
  readonly field: DetailField;
  readonly message: string;
}

/**
 * Applies a person's edit to the details, checking each field it sets: a time of day, a known
 * time zone, a two-letter country, and no field longer than it keeps. Returns what changed.
 */
export function applyDetailsEdit(
  current: ExpenseDetails,
  edit: DetailsEdit,
): Result<{ details: ExpenseDetails; changes: DetailChange[] }, DetailsEditProblem> {
  // Only the details: `current` may be a whole expense, whose other fields aren't ours.
  const next = Object.fromEntries(DETAIL_FIELDS.map((f) => [f, current[f]])) as Record<
    DetailField,
    string | null
  >;
  for (const field of DETAIL_FIELDS) {
    const raw = edit[field];
    if (raw === undefined) continue;
    let value: string | null = raw.trim() === '' ? null : raw.trim();
    if (value !== null && value.length > MAX[field]) {
      return err({ field, message: `At most ${MAX[field]} characters.` });
    }
    if (value !== null && field === 'time') {
      value = readTime(value);
      if (value === null) return err({ field, message: 'A time is HH:MM, such as 18:42.' });
    }
    if (value !== null && field === 'country') {
      value = value.toUpperCase();
      if (!isCountryCode(value)) {
        return err({ field, message: 'A country is a two-letter code, such as US or DE.' });
      }
    }
    if (value !== null && field === 'timeZone' && !isTimeZone(value)) {
      return err({ field, message: 'A time zone is a name such as America/Chicago.' });
    }
    next[field] = value;
  }
  const changes = DETAIL_FIELDS.filter((f) => next[f] !== current[f]).map((field) => ({
    field,
    from: current[field],
    to: next[field],
  }));
  return ok({ details: next, changes });
}

/** Whether two sets of details say the same. */
export const sameDetails = (a: ExpenseDetails, b: ExpenseDetails): boolean =>
  DETAIL_FIELDS.every((f) => a[f] === b[f]);
