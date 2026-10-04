import type { CurrencyCode } from './currency.ts';
import { DomainError } from './errors.ts';
import {
  add,
  allocateToLargest,
  format,
  fromDecimal,
  isNegative,
  subtract,
  sum,
  zero,
  type Money,
} from './money.ts';
import { err, ok, type Result } from './result.ts';

/*
 * A receipt's itemized lines on its expense (FR-INT-22, FR-EXP-15, FR-EXP-16, ADR-0041): the
 * lines as read, whether they add up to the receipt, each item line's share of the tax, tip
 * and fees, what excluding a line leaves claimed, and the parts a split makes. Money stays
 * integer minor units throughout; every spread is exact.
 */

export const LINE_KINDS = ['item', 'tax', 'fee', 'tip'] as const;
/** item: something bought, or a discount as a negative item. The rest are spread across items. */
export type LineKind = (typeof LINE_KINDS)[number];

/** One line of a receipt, as it was read. */
export interface ReadLine {
  readonly kind: LineKind;
  readonly description: string;
  readonly quantity: string | null;
  readonly amount: Money;
}

/**
 * A receipt's lines as an expense keeps them, copied from its reading with the total and
 * subtotal read. Lines are numbered from 1 in this order: the items as printed, then each tax,
 * each fee and the tip.
 */
export interface Itemization {
  readonly currency: CurrencyCode;
  readonly total: Money | null;
  readonly subtotal: Money | null;
  readonly lines: readonly ReadLine[];
}

/**
 * How far lines may miss what they should come to: one minor unit for each line counted, since
 * a receipt rounds each line on its own (R-LINES-TOLERANCE).
 */
export const LINE_TOLERANCE_MINOR = 1;

/**
 * Why lines don't add up. subtotal: the items miss the printed subtotal. total: with tax, tip
 * and fees they miss the total. no_total: no total was read to check them against.
 * not_positive: the items come to nothing or less, so nothing can be spread across them.
 */
export type LinesProblem = 'subtotal' | 'total' | 'no_total' | 'not_positive';

export type LinesCheck =
  | {
      readonly addsUp: true;
      /** What the item lines come to. */
      readonly items: Money;
      /** The total less the items: the tax, tip and fees spread across them, exactly. */
      readonly extras: Money;
      /** The prices include their tax, as VAT receipts print them; the tax is not added again. */
      readonly taxIncluded: boolean;
    }
  | {
      readonly addsUp: false;
      readonly problem: LinesProblem;
      /** What the lines come to, as compared. */
      readonly comesTo: Money;
      /** What they should come to; null when nothing was read to compare. */
      readonly against: Money | null;
    };

const ofKind = (it: Itemization, kind: LineKind) =>
  it.lines.filter((l) => l.kind === kind).map((l) => l.amount);

/**
 * Whether a receipt's lines add up (ADR-0041, Claude’s rule): the items to the subtotal where
 * one is printed, and with the taxes, tip and fees to the total, each within a cent per line.
 * Prices that include their tax add up too: then the items and fees alone make the total, and
 * the subtotal may be printed before or after its tax.
 */
export function checkLines(it: Itemization): LinesCheck {
  const items = sum(it.currency, ofKind(it, 'item'));
  const taxes = sum(it.currency, ofKind(it, 'tax'));
  const others = sum(it.currency, [...ofKind(it, 'fee'), ...ofKind(it, 'tip')]);
  const count = (kind: LineKind) => it.lines.filter((l) => l.kind === kind).length;
  const near = (a: Money, b: Money, lines: number) =>
    Math.abs(subtract(a, b).amountMinor) <= lines * LINE_TOLERANCE_MINOR;
  const withTax = add(add(items, taxes), others);
  const taxLines = count('tax');

  if (
    it.subtotal &&
    !near(items, it.subtotal, count('item')) &&
    !(taxLines > 0 && near(items, add(it.subtotal, taxes), count('item') + taxLines))
  ) {
    return { addsUp: false, problem: 'subtotal', comesTo: items, against: it.subtotal };
  }
  if (!it.total) return { addsUp: false, problem: 'no_total', comesTo: withTax, against: null };
  const added = near(withTax, it.total, it.lines.length);
  const included =
    !added && taxLines > 0 && near(add(items, others), it.total, it.lines.length - taxLines);
  if (!added && !included) {
    return { addsUp: false, problem: 'total', comesTo: withTax, against: it.total };
  }
  if (items.amountMinor <= 0) {
    return { addsUp: false, problem: 'not_positive', comesTo: items, against: null };
  }
  return { addsUp: true, items, extras: subtract(it.total, items), taxIncluded: included };
}

/** What a person reads when lines don't add up, said plainly. */
export function linesProblemText(problem: LinesProblem, comesTo: Money, against: Money | null) {
  const shown = (m: Money | null) => (m ? format(m) : '');
  switch (problem) {
    case 'subtotal':
      return `These lines come to ${shown(comesTo)}, but the receipt’s subtotal is ${shown(against)}.`;
    case 'total':
      return `With tax, tip and fees these lines come to ${shown(comesTo)}, but the receipt’s total is ${shown(against)}.`;
    case 'no_total':
      return 'The receipt’s total wasn’t read, so its lines can’t be checked against it.';
    case 'not_positive':
      return `These lines come to ${shown(comesTo)}, so tax, tip and fees can’t be spread across them.`;
  }
}

/** An item line with its share of the tax, tip and fees. */
export interface LineClaim {
  /** Its number on the receipt, from 1. */
  readonly position: number;
  /** As read. */
  readonly amount: Money;
  /** Its share of the tax, tip and fees, in proportion to its amount. */
  readonly share: Money;
  /** The line and its share: what leaving it out takes off the claim. */
  readonly claimed: Money;
}

/**
 * Each item line with its share of the tax, tip and fees (Q37): what the total has beyond the
 * items, spread across them in proportion to their amounts, in whole minor units, the largest
 * share taking any unit left over, so every line and its share add up to the receipt’s total
 * exactly. A discount, a negative line, takes a negative share. Null when the lines don't
 * add up: then nothing is spread.
 */
export function lineClaims(it: Itemization): LineClaim[] | null {
  const check = checkLines(it);
  if (!check.addsUp) return null;
  const items = it.lines
    .map((line, i) => ({ line, position: i + 1 }))
    .filter((x) => x.line.kind === 'item');
  const shares = allocateToLargest(
    check.extras,
    items.map((x) => x.line.amount.amountMinor),
  );
  return items.map((x, i) => {
    const share = shares[i] ?? zero(it.currency);
    return {
      position: x.position,
      amount: x.line.amount,
      share,
      claimed: add(x.line.amount, share),
    };
  });
}

export const EXCLUSION_REASONS = [
  'personal',
  'paid_by_someone_else',
  'not_reimbursable',
  'other',
] as const;
/** Why a line is left out of the claim (Q38). */
export type ExclusionReason = (typeof EXCLUSION_REASONS)[number];

/** As a person reads it. */
export const EXCLUSION_REASON_LABELS: Readonly<Record<ExclusionReason, string>> = {
  personal: 'Personal',
  paid_by_someone_else: 'Paid by someone else',
  not_reimbursable: 'Not reimbursable',
  other: 'Other',
};

/** The longest note on an excluded line (R-EXCLUSION-NOTE-MAX). */
export const EXCLUSION_NOTE_MAX = 200;

export interface Exclusion {
  readonly reason: ExclusionReason;
  readonly note: string | null;
}

export type ExclusionProblem = 'unknown_reason' | 'note_needed' | 'note_too_long';

/**
 * A reason picked from the list, with an optional note (Q38). Other needs the note, since
 * other alone says nothing: Claude’s assumption, for the product owner to confirm.
 */
export function checkExclusion(
  reason: string,
  note?: string | null,
): Result<Exclusion, ExclusionProblem> {
  if (!(EXCLUSION_REASONS as readonly string[]).includes(reason)) return err('unknown_reason');
  const text = note?.trim() ? note.trim() : null;
  if (text && text.length > EXCLUSION_NOTE_MAX) return err('note_too_long');
  if (reason === 'other' && !text) return err('note_needed');
  return ok({ reason: reason as ExclusionReason, note: text });
}

/** What an itemized receipt’s expense claims: the receipt, what is left out of it, and the rest. */
export interface ItemizedClaim {
  readonly receipt: Money;
  readonly excluded: Money;
  readonly claimed: Money;
}

/**
 * Why lines can't be used as asked. lines_dont_add_up: they don't add up, so nothing is spread.
 * no_such_line, not_an_item: only a receipt's item lines are left out or split; tax, tip and
 * fees go with them. takes_off: a discount lowers what was paid, so it can't be left out.
 * below_zero: what is left would claim less than nothing.
 */
export type LineProblem =
  'lines_dont_add_up' | 'no_such_line' | 'not_an_item' | 'takes_off' | 'below_zero';

/**
 * What the expense claims with these lines left out (FR-EXP-16): the receipt’s total less each
 * line and its share of the tax, tip and fees.
 */
export function claimWithout(
  it: Itemization,
  excluded: ReadonlySet<number>,
): Result<ItemizedClaim, LineProblem> {
  const claims = lineClaims(it);
  if (!claims || !it.total) return err('lines_dont_add_up');
  const left: Money[] = [];
  for (const position of excluded) {
    const line = it.lines[position - 1];
    if (!line) return err('no_such_line');
    const claim = claims.find((c) => c.position === position);
    if (!claim) return err('not_an_item');
    if (isNegative(claim.claimed)) return err('takes_off');
    left.push(claim.claimed);
  }
  const out = sum(it.currency, left);
  const claimed = subtract(it.total, out);
  if (isNegative(claimed)) return err('below_zero');
  return ok({ receipt: it.total, excluded: out, claimed });
}

/**
 * Why the lines can't be excluded or split by line now. other_currency: the expense was
 * changed to another currency than its receipt’s. amount_changed: its amount was changed by
 * hand from what its lines claim, so they no longer make it up.
 */
export type LineToolsProblem = 'lines_dont_add_up' | 'other_currency' | 'amount_changed';

/**
 * Whether the lines make up what the expense claims, so excluding and splitting by line can be
 * used: they add up, are in its currency, and claim what it claims.
 */
export function lineTools(
  it: Itemization,
  excluded: ReadonlySet<number>,
  expense: { readonly amountMinor: number | null; readonly currency: string | null },
): Result<ItemizedClaim, LineToolsProblem> {
  const claim = claimWithout(it, excluded);
  if (!claim.ok) return err('lines_dont_add_up');
  if (expense.currency !== it.currency) return err('other_currency');
  if (expense.amountMinor !== claim.value.claimed.amountMinor) return err('amount_changed');
  return claim;
}

/** What a person reads when the lines can't be used. */
export function lineToolsText(problem: LineToolsProblem, it: Itemization, claimed: Money | null) {
  switch (problem) {
    case 'lines_dont_add_up':
      return 'Its lines don’t add up, so they can’t be excluded or split by line. It can still be split by amount.';
    case 'other_currency':
      return `This expense isn’t in ${it.currency}, as its receipt’s lines are, so they can’t be excluded or split by line.`;
    case 'amount_changed':
      return `This expense’s amount was changed by hand from the ${claimed ? format(claimed) : 'amount'} its lines come to, so they can’t be excluded or split by line. It can still be split by amount.`;
  }
}

/** The most parts one expense is split into (R-SPLIT-PARTS-MAX). */
export const SPLIT_PARTS_MAX = 20;

/** A part of a split expense. A null category and type is the expense’s own. */
export interface Part {
  readonly categoryId: string | null;
  readonly typeId: string | null;
  readonly amount: Money;
  /** The item lines it is made of; none for a part typed by amount. */
  readonly positions: readonly number[];
}

/** A line given a category and type, so it is a part of the expense of its own (Q36). */
export interface LineAssignment {
  readonly position: number;
  readonly categoryId: string;
  readonly typeId: string;
}

export type SplitProblem =
  | LineProblem
  | 'nothing_split'
  | 'line_excluded'
  | 'assigned_twice'
  | 'part_not_positive'
  | 'too_few_parts'
  | 'too_many_parts'
  | 'invalid_amount'
  | 'parts_dont_add_up';

/**
 * The parts lines given categories and types make (FR-EXP-15, Q36): a part for each category
 * and type given, of its lines and their shares of the tax, tip and fees; the lines given none
 * stay together, with the expense’s own category and type, first. Excluded lines are in no
 * part. With `strict`, as a person asks for a split, a line given twice or excluded is refused;
 * otherwise, as the parts are worked out again after an exclusion, an excluded line’s choice is
 * kept for when it is included again. No part is made when only the expense’s own would be.
 */
export function partsByLine(
  it: Itemization,
  excluded: ReadonlySet<number>,
  assignments: readonly LineAssignment[],
  strict = true,
): Result<Part[], SplitProblem> {
  const claims = lineClaims(it);
  if (!claims) return err('lines_dont_add_up');
  const given = new Map<number, LineAssignment>();
  for (const a of assignments) {
    if (!it.lines[a.position - 1]) return err('no_such_line');
    if (!claims.some((c) => c.position === a.position)) return err('not_an_item');
    if (strict && given.has(a.position)) return err('assigned_twice');
    if (strict && excluded.has(a.position)) return err('line_excluded');
    given.set(a.position, a);
  }
  if (strict && given.size === 0) return err('nothing_split');
  const groups = new Map<
    string,
    { categoryId: string | null; typeId: string | null; lines: LineClaim[] }
  >();
  const own = { categoryId: null, typeId: null, lines: [] as LineClaim[] };
  for (const claim of claims) {
    if (excluded.has(claim.position)) continue;
    const a = given.get(claim.position);
    if (!a) {
      own.lines.push(claim);
      continue;
    }
    const key = `${a.categoryId}/${a.typeId}`;
    const group = groups.get(key) ?? { categoryId: a.categoryId, typeId: a.typeId, lines: [] };
    group.lines.push(claim);
    groups.set(key, group);
  }
  if (groups.size === 0) return ok([]);
  const parts = [...(own.lines.length > 0 ? [own] : []), ...groups.values()].map((g) => ({
    categoryId: g.categoryId,
    typeId: g.typeId,
    amount: sum(
      it.currency,
      g.lines.map((l) => l.claimed),
    ),
    positions: g.lines.map((l) => l.position),
  }));
  if (parts.length > SPLIT_PARTS_MAX) return err('too_many_parts');
  if (parts.some((p) => p.amount.amountMinor <= 0)) return err('part_not_positive');
  return ok(parts);
}

/** A part as a person types it: a category, a type and an amount such as "12.50". */
export interface TypedPart {
  readonly categoryId: string;
  readonly typeId: string;
  readonly amount: string;
}

/**
 * Parts typed by amount, where a receipt isn't itemized or its lines don't add up (Q36): at
 * least two, each more than zero, in the claim’s currency, adding up to the claim exactly, or
 * the split is refused. `index` names the part a problem is in, from 0.
 */
export function partsByAmount(
  claim: Money,
  typed: readonly TypedPart[],
): Result<Part[], { readonly problem: SplitProblem; readonly index?: number }> {
  if (typed.length < 2) return err({ problem: 'too_few_parts' });
  if (typed.length > SPLIT_PARTS_MAX) return err({ problem: 'too_many_parts' });
  const parts: Part[] = [];
  for (const [index, t] of typed.entries()) {
    let amount: Money;
    try {
      amount = fromDecimal(t.amount.trim(), claim.currency);
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      return err({ problem: 'invalid_amount', index });
    }
    if (amount.amountMinor <= 0) return err({ problem: 'part_not_positive', index });
    parts.push({ categoryId: t.categoryId, typeId: t.typeId, amount, positions: [] });
  }
  const total = sum(
    claim.currency,
    parts.map((p) => p.amount),
  );
  if (total.amountMinor !== claim.amountMinor) return err({ problem: 'parts_dont_add_up' });
  return ok(parts);
}

/** One amount a report counts under a category and type: a part, or a whole expense. */
export interface CategorizedAmount {
  readonly categoryId: string | null;
  readonly category: string | null;
  readonly typeId: string | null;
  readonly type: string | null;
  readonly amount: Money;
}

/** A report’s spend under one category and type, a sum per currency as spent. */
export interface CategoryTotal {
  readonly categoryId: string | null;
  readonly category: string | null;
  readonly typeId: string | null;
  readonly type: string | null;
  readonly totals: readonly Money[];
}

/**
 * A report’s spend by category and type (FR-EXP-15): each part of a split expense under its
 * own, the rest under the expense’s. Sorted by category, then type; what has none comes last.
 */
export function categoryTotals(amounts: readonly CategorizedAmount[]): CategoryTotal[] {
  const rows = new Map<string, CategoryTotal & { sums: Map<string, Money> }>();
  for (const a of amounts) {
    const key = `${a.categoryId ?? ''}/${a.typeId ?? ''}`;
    const row = rows.get(key) ?? {
      categoryId: a.categoryId,
      category: a.category,
      typeId: a.typeId,
      type: a.type,
      totals: [],
      sums: new Map<string, Money>(),
    };
    const sofar = row.sums.get(a.amount.currency);
    row.sums.set(a.amount.currency, sofar ? add(sofar, a.amount) : a.amount);
    rows.set(key, row);
  }
  // What has no name comes after everything that has one.
  const byName = (a: string | null, b: string | null) =>
    a === b ? 0 : a === null ? 1 : b === null ? -1 : a.localeCompare(b);
  return [...rows.values()]
    .sort((a, b) => byName(a.category, b.category) || byName(a.type, b.type))
    .map(({ sums, ...row }) => ({
      ...row,
      totals: [...sums.values()].sort((a, b) => a.currency.localeCompare(b.currency)),
    }));
}
