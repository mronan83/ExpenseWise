import type { HomeSnapshot, MonthTally } from '@expensewise/db';
import {
  add,
  daysBetween,
  isCurrencyCode,
  money,
  toDecimal,
  type Money,
} from '@expensewise/domain';
import type { HomeData } from './home.ts';
import { needsYouItems } from './needs-you-views.ts';
import { reportSummary } from './report-views.ts';
import { tripSummary } from './trip-views.ts';

const DONE = new Set(['ready', 'submitted', 'approved', 'settled']);

/** Sums per currency, never converted, in a stable order. */
function totalsOf(rows: readonly Pick<MonthTally, 'currency' | 'amountMinor'>[]) {
  const totals = new Map<string, Money>();
  for (const r of rows) {
    if (r.amountMinor === null || r.currency === null || !isCurrencyCode(r.currency)) continue;
    const amount = money(r.amountMinor, r.currency);
    const sofar = totals.get(r.currency);
    totals.set(r.currency, sofar ? add(sofar, amount) : amount);
  }
  return [...totals.values()]
    .sort((a, b) => a.currency.localeCompare(b.currency))
    .map((m) => ({ amountMinor: m.amountMinor, currency: m.currency, decimal: toDecimal(m) }));
}

const count = (rows: readonly MonthTally[]) => rows.reduce((n, r) => n + r.count, 0);

/** The trip under way, as day N of its days, or else the next one, as days until it starts. */
function tripView(home: HomeSnapshot, day: string) {
  if (home.tripNow) {
    return {
      when: 'now' as const,
      day: daysBetween(home.tripNow.startDate, day) + 1,
      startsIn: 0,
      trip: tripSummary(home.tripNow, home.tallies),
    };
  }
  if (home.tripNext) {
    return {
      when: 'next' as const,
      day: 0,
      startsIn: daysBetween(day, home.tripNext.startDate),
      trip: tripSummary(home.tripNext, home.tallies),
    };
  }
  return null;
}

/**
 * Home for one member on one day (FR-INS-01): what needs them first, then the trip under way
 * or next, this month, their reports to finish, and the last trips. Built from the same views as the inbox and Trips,
 * so a figure here matches the one there.
 */
export function homeView(
  data: HomeData,
  day: string,
  shown: number,
  now = new Date(),
  /** Whether the organization reads under its AI model settings (receipts.model-settings). */
  settingsOn = false,
  converting = false,
) {
  const { home } = data;
  const items = needsYouItems(data, data.reports, now, settingsOn, converting);
  const month = home.monthExpenses;
  const offTrip = month.filter((r) => !r.onTrip);
  return {
    day,
    needsYou: { count: items.length, items: items.slice(0, shown) },
    trip: tripView(home, day),
    month: {
      from: home.month.from,
      expenses: count(month),
      ready: count(month.filter((r) => DONE.has(r.status))),
      spent: totalsOf(month),
      trips: home.monthTrips,
      notOnTrip: { expenses: count(offTrip), spent: totalsOf(offTrip) },
    },
    reading: home.reading,
    // Reports to finish: the open and closed ones, newest first (FR-INS-01, Q15).
    reports: data.reports.reports.map((r) => reportSummary(r, now, converting)),
    recentTrips: home.recentTrips.map((t) => tripSummary(t, home.tallies)),
  };
}
