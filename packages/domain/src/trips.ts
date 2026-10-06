import { SUPPORTED_CURRENCIES, type CurrencyCode } from './currency.ts';
import { daysBetween, isIsoDate } from './dates.ts';
import { DomainError } from './errors.ts';
import { isExpenseEditable, type ExpenseStatus } from './lifecycle/expense.ts';
import { fromDecimal } from './money.ts';
import { err, ok, type Result } from './result.ts';

/** The days a trip covers, both ends included, as local calendar dates. */
export interface TripWindow {
  readonly id: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly createdAt: Date;
}

/** The trip covers the date: start and end days included. */
export const tripCovers = (trip: TripWindow, date: string): boolean =>
  trip.startDate <= date && date <= trip.endDate;

/**
 * The trip an expense dated `date` files to (FR-EXP-04, ADR-0023): the one whose dates include
 * it. On a day two trips share, the trip that ends first keeps it. A hotel bill is dated the
 * day you check out, and it is the largest item of the day; a short trip inside a longer one
 * ends first, so it keeps its own days. Between trips that end the same day, the one that
 * starts later; then the newer one. Null with no date or no trip covering it.
 */
export function tripFor<T extends TripWindow>(date: string | null, trips: readonly T[]): T | null {
  if (date === null) return null;
  let best: T | null = null;
  for (const trip of trips) {
    if (!tripCovers(trip, date)) continue;
    if (best === null || keepsSharedDay(trip, best)) best = trip;
  }
  return best;
}

const keepsSharedDay = (a: TripWindow, b: TripWindow): boolean => {
  if (a.endDate !== b.endDate) return a.endDate < b.endDate;
  if (a.startDate !== b.startDate) return a.startDate > b.startDate;
  const age = a.createdAt.getTime() - b.createdAt.getTime();
  return age !== 0 ? age > 0 : a.id > b.id;
};

export type TripPhase = 'upcoming' | 'under_way' | 'past';

/**
 * Where a trip stands on `today`, the traveler's local date. Worked out where it is shown,
 * since only the viewer knows what day it is for them.
 */
export function tripPhase(
  trip: Pick<TripWindow, 'startDate' | 'endDate'>,
  today: string,
): TripPhase {
  if (today < trip.startDate) return 'upcoming';
  return today > trip.endDate ? 'past' : 'under_way';
}

/**
 * The day an expense files to a trip by (ADR-0023): the day a ticket's first leg departs, when
 * it was read or entered, else the day it was charged. A fare bought weeks ahead files to the
 * trip it flies on, and keeps the day it was charged as its date (FR-EXP-19, #94).
 */
export const filingDate = (expense: {
  readonly transactionDate: string | null;
  readonly departsOn?: string | null;
}): string | null => expense.departsOn ?? expense.transactionDate;

/**
 * Date filing may move an expense to another trip only before it is submitted: while it is
 * read, needs review or is Ready. A submitted expense stays on its trip, as its report does.
 */
export function isTripMovable(status: ExpenseStatus): boolean {
  return status === 'processing' || isExpenseEditable(status);
}

/** What a person says about a trip. Dates are local calendar dates, both ends included. */
export interface TripValues {
  readonly name: string;
  readonly purpose: string | null;
  readonly primaryCity: string | null;
  readonly startDate: string;
  readonly endDate: string;
}

export const TRIP_FIELDS = ['name', 'purpose', 'primaryCity', 'startDate', 'endDate'] as const;
export type TripField = (typeof TRIP_FIELDS)[number];

/** What a person typed. An empty purpose or city clears it; a missing field stays as it is. */
export type TripInput = { readonly [F in TripField]?: string | null };

export interface TripProblem {
  readonly field: TripField;
  readonly message: string;
}

export interface TripChange {
  readonly field: TripField;
  readonly from: string | null;
  readonly to: string | null;
}

const LIMITS = { name: 120, purpose: 500, primaryCity: 120 } as const;

/**
 * The longest trip, in days. A year is room for any assignment, and it stops a mistyped year
 * from making one trip that every expense files to.
 */
export const TRIP_MAX_DAYS = 366;

/**
 * Applies what a person typed to a trip, or makes a new one when there is none yet: a new trip
 * needs a name and both dates. Returns the trip's values and each field that changed.
 */
export function applyTripInput(
  current: TripValues | null,
  input: TripInput,
): Result<{ values: TripValues; changes: TripChange[] }, TripProblem> {
  const invalid = (field: TripField, message: string) => err({ field, message });

  const text = (
    field: keyof typeof LIMITS,
    required: boolean,
  ): Result<string | null, TripProblem> => {
    const typed = input[field];
    if (typed === undefined) return ok(current ? current[field] : null);
    const value = typed?.trim() ?? '';
    if (value === '' && required) return invalid(field, 'Give the trip a name.');
    if (value.length > LIMITS[field]) {
      return invalid(field, `Keep it to ${LIMITS[field]} characters.`);
    }
    return ok(value === '' ? null : value);
  };
  const day = (field: 'startDate' | 'endDate'): Result<string | null, TripProblem> => {
    const typed = input[field];
    if (typed === undefined) return ok(current ? current[field] : null);
    const value = typed?.trim() ?? '';
    return isIsoDate(value) ? ok(value) : invalid(field, 'Enter a date as YYYY-MM-DD.');
  };

  const name = text('name', true);
  if (!name.ok) return name;
  const purpose = text('purpose', false);
  if (!purpose.ok) return purpose;
  const primaryCity = text('primaryCity', false);
  if (!primaryCity.ok) return primaryCity;
  const startDate = day('startDate');
  if (!startDate.ok) return startDate;
  const endDate = day('endDate');
  if (!endDate.ok) return endDate;

  if (name.value === null) return invalid('name', 'Give the trip a name.');
  if (startDate.value === null) return invalid('startDate', 'Enter the day the trip starts.');
  if (endDate.value === null) return invalid('endDate', 'Enter the day the trip ends.');
  const length = daysBetween(startDate.value, endDate.value);
  if (length < 0) return invalid('endDate', 'A trip ends on or after the day it starts.');
  if (length + 1 > TRIP_MAX_DAYS) {
    return invalid('endDate', `A trip can be at most ${TRIP_MAX_DAYS} days long.`);
  }

  const values: TripValues = {
    name: name.value,
    purpose: purpose.value,
    primaryCity: primaryCity.value,
    startDate: startDate.value,
    endDate: endDate.value,
  };
  const changes = TRIP_FIELDS.flatMap((field) => {
    const from = current ? current[field] : null;
    const to = values[field];
    return from !== to ? [{ field, from, to }] : [];
  });
  return ok({ values, changes });
}

/** An amount in minor units and the currencies it is that amount in. */
export interface AmountMatch {
  readonly amountMinor: number;
  readonly currencies: readonly CurrencyCode[];
}

const PLAIN_AMOUNT = /^\d{1,15}(\.\d{1,3})?$/;

/**
 * What an amount searched for, such as "18.92", is in minor units, currency by currency
 * (FR-INS-02): 1892 in currencies with cents, 18920 in those with three decimals, and nothing
 * in yen, which has none. Nothing is rounded. Null when it isn't a plain decimal.
 */
export function amountMatches(text: string): AmountMatch[] | null {
  const typed = text.trim();
  if (!PLAIN_AMOUNT.test(typed)) return null;
  const byAmount = new Map<number, CurrencyCode[]>();
  for (const currency of SUPPORTED_CURRENCIES) {
    try {
      const { amountMinor } = fromDecimal(typed, currency);
      byAmount.set(amountMinor, [...(byAmount.get(amountMinor) ?? []), currency]);
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
    }
  }
  return [...byAmount].map(([amountMinor, currencies]) => ({ amountMinor, currencies }));
}
