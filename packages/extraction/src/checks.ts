import { daysBetween, subtract, sum, type Money } from '@expensewise/domain';
import type { NormalizedExtraction } from './normalize.ts';

/**
 * What makes a confident reading implausible (FR-INT-04, journeys §4.6). sums: the subtotal,
 * taxes and tip don't come to the total. future_date: dated after the day it was uploaded.
 * old_date: dated more than a year before that day. summary: a purchase summary, which shows
 * what was ordered but not what was charged (FR-CAP-02, Q10). A reading that fails one is never
 * Ready on its own; a person looks, and the receipt says which check failed.
 */
export const READING_CHECKS = ['sums', 'future_date', 'old_date', 'summary'] as const;
export type ReadingCheck = (typeof READING_CHECKS)[number];

/** The merchant's day can run ahead of the UTC day the receipt was uploaded on. */
const DAYS_AHEAD = 1;

/**
 * Whether the parts that were read come to the total: the subtotal, taxes, fees and tip. Each
 * tax, fee and tip line may be a minor unit out, because each is rounded on its own. Prices
 * that include their tax, as VAT receipts print them, add up too: then the subtotal, fees and
 * tip alone make the total. Null when there is nothing to add up, because the receipt prints
 * no subtotal or no total was read.
 */
export function addsUp(n: NormalizedExtraction): boolean | null {
  const total = n.total?.value;
  const subtotal = n.subtotal?.value;
  if (!total || !subtotal) return null;
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
  return failed;
}
