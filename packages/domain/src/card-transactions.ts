import { daysBetween, isIsoDate } from './dates.ts';
import { merchantWords } from './duplicates.ts';
import { EXCLUSION_NOTE_MAX } from './itemized.ts';
import { add, sum, zero, type Money } from './money.ts';
import { err, ok, type Result } from './result.ts';

/*
 * A card's transactions, brought in from its statement or a downloaded list (FR-CAP-10), and
 * matched to the expenses they paid for (FR-INT-24, ADR-0007 amended, #97). Money stays integer
 * minor units; every rule here is pure.
 */

/** One line of a card statement: a charge, or a credit as a negative amount. */
export interface CardTransaction {
  /** The day it was made, YYYY-MM-DD. */
  readonly transactionDate: string;
  /** The day it posted to the account; null when not printed. */
  readonly postedOn: string | null;
  /** The merchant as the card prints it, such as "DELTA AIR 0062345678901 ATLANTA GA". */
  readonly merchant: string;
  readonly amount: Money;
  readonly cardLastFour: string | null;
  /** The issuer's reference for it, when printed. */
  readonly reference: string | null;
}

/**
 * How many days apart a transaction and its expense may be: a receipt is dated the day of the
 * purchase, and a card can print the day it was authorized or posted (R-MATCH-DAYS).
 */
export const MATCH_DAYS = 3;

/**
 * A key that is the same each time a transaction is printed, so a statement read twice, or a
 * later one that lists it again, adds it once (US-CAP-07 AC4). Two identical charges on one day,
 * such as two coffees, are told apart by their order on the statement.
 */
export function transactionKeys(transactions: readonly CardTransaction[]): string[] {
  const seen = new Map<string, number>();
  return transactions.map((t) => {
    const base = [
      t.cardLastFour ?? '',
      t.transactionDate,
      t.amount.currency,
      String(t.amount.amountMinor),
      merchantWords(t.merchant).join(' '),
      t.reference?.trim() ?? '',
    ].join('|');
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return `${base}#${n}`;
  });
}

/** Words of a merchant's name that say which business it is: no numbers, nothing shorter than 3. */
const nameWords = (name: string) =>
  merchantWords(name).filter((w) => w.length >= 3 && !/^\d+$/.test(w));

/**
 * How alike two merchant names are, from 0 to 1: how many of the shorter name's words are found
 * in the other, out of at most two, since a business's name leads and a card adds its city and
 * a store number ("DELTA AIR 0062 ATLANTA GA" and "Delta Air Lines" are alike). A word matches
 * when one begins the other ("MARRIOTT" and "Marriott's"). It only ranks candidates.
 */
export function merchantLikeness(a: string, b: string): number {
  const x = nameWords(a);
  const y = nameWords(b);
  if (x.length === 0 || y.length === 0) return 0;
  const [shorter, longer] = x.length <= y.length ? [x, y] : [y, x];
  const found = shorter.filter((w) =>
    longer.some(
      (v) => v === w || (Math.min(v.length, w.length) >= 4 && (v.startsWith(w) || w.startsWith(v))),
    ),
  ).length;
  return Math.min(1, found / Math.min(shorter.length, 2));
}

/** A transaction not yet matched or set aside. */
export interface OpenTransaction {
  readonly id: string;
  readonly transactionDate: string;
  readonly merchant: string;
  readonly amount: Money;
}

/** An expense a transaction may have paid for: one of the same person's, not yet matched. */
export interface MatchableExpense {
  readonly id: string;
  readonly transactionDate: string | null;
  readonly merchant: string | null;
  readonly amount: Money | null;
}

export interface TransactionMatch {
  readonly transactionId: string;
  readonly expenseId: string;
}

/**
 * Which open transactions paid for which expenses (FR-INT-24, US-CAP-07 AC2): the same amount in
 * the same currency, dated within MATCH_DAYS of each other, each transaction to at most one
 * expense and each expense to at most one transaction. Where several fit, the closer merchant
 * name, then the nearer date, wins; a tie is left for the person, so nothing is guessed. A
 * credit, or a charge in another currency than its expense, is matched only by a person.
 */
export function matchTransactions(
  transactions: readonly OpenTransaction[],
  expenses: readonly MatchableExpense[],
): TransactionMatch[] {
  type Pair = { t: string; e: string; score: number };
  const pairs: Pair[] = [];
  for (const t of transactions) {
    if (t.amount.amountMinor <= 0 || !isIsoDate(t.transactionDate)) continue;
    for (const e of expenses) {
      if (!e.amount || !e.transactionDate || !isIsoDate(e.transactionDate)) continue;
      if (e.amount.currency !== t.amount.currency) continue;
      if (e.amount.amountMinor !== t.amount.amountMinor) continue;
      const days = Math.abs(daysBetween(t.transactionDate, e.transactionDate));
      if (days > MATCH_DAYS) continue;
      const likeness = e.merchant ? merchantLikeness(t.merchant, e.merchant) : 0;
      pairs.push({ t: t.id, e: e.id, score: likeness * 10 - days });
    }
  }
  const best = (key: 't' | 'e', id: string) =>
    pairs.filter((p) => p[key] === id).sort((a, b) => b.score - a.score);
  // A pair is taken when it is the clear best for both its transaction and its expense.
  const clear = (p: Pair) =>
    [best('t', p.t), best('e', p.e)].every(
      (ranked) => ranked[0] === p && (ranked.length === 1 || ranked[1]!.score < p.score),
    );
  const taken = new Set<string>();
  const matches: TransactionMatch[] = [];
  for (const p of [...pairs].sort((a, b) => b.score - a.score)) {
    if (taken.has(p.t) || taken.has(p.e) || !clear(p)) continue;
    taken.add(p.t);
    taken.add(p.e);
    matches.push({ transactionId: p.t, expenseId: p.e });
  }
  return matches;
}

/**
 * Whether a statement's transactions make the totals it prints (US-CAP-07 AC5): its charges come
 * to its purchases and other charges, and its credits to its credits, exactly, as printed
 * amounts do. A total it doesn't print can't be checked; a list with neither always passes.
 * Some print their purchases net of credits, with no credits of their own, as U.S. Bank's
 * Cardholder Activity does: charges less credits making that total adds up too (AC11, GAP-51).
 */
export type StatementCheck =
  | { readonly addsUp: true }
  | {
      readonly addsUp: false;
      readonly problem: 'charges' | 'credits';
      readonly comesTo: Money;
      readonly against: Money;
    };

export function checkStatement(
  currency: string,
  transactions: readonly Pick<CardTransaction, 'amount'>[],
  printed: { readonly charges: Money | null; readonly credits: Money | null },
): StatementCheck {
  const charges = sum(
    currency,
    transactions.filter((t) => t.amount.amountMinor > 0).map((t) => t.amount),
  );
  const credits = transactions
    .filter((t) => t.amount.amountMinor < 0)
    .reduce(
      (total, t) => add(total, { ...t.amount, amountMinor: -t.amount.amountMinor }),
      zero(currency),
    );
  // No credits printed apart, or none at all: a "Payments $0.00" can be read as one.
  const noCreditsApart = !printed.credits || printed.credits.amountMinor === 0;
  const netOfCredits =
    noCreditsApart &&
    credits.amountMinor > 0 &&
    printed.charges?.amountMinor === charges.amountMinor - credits.amountMinor;
  if (netOfCredits) return { addsUp: true };
  if (printed.charges && printed.charges.amountMinor !== charges.amountMinor) {
    return { addsUp: false, problem: 'charges', comesTo: charges, against: printed.charges };
  }
  if (printed.credits && printed.credits.amountMinor !== credits.amountMinor) {
    return { addsUp: false, problem: 'credits', comesTo: credits, against: printed.credits };
  }
  return { addsUp: true };
}

export const SET_ASIDE_REASONS = ['personal', 'no_receipt', 'not_an_expense', 'other'] as const;
/**
 * Why a transaction needs no receipt here (US-CAP-07 AC3): a personal charge on the card, a
 * receipt that can't be had, a charge that isn't an expense, such as a card fee, or other.
 */
export type SetAsideReason = (typeof SET_ASIDE_REASONS)[number];

export const SET_ASIDE_LABELS: Readonly<Record<SetAsideReason, string>> = {
  personal: 'Personal',
  no_receipt: 'No receipt to be had',
  not_an_expense: 'Not an expense',
  other: 'Other',
};

/** The longest note on a transaction set aside, as on an excluded line (R-EXCLUSION-NOTE-MAX). */
export const SET_ASIDE_NOTE_MAX = EXCLUSION_NOTE_MAX;

export type SetAsideProblem = 'unknown_reason' | 'note_needed' | 'note_too_long';

/** A reason from the list and an optional note, which other needs, as a line's exclusion does. */
export function checkSetAside(
  reason: string,
  note?: string | null,
): Result<{ readonly reason: SetAsideReason; readonly note: string | null }, SetAsideProblem> {
  if (!(SET_ASIDE_REASONS as readonly string[]).includes(reason)) return err('unknown_reason');
  const text = note?.trim() ? note.trim() : null;
  if (text && text.length > SET_ASIDE_NOTE_MAX) return err('note_too_long');
  if (reason === 'other' && !text) return err('note_needed');
  return ok({ reason: reason as SetAsideReason, note: text });
}
