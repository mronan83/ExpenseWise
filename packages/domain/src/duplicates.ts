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
 * Whether two expenses look like one purchase filed twice (FR-INT-18): the same currency and
 * total, dated within a day, from a similar merchant. Every one of those must be known on
 * both, since a guess about a missing field is no evidence.
 */
export function looksLikeSamePurchase(a: ExpenseValues, b: ExpenseValues): boolean {
  if (
    a.merchant === null ||
    a.transactionDate === null ||
    a.currency === null ||
    a.amountMinor === null ||
    b.merchant === null ||
    b.transactionDate === null ||
    b.currency === null ||
    b.amountMinor === null
  ) {
    return false;
  }
  return (
    a.currency === b.currency &&
    a.amountMinor === b.amountMinor &&
    Math.abs(daysBetween(a.transactionDate, b.transactionDate)) <= DUPLICATE_DAY_WINDOW &&
    similarMerchants(a.merchant, b.merchant)
  );
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
