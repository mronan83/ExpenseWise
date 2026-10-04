import { reportItems, type ExpenseRecord, type ReportContents } from '@expensewise/db';
import {
  add,
  isCurrencyCode,
  localExpenseReady,
  money,
  reimbursed,
  reimbursementTotal,
  reportWarns,
  toDecimal,
  type Money,
  type Reimbursed,
} from '@expensewise/domain';
import { amountView } from './receipt-views.ts';
import { tripSummary } from './trip-views.ts';

const totalView = (m: Money) => ({
  amountMinor: m.amountMinor,
  currency: m.currency,
  decimal: toDecimal(m),
});

/** Each amount on a report in its currency (FR-EXP-13), by expense; possible duplicates too. */
function reimbursedAmounts(contents: ReportContents) {
  const into = contents.report.currency;
  const out = new Map<string, Reimbursed & { tripId: string | null; held: boolean }>();
  if (!contents.amounts || !isCurrencyCode(into)) return undefined;
  for (const a of contents.amounts) {
    if (!isCurrencyCode(a.currency)) continue;
    const amount = money(a.amountMinor, a.currency);
    out.set(a.expenseId, {
      ...reimbursed(amount, a.purchaseDate, into, a.conversion ?? undefined),
      tripId: a.tripId,
      held: a.held,
    });
  }
  return { into, amounts: out };
}

type ReimbursedAmounts = NonNullable<ReturnType<typeof reimbursedAmounts>>;

/** What some amounts add up to in the reimbursement currency; possible duplicates are left out. */
function reimbursementView(
  converted: ReimbursedAmounts,
  keep: (a: { tripId: string | null }) => boolean = () => true,
) {
  const counted = [...converted.amounts.values()].filter((a) => !a.held && keep(a));
  const sum = reimbursementTotal(converted.into, counted);
  return {
    total: totalView(sum.total),
    converting: sum.converting,
    unconverted: sum.unconverted.map(totalView),
  };
}

/** One amount in the reimbursement currency, with the rate it was converted at. */
function reimbursedView(a: Reimbursed) {
  const amount = a.kind === 'same' ? a.amount : a.kind === 'converted' ? a.converted : null;
  return {
    kind: a.kind,
    amount: amount && totalView(amount),
    rate:
      a.kind === 'converted'
        ? { rate: a.rate.rate, date: a.rate.asOf, source: a.rate.source }
        : null,
  };
}

/** A local expense's amount in the reimbursement currency; null while it has none. */
function reimbursedOf(converted: ReimbursedAmounts, expenseId: string) {
  const a = converted.amounts.get(expenseId);
  return a ? reimbursedView(a) : null;
}

/** Each rate a report's amounts were converted at, oldest first, and how many it converted. */
function ratesView(converted: ReimbursedAmounts) {
  const rates = new Map<
    string,
    { from: string; to: string; rate: string; date: string; source: string; expenses: number }
  >();
  for (const a of converted.amounts.values()) {
    if (a.kind !== 'converted') continue;
    const { base, quote, rate, asOf, source } = a.rate;
    const key = `${base}>${quote}@${asOf}:${rate}:${source}`;
    const seen = rates.get(key);
    if (seen) seen.expenses++;
    else rates.set(key, { from: base, to: quote, rate, date: asOf, source, expenses: 1 });
  }
  return [...rates.values()].sort(
    (a, b) => a.date.localeCompare(b.date) || a.from.localeCompare(b.from),
  );
}

/** Sums per currency, as spent, never converted, in a stable order. */
function totalsOf(amounts: readonly { amountMinor: number | null; currency: string | null }[]) {
  const totals = new Map<string, Money>();
  for (const a of amounts) {
    if (a.amountMinor === null || a.currency === null || !isCurrencyCode(a.currency)) continue;
    const amount = money(a.amountMinor, a.currency);
    const sofar = totals.get(a.currency);
    totals.set(a.currency, sofar ? add(sofar, amount) : amount);
  }
  return [...totals.values()].sort((a, b) => a.currency.localeCompare(b.currency)).map(totalView);
}

/**
 * A report as lists and Home show it (FR-EXP-05, FR-EXP-12): what is on it, what holds it
 * open, when it closes, and its totals. warning: open, in its last week, and something still
 * needs review. overdue: open past its day 28 with something still needing attention. With
 * `converting`, while the feature is on and its amounts were loaded, it also totals in its
 * reimbursement currency (FR-EXP-13).
 */
export function reportSummary(contents: ReportContents, now: Date, converting = false) {
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
    ...reimbursementOf(contents, converting),
  };
}

function reimbursementOf(contents: ReportContents, converting: boolean) {
  const converted = converting ? reimbursedAmounts(contents) : undefined;
  return converted ? { reimbursement: reimbursementView(converted) } : {};
}

export type ReportSummary = ReturnType<typeof reportSummary>;

/**
 * A report with each trip and local expense on it, and what each still needs. With
 * `converting`, each is in the reimbursement currency too, with the rates used.
 */
export function reportDetail(contents: ReportContents, now: Date, converting = false) {
  const unsettled = new Map(contents.counts.map((c) => [c.tripId, c.unsettled]));
  const converted = converting ? reimbursedAmounts(contents) : undefined;
  return {
    ...reportSummary(contents, now, converting),
    tripItems: contents.trips.map((t) => {
      const waiting = unsettled.get(t.id) ?? 0;
      return {
        ...tripSummary(t, contents.tallies),
        unsettled: waiting,
        ready: waiting === 0,
        ...(converted
          ? { reimbursement: reimbursementView(converted, (a) => a.tripId === t.id) }
          : {}),
      };
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
      ...(converted ? { reimbursed: reimbursedOf(converted, e.id) } : {}),
    })),
    ...(converted ? { rates: ratesView(converted) } : {}),
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
export function reportItem(contents: ReportContents, now: Date, converting = false) {
  const report = reportSummary(contents, now, converting);
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
