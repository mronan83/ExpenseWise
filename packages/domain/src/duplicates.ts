import { daysBetween } from './dates.ts';
import type { ExpenseValues } from './expense-values.ts';

/** How far apart two dates may be for one purchase: a day, for time zones and late posting. */
export const DUPLICATE_DAY_WINDOW = 1;

/** Words that say what kind of company it is, not which one. */
const COMPANY_WORDS = new Set([
  'the',
  'inc',
  'llc',
  'ltd',
  'limited',
  'co',
  'corp',
  'corporation',
  'company',
  'plc',
  'gmbh',
  'sa',
]);

/** A merchant's name as words: lower case, no accents, punctuation or company suffixes. */
export function merchantWords(name: string): string[] {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((word) => word !== '' && !COMPANY_WORDS.has(word));
}

/**
 * Whether two names likely belong to one business: the same words, run together or not
 * ("Blue Bottle" and "BlueBottle"), or every word of the shorter in the longer ("Uber" and
 * "Uber Technologies Inc.").
 */
export function similarMerchants(a: string, b: string): boolean {
  const x = merchantWords(a);
  const y = merchantWords(b);
  if (x.length === 0 || y.length === 0) return false;
  if (x.join('') === y.join('')) return true;
  const [shorter, longer] = x.length <= y.length ? [x, y] : [y, x];
  const words = new Set(longer);
  return shorter.every((word) => words.has(word));
}

/**
 * How far apart two printings of one purchase may be: the itemized bill and the card slip with
 * the tip on it come minutes apart. The default; the organization's owner may set another
 * (FR-INT-19).
 */
export const DUPLICATE_TIME_WINDOW_MINUTES = 30;
/** The widest window the owner can set. The narrowest is 0: the same minute only. */
export const DUPLICATE_WINDOW_MAX_MINUTES = 120;

/** Whether a number of minutes is a window the owner can set: a whole number, 0 to 120. */
export const isDuplicateWindow = (minutes: number): boolean =>
  Number.isInteger(minutes) && minutes >= 0 && minutes <= DUPLICATE_WINDOW_MAX_MINUTES;

/** What a duplicate check knows of a purchase: what is claimed, and when and where it was. */
export interface PurchaseFacts extends ExpenseValues {
  readonly time: string | null;
  readonly address: string | null;
  readonly city: string | null;
  readonly country: string | null;
}

/** exact: the same in everything both say. possible: the same purchase, perhaps amended. */
export type DuplicateKind = 'exact' | 'possible';

/** Spellings of the same street word, as printed on receipts. */
const STREET_WORDS: Readonly<Record<string, string>> = {
  street: 'st',
  avenue: 'ave',
  road: 'rd',
  boulevard: 'blvd',
  drive: 'dr',
  suite: 'ste',
  north: 'n',
  south: 's',
  east: 'e',
  west: 'w',
};

const placeWords = (text: string) => merchantWords(text).map((word) => STREET_WORDS[word] ?? word);

/**
 * Whether two purchases were in the same place: the same city, or failing that addresses whose
 * shorter's words are all in the longer. A different country says no. Null when either doesn't
 * say where.
 */
export function samePlace(a: PurchaseFacts, b: PurchaseFacts): boolean | null {
  if (a.country !== null && b.country !== null && a.country !== b.country) return false;
  if (a.city !== null && b.city !== null) {
    return placeWords(a.city).join('') === placeWords(b.city).join('');
  }
  if (a.address !== null && b.address !== null) {
    const x = placeWords(a.address);
    const y = placeWords(b.address);
    if (x.length === 0 || y.length === 0) return null;
    const [shorter, longer] = x.length <= y.length ? [x, y] : [y, x];
    const words = new Set(longer);
    return shorter.every((word) => words.has(word));
  }
  return null;
}

const minutesOf = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

/**
 * Whether two receipts are one purchase filed twice (FR-INT-18, ADR-0031), and how sure:
 *
 * - With a time and a place on both, those decide, whatever the total: a similar merchant, the
 *   same place and day, and times at most `windowMinutes` apart (half an hour unless the
 *   owner set another; 0 is the same minute only). Exact when the time and the total are the
 *   same too; possible otherwise, as with a tip added or an amended receipt.
 * - With the time on both but the place on neither or one, the total must match too.
 * - With the time on one or neither, the earlier rule stands (Q18): a similar merchant, the
 *   same currency and total, dated a day apart at most. Possible, never exact.
 *
 * A merchant and a date must be known on both, since a guess about a missing one is no evidence.
 */
export function duplicateKind(
  a: PurchaseFacts,
  b: PurchaseFacts,
  windowMinutes: number = DUPLICATE_TIME_WINDOW_MINUTES,
): DuplicateKind | null {
  if (a.merchant === null || b.merchant === null) return null;
  if (a.transactionDate === null || b.transactionDate === null) return null;
  if (!similarMerchants(a.merchant, b.merchant)) return null;
  const sameTotal =
    a.currency !== null &&
    a.currency === b.currency &&
    a.amountMinor !== null &&
    a.amountMinor === b.amountMinor;
  const place = samePlace(a, b);
  if (place === false) return null;

  if (a.time !== null && b.time !== null) {
    if (a.transactionDate !== b.transactionDate) return null;
    const apart = Math.abs(minutesOf(a.time) - minutesOf(b.time));
    if (apart > windowMinutes) return null;
    if (sameTotal) return apart === 0 ? 'exact' : 'possible';
    return place === true ? 'possible' : null;
  }
  return sameTotal &&
    Math.abs(daysBetween(a.transactionDate, b.transactionDate)) <= DUPLICATE_DAY_WINDOW
    ? 'possible'
    : null;
}

/** What a merge can take from the duplicate into the primary. An amount brings its currency. */
export const MERGE_FIELDS = ['merchant', 'date', 'amount', 'notes', 'trip'] as const;
export type MergeField = (typeof MERGE_FIELDS)[number];

/** An expense as a merge sees it: what it claims, its notes and the trip it is on. */
export interface MergeableExpense extends ExpenseValues {
  readonly notes: string | null;
  readonly tripId: string | null;
}

const blank = (value: string | null) => value === null || value.trim() === '';

/** Where each merge field lives on an expense. */
const FIELD_KEYS = {
  merchant: 'merchant',
  date: 'transactionDate',
  amount: 'amountMinor',
  notes: 'notes',
  trip: 'tripId',
} as const;

/**
 * The primary after a merge (FR-INT-18): each field the primary lacks comes from the
 * duplicate, and so does each field the person chose. Returns the fields that changed.
 */
export function mergeExpenses(
  primary: MergeableExpense,
  duplicate: MergeableExpense,
  chosen: readonly MergeField[],
): { merged: MergeableExpense; taken: MergeField[] } {
  const lacking: Record<MergeField, boolean> = {
    merchant: blank(primary.merchant),
    date: primary.transactionDate === null,
    amount: primary.amountMinor === null,
    notes: blank(primary.notes),
    trip: primary.tripId === null,
  };
  const has: Record<MergeField, boolean> = {
    merchant: !blank(duplicate.merchant),
    date: duplicate.transactionDate !== null,
    amount: duplicate.amountMinor !== null,
    notes: !blank(duplicate.notes),
    trip: duplicate.tripId !== null,
  };
  const take = (field: MergeField) => has[field] && (lacking[field] || chosen.includes(field));
  const merged: MergeableExpense = {
    merchant: take('merchant') ? duplicate.merchant : primary.merchant,
    transactionDate: take('date') ? duplicate.transactionDate : primary.transactionDate,
    amountMinor: take('amount') ? duplicate.amountMinor : primary.amountMinor,
    currency: take('amount') ? duplicate.currency : primary.currency,
    notes: take('notes') ? duplicate.notes : primary.notes,
    tripId: take('trip') ? duplicate.tripId : primary.tripId,
  };
  const taken = MERGE_FIELDS.filter(
    (field) =>
      merged[FIELD_KEYS[field]] !== primary[FIELD_KEYS[field]] ||
      (field === 'amount' && merged.currency !== primary.currency),
  );
  return { merged, taken };
}
