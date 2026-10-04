import { reportItems, type ExpenseRecord, type ReportContents } from '@expensewise/db';
import {
  add,
  isCurrencyCode,
  localExpenseReady,
  money,
  reportWarns,
  toDecimal,
  type Money,
} from '@expensewise/domain';
import { amountView } from './receipt-views.ts';
import { tripSummary } from './trip-views.ts';

/** Sums per currency, never converted, in a stable order (until #62 converts them). */
function totalsOf(amounts: readonly { amountMinor: number | null; currency: string | null }[]) {
  const totals = new Map<string, Money>();
  for (const a of amounts) {
    if (a.amountMinor === null || a.currency === null || !isCurrencyCode(a.currency)) continue;
    const amount = money(a.amountMinor, a.currency);
    const sofar = totals.get(a.currency);
    totals.set(a.currency, sofar ? add(sofar, amount) : amount);
  }
  return [...totals.values()]
    .sort((a, b) => a.currency.localeCompare(b.currency))
    .map((m) => ({ amountMinor: m.amountMinor, currency: m.currency, decimal: toDecimal(m) }));
}

/**
 * A report as lists and Home show it (FR-EXP-05, FR-EXP-12): what is on it, what holds it
 * open, when it closes, and its totals. warning: open, in its last week, and something still
 * needs review. overdue: open past its day 28 with something still needing attention.
 */
export function reportSummary(contents: ReportContents, now: Date) {
  const { report, trips, tallies, locals } = contents;
  const items = reportItems(contents);
  const needsAttention = items.filter((i) => !i.ready).length;
  const open = report.status === 'open';
  return {
    id: report.id,
    title: report.title,
    status: report.status,
    owner: report.owner,
    currency: report.currency,
    openedAt: report.createdAt.toISOString(),
    closesAt: report.closesAt.toISOString(),
    closedAt: report.closedAt?.toISOString() ?? null,
    tripNames: trips.map((t) => t.name),
    trips: trips.length,
    localExpenses: locals.length,
    needsAttention,
    canClose: open && items.length > 0 && needsAttention === 0,
    warning: open && needsAttention > 0 && reportWarns(report.closesAt, now),
    overdue: open && needsAttention > 0 && now >= report.closesAt,
    totals: totalsOf([...tallies, ...locals.filter((e) => !e.held)]),
  };
}

export type ReportSummary = ReturnType<typeof reportSummary>;

/** A report with each trip and local expense on it, and what each still needs. */
export function reportDetail(contents: ReportContents, now: Date) {
  const unsettled = new Map(contents.counts.map((c) => [c.tripId, c.unsettled]));
  return {
    ...reportSummary(contents, now),
    tripItems: contents.trips.map((t) => {
      const waiting = unsettled.get(t.id) ?? 0;
      return { ...tripSummary(t, contents.tallies), unsettled: waiting, ready: waiting === 0 };
    }),
    localItems: contents.locals.map((e) => ({
      id: e.id,
      status: e.status,
      merchant: e.merchant,
      date: e.transactionDate,
      amount: amountView(e.amountMinor, e.currency),
      receiptId: e.receiptId,
      justification: e.justification,
      held: e.held,
      ready: localExpenseReady(e.status, e.justification),
    })),
  };
}

/** A local expense as Needs you shows it: one that still says nothing of why. */
export function unjustifiedItem(expense: ExpenseRecord) {
  return {
    kind: 'expense' as const,
    expense: {
      id: expense.id,
      merchant: expense.merchant,
      date: expense.transactionDate,
      amount: amountView(expense.amountMinor, expense.currency),
      receiptId: expense.receiptId,
    },
    reason: { code: 'justification' as const },
  };
}

/**
 * A report as Needs you shows it, or null when it doesn't need the person. overdue: past day
 * 28 with something still needing attention. closing_soon: in its last week, something still needing review.
 * ready_to_close: nothing left to do but close it.
 */
export function reportItem(contents: ReportContents, now: Date) {
  const report = reportSummary(contents, now);
  if (report.status !== 'open') return null;
  const code = report.overdue
    ? ('overdue' as const)
    : report.warning
      ? ('closing_soon' as const)
      : report.canClose
        ? ('ready_to_close' as const)
        : null;
  return code ? { kind: 'report' as const, report, reason: { code } } : null;
}
