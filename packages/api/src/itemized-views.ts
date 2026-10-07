import type {
  CategorizedExpense,
  ExpenseRecord,
  PartRecord,
  StoredItemization,
  StoredLine,
} from '@expensewise/db';
import {
  allocate,
  categoryTotals,
  checkLines,
  claimWithout,
  isCurrencyCode,
  isIsoDate,
  lineClaims,
  lineTools,
  lineToolsText,
  linesProblemText,
  money,
  purchaseClaims,
  purchasesOf,
  reimbursed,
  sum,
  toDecimal,
  type CategorizedAmount,
  type Itemization,
  type Money,
  type ReadLine,
} from '@expensewise/domain';
import { itemizationOf } from '@expensewise/extraction';
import { filedRun } from './receipt-views.ts';
import type { ReceiptWithReadings } from './receipts.ts';

/*
 * How an expense's itemized lines, its split and a report's totals by category and type read
 * (FR-INT-22, FR-EXP-15, FR-EXP-16, ADR-0041).
 */

const view = (m: Money) => ({
  amountMinor: m.amountMinor,
  currency: m.currency,
  decimal: toDecimal(m),
});

/**
 * The lines of the reading an expense's receipt is filed with: what an expense filed before
 * lines were copied onto it shows, and takes as its own on its first change.
 */
export function readLinesOf(proof: ReceiptWithReadings | null): Itemization | null {
  if (!proof) return null;
  const run = filedRun(proof.receipt, proof.runs, proof.reviews);
  return run ? itemizationOf(run.output) : null;
}

const isStored = (line: ReadLine): line is StoredLine => 'position' in line;

/**
 * An expense's itemized lines as its page shows them (FR-INT-22): each as read with its share
 * of the tax, tip and fees, whether they add up and why not, what is excluded and why, what is
 * claimed, and whether lines can be excluded or split by line now. Null for none.
 */
export function itemizedView(
  expense: ExpenseRecord,
  lines: StoredItemization | Itemization | null,
) {
  if (!lines) return null;
  const stored = (lines.lines as readonly ReadLine[]).filter(isStored);
  const excluded = new Set(stored.filter((l) => l.excluded).map((l) => l.position));
  const check = checkLines(lines);
  const claims = lineClaims(lines);
  const tools = lineTools(lines, excluded, expense);
  const claim = claimWithout(lines, excluded);
  const fromLines = claim.ok ? claim.value.claimed : null;
  // A purchase left out takes the reason its items were left out with (FR-EXP-20).
  const reasonOf = (items: readonly number[]) =>
    stored.find((l) => items.includes(l.position) && l.excluded)?.excluded ?? null;
  return {
    currency: lines.currency,
    total: lines.total ? view(lines.total) : null,
    subtotal: lines.subtotal ? view(lines.subtotal) : null,
    lines: lines.lines.map((l, i) => {
      const position = i + 1;
      const share = claims?.find((c) => c.position === position);
      const kept = isStored(l) ? l : null;
      return {
        position,
        kind: l.kind,
        description: l.description,
        quantity: l.quantity,
        amount: view(l.amount),
        share: share ? view(share.share) : null,
        claimed: share ? view(share.claimed) : null,
        excluded: kept?.excluded
          ? {
              reason: kept.excluded.reason,
              note: kept.excluded.note,
              at: kept.excluded.at.toISOString(),
            }
          : null,
        purchase: purchasesOf(lines).length > 0 ? (l.purchase ?? null) : null,
        part:
          kept?.categoryId && kept.typeId
            ? { categoryId: kept.categoryId, typeId: kept.typeId }
            : null,
      };
    }),
    purchases: purchaseClaims(lines, excluded).map((p) => {
      const left = p.excluded ? reasonOf(p.items) : null;
      return {
        number: p.number,
        description: p.description,
        date: p.date,
        cardLastFour: p.cardLastFour,
        total: p.total ? view(p.total) : null,
        claimed: p.claimed ? view(p.claimed) : null,
        lines: [...p.lines],
        excluded: left ? { reason: left.reason, note: left.note } : null,
      };
    }),
    addsUp: check.addsUp,
    problem: check.addsUp
      ? null
      : {
          code: check.problem,
          message: linesProblemText(
            check.problem,
            check.comesTo,
            check.against,
            check.purchase ? purchasesOf(lines)[check.purchase - 1]?.description : undefined,
          ),
        },
    claim: claim.ok
      ? {
          receipt: view(claim.value.receipt),
          excluded: view(claim.value.excluded),
          claimed: view(claim.value.claimed),
        }
      : null,
    byLine: tools.ok
      ? { usable: true, code: null, message: null }
      : { usable: false, code: tools.error, message: lineToolsText(tools.error, lines, fromLines) },
  };
}

/** An expense's split as its page shows it; null when it isn't split. */
export function splitView(parts: readonly PartRecord[]) {
  const [first] = parts;
  if (!first) return null;
  return {
    basis: first.basis,
    parts: parts.map((p) => ({
      position: p.position,
      own: p.categoryId === null,
      category: p.categoryId && p.category ? { id: p.categoryId, name: p.category } : null,
      type: p.typeId && p.type ? { id: p.typeId, name: p.type } : null,
      amount: view(money(p.amountMinor, p.currency)),
      lines: [] as number[],
    })),
  };
}

/** The split with the lines each part is made of, from the lines given its category and type. */
export function splitWithLines(parts: readonly PartRecord[], lines: StoredItemization | undefined) {
  const split = splitView(parts);
  if (!split || !lines || split.basis !== 'lines') return split;
  const items = lines.lines.filter((l) => l.kind === 'item' && !l.excluded);
  return {
    ...split,
    parts: split.parts.map((p) => ({
      ...p,
      lines: items
        .filter((l) =>
          p.own
            ? l.categoryId === null
            : l.categoryId === p.category?.id && l.typeId === p.type?.id,
        )
        .map((l) => l.position),
    })),
  };
}

/**
 * A report's spend by category and type (FR-EXP-15): each part of a split expense under its
 * own, the lines left with an expense's own and every other expense under the expense's. While
 * currency conversion is on, each row also says what it comes to in the report's currency so
 * far: each part takes its share of its expense's conversion, in proportion, so the parts of
 * one expense add up to its converted amount exactly (ADR-0034).
 */
export function categoriesView(
  reportId: string,
  currency: string,
  expenses: readonly CategorizedExpense[],
  converting: boolean,
) {
  type Counted = CategorizedAmount & { readonly converted: Money | null };
  const amounts = expenses.flatMap((e): Counted[] => {
    if (!isCurrencyCode(e.currency)) return [];
    const own = { categoryId: e.categoryId, category: e.category, typeId: e.typeId, type: e.type };
    const parts =
      e.parts.length > 0
        ? e.parts.map((p) => ({
            ...(p.categoryId === null
              ? own
              : { categoryId: p.categoryId, category: p.category, typeId: p.typeId, type: p.type }),
            amount: money(p.amountMinor, e.currency),
          }))
        : [{ ...own, amount: money(e.amountMinor, e.currency) }];
    if (!converting || !isCurrencyCode(currency))
      return parts.map((p) => ({ ...p, converted: null }));
    const spent = money(e.amountMinor, e.currency);
    const r =
      e.purchaseDate && isIsoDate(e.purchaseDate)
        ? reimbursed(spent, e.purchaseDate, currency, e.conversion ?? undefined)
        : null;
    const into = r?.kind === 'same' ? r.amount : r?.kind === 'converted' ? r.converted : null;
    // Every part of a split is more than zero; a whole expense takes all of its conversion.
    const shares = !into
      ? null
      : parts.length === 1
        ? [into]
        : allocate(
            into,
            parts.map((p) => p.amount.amountMinor),
          );
    return parts.map((p, i) => ({ ...p, converted: shares?.[i] ?? null }));
  });
  const key = (a: { categoryId: string | null; typeId: string | null }) =>
    `${a.categoryId ?? ''}/${a.typeId ?? ''}`;
  return {
    reportId,
    currency,
    rows: categoryTotals(amounts).map((row) => {
      const mine = amounts.filter((a) => key(a) === key(row));
      const converted = mine.flatMap((a) => (a.converted ? [a.converted] : []));
      return {
        category:
          row.categoryId && row.category ? { id: row.categoryId, name: row.category } : null,
        type: row.typeId && row.type ? { id: row.typeId, name: row.type } : null,
        totals: row.totals.map(view),
        ...(converting && isCurrencyCode(currency)
          ? {
              reimbursed: view(sum(currency, converted)),
              converting: mine.filter((a) => !a.converted).length,
            }
          : {}),
      };
    }),
  };
}
