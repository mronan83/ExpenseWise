import {
  bringBackCardTransaction,
  cardTransactionsOfExpenses,
  confirmCardStatement,
  deleteCardStatement,
  expensesByIds,
  fileCardStatement,
  listCardStatements,
  matchableExpenses,
  matchCardTransactions,
  matchCardTransactionTo,
  recordCardList,
  setAsideCardTransaction,
  unmatchCardTransaction,
  type CardChangeResult,
  type CardStatementRecord,
  type CardTransactionRecord,
  type Database,
  type ExpenseRecord,
  type FileStatementResult,
  type NewCardStatement,
} from '@expensewise/db';
import type { CardTransaction } from '@expensewise/domain';
import { asCaller } from './caller.ts';
import type { FeatureGate } from './features.ts';

/** Card statements, brought in and matched to expenses (FR-CAP-10, FR-INT-24, ADR-0046). */
export const CARD_STATEMENTS_FLAG = 'expenses.card-statements' as const;

/** An expense a transaction might be matched to by hand. */
export interface MatchableExpense {
  readonly id: string;
  readonly merchant: string | null;
  readonly transactionDate: string | null;
  readonly amountMinor: number | null;
  readonly currency: string | null;
  /** What the charges already matched to it come to, in minor units: one expense can be paid by several (ADR-0051). */
  readonly chargedMinor: number;
}

/** A downloaded transaction list, read in the request with no model (US-CAP-07 AC6). */
export interface NewCardList {
  readonly id: string;
  readonly memberId: string;
  readonly byteSize: number;
  readonly sha256: string;
  readonly currency: string;
  readonly transactions: readonly CardTransaction[];
}

export type RecordListResult =
  | {
      readonly status: 'filed';
      readonly statementId: string;
      readonly added: number;
      readonly matched: number;
    }
  | { readonly status: 'exists'; readonly statementId: string };

/**
 * What the API needs from the database for card statements. Every change appends its audit
 * event in the same transaction; a statement and its transactions are their member's own
 * (ADR-0035). Tests use an in-memory fake.
 */
export interface CardStore {
  file(
    orgId: string,
    statement: NewCardStatement,
    actorUserId: string,
  ): Promise<FileStatementResult>;
  recordList(orgId: string, list: NewCardList, actorUserId: string): Promise<RecordListResult>;
  /** The member's statements, newest first, their transactions, and the expenses matched. */
  list(
    orgId: string,
    memberId: string,
  ): Promise<{
    readonly statements: CardStatementRecord[];
    readonly transactions: CardTransactionRecord[];
    readonly expenses: ExpenseRecord[];
  }>;
  /** The member's expenses near a day, not yet matched, nearest first. */
  matchable(orgId: string, memberId: string, around: string): Promise<MatchableExpense[]>;
  setAside(
    orgId: string,
    transactionId: string,
    input: { readonly reason: string; readonly note?: string | null },
    actorUserId: string,
  ): Promise<CardChangeResult>;
  bringBack(orgId: string, transactionId: string, actorUserId: string): Promise<CardChangeResult>;
  matchTo(
    orgId: string,
    transactionId: string,
    expenseId: string,
    actorUserId: string,
  ): Promise<CardChangeResult>;
  unmatch(orgId: string, transactionId: string, actorUserId: string): Promise<CardChangeResult>;
  /** Matches the member's open transactions again; how many were matched. */
  matchAgain(orgId: string, memberId: string, actorUserId: string): Promise<number>;
  confirm(orgId: string, statementId: string, actorUserId: string): Promise<CardChangeResult>;
  /** Where its file was, to remove once this commits; undefined when there is no such statement. */
  remove(
    orgId: string,
    statementId: string,
    actorUserId: string,
  ): Promise<{ readonly storageKey: string | null } | undefined>;
  /** The transactions that paid for these expenses. */
  ofExpenses(orgId: string, expenseIds: readonly string[]): Promise<CardTransactionRecord[]>;
}

/** The store on Postgres, as expensewise_app and as the caller (ADR-0035). */
export function dbCardStore(db: Database): CardStore {
  const inOrg = asCaller(db);
  const user = (id: string) => ({ type: 'user', id }) as const;
  return {
    file: (orgId, statement, actor) =>
      inOrg(orgId, (tx) => fileCardStatement(tx, orgId, statement, user(actor))),
    recordList: (orgId, list, actor) =>
      inOrg(orgId, (tx) => recordCardList(tx, orgId, list, actor)),
    list: (orgId, memberId) =>
      inOrg(orgId, async (tx) => {
        const kept = await listCardStatements(tx, memberId);
        const ids = kept.transactions.flatMap((t) => (t.expenseId ? [t.expenseId] : []));
        return { ...kept, expenses: await expensesByIds(tx, ids) };
      }),
    matchable: (orgId, memberId, around) =>
      inOrg(orgId, (tx) => matchableExpenses(tx, memberId, around)),
    setAside: (orgId, id, input, actor) =>
      inOrg(orgId, (tx) => setAsideCardTransaction(tx, orgId, id, input, actor)),
    bringBack: (orgId, id, actor) =>
      inOrg(orgId, (tx) => bringBackCardTransaction(tx, orgId, id, actor)),
    matchTo: (orgId, id, expenseId, actor) =>
      inOrg(orgId, (tx) => matchCardTransactionTo(tx, orgId, id, expenseId, actor)),
    unmatch: (orgId, id, actor) =>
      inOrg(orgId, (tx) => unmatchCardTransaction(tx, orgId, id, actor)),
    matchAgain: (orgId, memberId, actor) =>
      inOrg(orgId, (tx) => matchCardTransactions(tx, orgId, memberId, user(actor))),
    confirm: (orgId, id, actor) => inOrg(orgId, (tx) => confirmCardStatement(tx, orgId, id, actor)),
    remove: (orgId, id, actor) => inOrg(orgId, (tx) => deleteCardStatement(tx, orgId, id, actor)),
    ofExpenses: (orgId, expenseIds) =>
      inOrg(orgId, (tx) => cardTransactionsOfExpenses(tx, expenseIds)),
  };
}

/**
 * Whether Needs you lists the person's missing receipts: where card statements can be on, and
 * are on for the organization. Off, Needs you reads nothing more (US-CAP-07 AC9).
 */
export async function cardChargesAsked(
  options: { readonly cards?: CardStore },
  features: FeatureGate,
  orgId: string,
): Promise<boolean> {
  return options.cards !== undefined && (await features.isOn(orgId, CARD_STATEMENTS_FLAG));
}
