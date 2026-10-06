import type { PayerTally, TripRecord, TripTally } from '@expensewise/db';
import {
  add,
  daysBetween,
  isCurrencyCode,
  money,
  paidByOf,
  splitCost,
  toDecimal,
  type Money,
} from '@expensewise/domain';

const DONE = new Set(['ready', 'submitted', 'approved', 'settled']);

const totalView = (m: Money) => ({
  amountMinor: m.amountMinor,
  currency: m.currency,
  decimal: toDecimal(m),
});

/**
 * What is claimed and what the company paid of these amounts, one total per currency each,
 * never converted (FR-EXP-17).
 */
export function costView(payers: readonly PayerTally[]) {
  const split = splitCost(
    payers.map((p) => ({
      amountMinor: p.amountMinor,
      currency: p.currency,
      paidBy: paidByOf(p.companyPaid),
    })),
  );
  return {
    claimed: split.claimed.map(totalView),
    companyPaid: split.companyPaid.map(totalView),
  };
}

/**
 * A trip with its progress and totals, one per currency and never converted. With `payers`,
 * while Paid by the company is on, its cost split into what is claimed and what the company
 * paid too (FR-EXP-17).
 */
export function tripSummary(
  trip: TripRecord,
  tallies: readonly TripTally[],
  payers?: readonly PayerTally[],
) {
  const mine = tallies.filter((t) => t.tripId === trip.id);
  const count = (keep: (t: TripTally) => boolean) =>
    mine.filter(keep).reduce((n, t) => n + t.count, 0);
  const totals = new Map<string, Money>();
  for (const t of mine) {
    if (t.amountMinor === null || t.currency === null || !isCurrencyCode(t.currency)) continue;
    const amount = money(t.amountMinor, t.currency);
    const sofar = totals.get(t.currency);
    totals.set(t.currency, sofar ? add(sofar, amount) : amount);
  }
  return {
    id: trip.id,
    name: trip.name,
    purpose: trip.purpose,
    primaryCity: trip.primaryCity,
    startDate: trip.startDate,
    endDate: trip.endDate,
    days: daysBetween(trip.startDate, trip.endDate) + 1,
    owner: trip.owner,
    expenseCount: count(() => true),
    readyCount: count((t) => DONE.has(t.status)),
    needsReviewCount: count((t) => t.status === 'needs_review'),
    totals: [...totals.values()]
      .sort((a, b) => a.currency.localeCompare(b.currency))
      .map((m) => ({ amountMinor: m.amountMinor, currency: m.currency, decimal: toDecimal(m) })),
    ...(payers ? { cost: costView(payers.filter((p) => p.tripId === trip.id)) } : {}),
    reportId: trip.reportId,
    createdAt: trip.createdAt.toISOString(),
  };
}
