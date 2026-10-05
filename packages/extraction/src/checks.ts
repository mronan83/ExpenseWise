import {
  add,
  daysBetween,
  linesMakeTotal,
  subtract,
  sum,
  zero,
  type Money,
} from '@expensewise/domain';
import type { NormalizedExtraction } from './normalize.ts';

/**
 * What makes a confident reading implausible (FR-INT-04, journeys §4.6). sums: the subtotal,
 * taxes and tip don't come to the total, or, with no subtotal printed, the item lines with
 * them don't (#92). future_date: dated after the day it was uploaded.
 * old_date: dated more than a year before that day. summary: a purchase summary, which shows
 * what was ordered but not what was charged (FR-CAP-02, Q10). stay: a folio's check-out is
 * before its check-in, or its stay is longer than the most nights worked out (FR-INT-21), so
 * the nights aren't sure; only read where journeys and stays are switched on. A reading that
 * fails one is never Ready on its own; a person looks, and the receipt says which check failed.
 */
export const READING_CHECKS = ['sums', 'future_date', 'old_date', 'summary', 'stay'] as const;
export type ReadingCheck = (typeof READING_CHECKS)[number];

/** The merchant's day can run ahead of the UTC day the receipt was uploaded on. */
const DAYS_AHEAD = 1;

/**
 * Whether the parts that were read come to the total: the subtotal, taxes, fees and tip. Each
 * tax, fee and tip line may be a minor unit out, because each is rounded on its own. Prices
 * that include their tax, as VAT receipts print them, add up too: then the subtotal, fees and
 * tip alone make the total. With no subtotal printed, as a hotel folio rarely prints one, the
 * item lines stand in for it, credits taking off, each a minor unit out too: the rule the lines
 * an expense keeps are held to (`linesMakeTotal`, R-LINES-TOLERANCE, #92). Null when there is
 * nothing to add up: no total was read, or the receipt prints neither a subtotal nor an item
 * line that can be read exactly.
 */
export function addsUp(n: NormalizedExtraction): boolean | null {
  const total = n.total?.value;
  if (!total) return null;
  const subtotal = n.subtotal?.value;
  if (!subtotal) return n.itemTotal ? itemsAddUp(n, n.itemTotal, total) : null;
  const tax = n.taxTotal?.value;
  const fees = n.feeTotal?.value;
  const tip = n.tip?.value;
  const comesTo = (parts: (Money | undefined)[], slack: number) => {
    const read = parts.filter((m): m is Money => m !== undefined);
    if (read.some((m) => m.currency !== total.currency)) return false;
    return Math.abs(subtract(sum(total.currency, read), total).amountMinor) <= slack;
  };
  const slack = (tip ? 1 : 0) + n.feeLines;
  return (
    comesTo([subtotal, tax, fees, tip], n.taxLines + slack) ||
    (tax !== undefined && comesTo([subtotal, fees, tip], slack))
  );
}

/**
 * Whether the item lines, with the taxes, fees and tip read, make the total. Lines in another
 * currency than the total's never do.
 */
function itemsAddUp(n: NormalizedExtraction, items: Money, total: Money): boolean {
  const none = zero(total.currency);
  const tax = n.taxTotal?.value;
  const fees = n.feeTotal?.value;
  const tip = n.tip?.value;
  const parts = [items, tax, fees, tip].filter((m): m is Money => m !== undefined);
  if (parts.some((m) => m.currency !== total.currency)) return false;
  const made = linesMakeTotal(
    {
      items,
      itemLines: n.itemLines,
      taxes: tax ?? none,
      taxLines: tax ? n.taxLines : 0,
      others: add(fees ?? none, tip ?? none),
      otherLines: (fees ? n.feeLines : 0) + (tip ? 1 : 0),
    },
    total,
  );
  return made !== null;
}

/** The same day a year earlier, as an ISO date. Feb 29 compares as the day after Feb 28. */
const aYearBefore = (day: string) => `${String(Number(day.slice(0, 4)) - 1)}${day.slice(4)}`;

/** The checks a reading fails, given when its receipt was uploaded. */
export function readingChecks(n: NormalizedExtraction, uploadedAt: Date): ReadingCheck[] {
  const failed: ReadingCheck[] = [];
  if (n.documentType === 'purchase_summary') failed.push('summary');
  if (addsUp(n) === false) failed.push('sums');
  const date = n.date?.value;
  if (date) {
    const uploadedOn = uploadedAt.toISOString().slice(0, 10);
    if (daysBetween(uploadedOn, date) > DAYS_AHEAD) failed.push('future_date');
    else if (date < aYearBefore(uploadedOn)) failed.push('old_date');
  }
  if (n.stay?.nights && !n.stay.nights.sure) failed.push('stay');
  return failed;
}
