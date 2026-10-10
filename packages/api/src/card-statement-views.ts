import type { CardStatementRecord, CardTransactionRecord, ExpenseRecord } from '@expensewise/db';
import { isCurrencyCode, money, toDecimal } from '@expensewise/domain';
import { CARD_STATEMENTS_FLAG, type CardStore } from './card-statements.ts';
import type { FeatureGate } from './features.ts';
import { amountView } from './receipt-views.ts';

/*
 * Card statements and their transactions as the API shows them (FR-CAP-10, FR-INT-24).
 */

/** A kept amount, for display. A currency kept is always a code, so the decimal is exact. */
const amountOf = (amountMinor: number, currency: string) => {
  if (!isCurrencyCode(currency)) throw new Error(`Not a currency: ${currency}`);
  return { amountMinor, currency, decimal: toDecimal(money(amountMinor, currency)) };
};

export function statementView(s: CardStatementRecord) {
  const total = (minor: number | null) =>
    minor === null || s.currency === null ? null : amountOf(minor, s.currency);
  return {
    id: s.id,
    source: s.source,
    status: s.status,
    problem: s.problem,
    cardLastFour: s.cardLastFour,
    periodStart: s.periodStart,
    periodEnd: s.periodEnd,
    charges: total(s.chargesMinor),
    credits: total(s.creditsMinor),
    added: s.added,
    createdAt: s.createdAt.toISOString(),
  };
}

export type TransactionState = 'missing' | 'matched' | 'set_aside' | 'credit' | 'waiting';

/**
 * Where a transaction stands: paying for an expense, set aside, a credit, waiting for its
 * statement's look, or else a missing receipt (US-CAP-07 AC3).
 */
export function transactionState(
  t: CardTransactionRecord,
  statement: CardStatementRecord | undefined,
): TransactionState {
  if (t.expenseId) return 'matched';
  if (t.setAside) return 'set_aside';
  if (t.amountMinor <= 0) return 'credit';
  return statement?.status === 'read' ? 'missing' : 'waiting';
}

const expenseView = (e: ExpenseRecord) => ({
  id: e.id,
  merchant: e.merchant,
  date: e.transactionDate,
  amount: amountView(e.amountMinor, e.currency),
});

export function cardStatementsView(kept: {
  readonly statements: readonly CardStatementRecord[];
  readonly transactions: readonly CardTransactionRecord[];
  readonly expenses: readonly ExpenseRecord[];
}) {
  const statements = new Map(kept.statements.map((s) => [s.id, s]));
  const expenses = new Map(kept.expenses.map((e) => [e.id, e]));
  const transactions = kept.transactions.map((t) => {
    const expense = t.expenseId ? expenses.get(t.expenseId) : undefined;
    return {
      id: t.id,
      statementId: t.statementId,
      transactionDate: t.transactionDate,
      postedOn: t.postedOn,
      merchant: t.merchant,
      amount: amountOf(t.amountMinor, t.currency),
      cardLastFour: t.cardLastFour,
      state: transactionState(t, statements.get(t.statementId)),
      expense: expense ? expenseView(expense) : null,
      matchedBy: t.matchedBy,
      setAside: t.setAside
        ? { reason: t.setAside.reason, note: t.setAside.note, at: t.setAside.at.toISOString() }
        : null,
    };
  });
  return {
    statements: kept.statements.map(statementView),
    transactions,
    missing: transactions.filter((t) => t.state === 'missing').length,
  };
}

/**
 * A statement waiting for the person's look, as Needs you shows it (US-CAP-07 AC14): what it
 * says doesn't add up, and nothing on it is matched until they look.
 */
export function cardStatementItem(s: CardStatementRecord) {
  return {
    kind: 'card_statement' as const,
    statement: {
      id: s.id,
      periodStart: s.periodStart,
      periodEnd: s.periodEnd,
      cardLastFour: s.cardLastFour,
      problem: s.problem,
    },
    reason: { code: 'statement_needs_look' as const },
  };
}

/** A missing receipt, as Needs you shows it (US-CAP-07 AC3). */
export function cardChargeItem(t: CardTransactionRecord) {
  return {
    kind: 'card' as const,
    transaction: {
      id: t.id,
      date: t.transactionDate,
      merchant: t.merchant,
      amount: amountOf(t.amountMinor, t.currency),
      cardLastFour: t.cardLastFour,
    },
    reason: { code: 'missing_receipt' as const },
  };
}

/**
 * The card charges that paid for an expense, for its page, while card statements are on
 * (US-CAP-07 AC2): one, or several, such as a ride and its tip (AC12), each with what the card
 * was charged, shown beside any conversion (AC7), oldest first. Off, or with none, the page reads
 * as it always has.
 */
export function cardChargeSection(cards: CardStore | undefined, features: FeatureGate) {
  return async (orgId: string, expenseId: string) => {
    if (!cards || !(await features.isOn(orgId, CARD_STATEMENTS_FLAG))) return {};
    const charges = (await cards.ofExpenses(orgId, [expenseId]))
      .filter((t) => t.matchedBy)
      .sort(
        (a, b) =>
          a.transactionDate.localeCompare(b.transactionDate) ||
          b.amountMinor - a.amountMinor ||
          a.id.localeCompare(b.id),
      );
    if (charges.length === 0) return {};
    return {
      cardCharges: charges.map((t) => ({
        id: t.id,
        date: t.transactionDate,
        merchant: t.merchant,
        amount: amountOf(t.amountMinor, t.currency),
        cardLastFour: t.cardLastFour,
        matchedBy: t.matchedBy!,
      })),
    };
  };
}
