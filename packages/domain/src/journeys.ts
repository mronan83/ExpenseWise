import { daysBetween, isIsoDate } from './dates.ts';
import { showDate, showDateRange } from './display.ts';
import { err, ok, type Result } from './result.ts';

/**
 * Where a journey went and when a hotel stay was, as a transport receipt or a folio prints them
 * (FR-INT-20, FR-INT-21). Every part may be blank, and none decides whether an expense is
 * Ready. The nights are never kept: they are worked out from the two dates wherever they show.
 */
export interface ExpenseTravel {
  /** Where it went from, as printed: a ride's pickup, a flight's origin, a train's station. */
  readonly journeyFrom: string | null;
  /** Where it went to: a ride's drop-off, a flight's destination, a train's station. */
  readonly journeyTo: string | null;
  /**
   * The day its first leg departs, YYYY-MM-DD: for a ticket bought ahead, later than the day
   * it was charged. A ticket files to its trip by this day (FR-EXP-19, #94).
   */
  readonly departsOn: string | null;
  /** A stay's check-in day, YYYY-MM-DD. */
  readonly checkIn: string | null;
  /** A stay's check-out day, YYYY-MM-DD. */
  readonly checkOut: string | null;
}

export const NO_TRAVEL: ExpenseTravel = {
  journeyFrom: null,
  journeyTo: null,
  departsOn: null,
  checkIn: null,
  checkOut: null,
};

export const TRAVEL_FIELDS = [
  'journeyFrom',
  'journeyTo',
  'departsOn',
  'checkIn',
  'checkOut',
] as const;
export type TravelField = (typeof TRAVEL_FIELDS)[number];

/**
 * The most nights a stay is worked out for (R-STAY-NIGHTS). A folio read as longer, most often
 * a year or a month misread, is not sure and needs a look rather than showing a wrong number.
 */
export const STAY_MAX_NIGHTS = 31;

/** The most text either end of a journey keeps: a ride's address runs longest. */
const JOURNEY_MAX = 200;

/** Why a stay's nights can't be known from its dates. */
export type StayDoubt = 'check_out_before_check_in' | 'too_long';

/** A stay's nights, or why they are not sure. */
export type StayNights =
  | { readonly sure: true; readonly nights: number }
  | { readonly sure: false; readonly doubt: StayDoubt };

/**
 * The nights between check-in and check-out: the days from one to the other, so Sep 29 to
 * Oct 1 is 2, and a check-out the day of check-in is 0. A check-out before check-in, or more
 * than STAY_MAX_NIGHTS, is not sure. Both are YYYY-MM-DD dates that exist.
 */
export function nightsOf(checkIn: string, checkOut: string): StayNights {
  const nights = daysBetween(checkIn, checkOut);
  if (nights < 0) return { sure: false, doubt: 'check_out_before_check_in' };
  if (nights > STAY_MAX_NIGHTS) return { sure: false, doubt: 'too_long' };
  return { sure: true, nights };
}

/** The nights of a stay as kept; null until both dates are known. */
export function stayNights(stay: Pick<ExpenseTravel, 'checkIn' | 'checkOut'>): StayNights | null {
  const { checkIn, checkOut } = stay;
  return checkIn && checkOut && isIsoDate(checkIn) && isIsoDate(checkOut)
    ? nightsOf(checkIn, checkOut)
    : null;
}

/** A person's change to the journey or the stay. A blank string clears a field. */
export type TravelEdit = { readonly [F in TravelField]?: string };

export interface TravelChange {
  readonly field: TravelField;
  readonly from: string | null;
  readonly to: string | null;
}

export interface TravelEditProblem {
  readonly field: TravelField;
  readonly message: string;
}

const STAY_FIELDS: readonly TravelField[] = ['checkIn', 'checkOut'];
const DATE_FIELDS: readonly TravelField[] = ['departsOn', ...STAY_FIELDS];

/**
 * Applies a person's edit to the journey and the stay: either end of a journey up to 200
 * characters, and dates that exist, the day it departs among them. A stay the edit leaves with a check-out before its
 * check-in, or longer than STAY_MAX_NIGHTS, is refused, naming the date it changed. Returns
 * what changed.
 */
export function applyTravelEdit(
  current: ExpenseTravel,
  edit: TravelEdit,
): Result<{ travel: ExpenseTravel; changes: TravelChange[] }, TravelEditProblem> {
  // Only the journey and the stay: `current` may be a whole expense.
  const next = Object.fromEntries(TRAVEL_FIELDS.map((f) => [f, current[f]])) as Record<
    TravelField,
    string | null
  >;
  for (const field of TRAVEL_FIELDS) {
    const raw = edit[field];
    if (raw === undefined) continue;
    const value = raw.trim() === '' ? null : raw.trim();
    if (value !== null && DATE_FIELDS.includes(field) && !isIsoDate(value)) {
      return err({ field, message: 'A date is YYYY-MM-DD, such as 2026-09-29.' });
    }
    if (value !== null && value.length > JOURNEY_MAX) {
      return err({ field, message: `At most ${JOURNEY_MAX} characters.` });
    }
    next[field] = value;
  }
  const touched = STAY_FIELDS.filter((f) => edit[f] !== undefined);
  const nights = touched.length > 0 ? stayNights(next) : null;
  if (nights && !nights.sure) {
    const field = touched.at(-1) ?? 'checkOut';
    return err({
      field,
      message:
        nights.doubt === 'too_long'
          ? `A stay is at most ${STAY_MAX_NIGHTS} nights; enter a longer one as two.`
          : 'Check-out is on or after check-in.',
    });
  }
  const changes = TRAVEL_FIELDS.filter((f) => next[f] !== current[f]).map((field) => ({
    field,
    from: current[field],
    to: next[field],
  }));
  return ok({ travel: next, changes });
}

/** Whether two journeys and stays say the same. */
export const sameTravel = (a: ExpenseTravel, b: ExpenseTravel): boolean =>
  TRAVEL_FIELDS.every((f) => a[f] === b[f]);

const shown = (date: string) => (isIsoDate(date) ? showDate(date) : date);

/**
 * "SFO → ORD", where a journey went, in a line; one end alone reads "From SFO" or "To ORD".
 * With the day it departs, "SFO → ORD, departs Oct 20, 2026", or "Departs Oct 20, 2026" alone.
 */
export function journeyLine(
  travel: Pick<ExpenseTravel, 'journeyFrom' | 'journeyTo'> &
    Partial<Pick<ExpenseTravel, 'departsOn'>>,
) {
  const { journeyFrom: from, journeyTo: to, departsOn } = travel;
  const went = from && to ? `${from} → ${to}` : from ? `From ${from}` : to ? `To ${to}` : null;
  if (!departsOn) return went;
  return went ? `${went}, departs ${shown(departsOn)}` : `Departs ${shown(departsOn)}`;
}

/**
 * "2 nights, Sep 29 – Oct 1, 2026", a stay in a line. A stay whose nights aren't sure says why
 * instead of a number; one with a single date known names it.
 */
export function stayLine(stay: Pick<ExpenseTravel, 'checkIn' | 'checkOut'>): string | null {
  const { checkIn, checkOut } = stay;
  if (!checkIn || !checkOut) {
    if (checkIn) return `Check-in ${shown(checkIn)}`;
    if (checkOut) return `Check-out ${shown(checkOut)}`;
    return null;
  }
  const nights = stayNights(stay);
  if (!nights) return `Check-in ${shown(checkIn)}, check-out ${shown(checkOut)}`;
  if (!nights.sure) {
    return nights.doubt === 'too_long'
      ? `Nights not sure: ${showDateRange(checkIn, checkOut)} is more than ${STAY_MAX_NIGHTS}`
      : `Nights not sure: check-out ${shown(checkOut)} is before check-in ${shown(checkIn)}`;
  }
  const count = `${nights.nights} ${nights.nights === 1 ? 'night' : 'nights'}`;
  return `${count}, ${checkIn === checkOut ? shown(checkIn) : showDateRange(checkIn, checkOut)}`;
}
