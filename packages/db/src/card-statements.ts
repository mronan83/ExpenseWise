import {
  checkSetAside,
  daysBetween,
  matchTransactions,
  money,
  transactionKeys,
  type CardTransaction,
  type Money,
  type SetAsideProblem,
  type SetAsideReason,
} from '@expensewise/domain';
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lte, ne, sql } from 'drizzle-orm';
import { appendAuditEvent, type AuditEntry } from './audit.ts';
import type { Transaction } from './client.ts';
import { followCardCharges } from './company-paid.ts';
import { enqueueOutbox } from './outbox.ts';
import type { CommittedEvent } from './receipts.ts';
import { cardStatements, cardTransactions, expenses, receipts } from './schema.ts';

/*
 * A member's card statements and the transactions they bring in, matched to the expenses they
 * paid for (FR-CAP-10, FR-INT-24, ADR-0046, #97). The rules are the domain's; this keeps them,
 * each change audited in the same transaction.
 */

/** Asks for a statement PDF to be read. */
export const CARD_STATEMENT_FILED = 'card_statement.filed';

export type StatementSource = 'upload' | 'email' | 'list';
export type StatementStatus = 'reading' | 'read' | 'needs_look' | 'failed';

export interface CardStatementRecord {
  readonly id: string;
  readonly memberId: string;
  readonly source: StatementSource;
  readonly storageKey: string | null;
  readonly contentType: string;
  readonly byteSize: number;
  readonly sha256: string;
  readonly status: StatementStatus;
  readonly problem: string | null;
  readonly cardLastFour: string | null;
  readonly periodStart: string | null;
  readonly periodEnd: string | null;
  readonly currency: string | null;
  readonly chargesMinor: number | null;
  readonly creditsMinor: number | null;
  readonly added: number;
  readonly readAt: Date | null;
  readonly createdAt: Date;
}

export interface CardTransactionRecord {
  readonly id: string;
  readonly memberId: string;
  readonly statementId: string;
  readonly transactionDate: string;
  readonly postedOn: string | null;
  readonly merchant: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly cardLastFour: string | null;
  readonly reference: string | null;
  readonly expenseId: string | null;
  readonly matchedBy: 'auto' | 'person' | null;
  readonly setAside: {
    readonly reason: SetAsideReason;
    readonly note: string | null;
    readonly at: Date;
  } | null;
}

const statementColumns = {
  id: cardStatements.id,
  memberId: cardStatements.memberId,
  source: cardStatements.source,
  storageKey: cardStatements.storageKey,
  contentType: cardStatements.contentType,
  byteSize: cardStatements.byteSize,
  sha256: cardStatements.sha256,
  status: cardStatements.status,
  problem: cardStatements.problem,
  cardLastFour: cardStatements.cardLastFour,
  periodStart: cardStatements.periodStart,
  periodEnd: cardStatements.periodEnd,
  currency: cardStatements.currency,
  chargesMinor: cardStatements.chargesMinor,
  creditsMinor: cardStatements.creditsMinor,
  added: cardStatements.added,
  readAt: cardStatements.readAt,
  createdAt: cardStatements.createdAt,
};

type TransactionRow = typeof cardTransactions.$inferSelect;
const transactionOf = (r: TransactionRow): CardTransactionRecord => ({
  id: r.id,
  memberId: r.memberId,
  statementId: r.statementId,
  transactionDate: r.transactionDate,
  postedOn: r.postedOn,
  merchant: r.merchant,
  amountMinor: r.amountMinor,
  currency: r.currency,
  cardLastFour: r.cardLastFour,
  reference: r.reference,
  expenseId: r.expenseId,
  matchedBy: r.matchedBy,
  setAside:
    r.setAsideReason && r.setAsideAt
      ? { reason: r.setAsideReason, note: r.setAsideNote, at: r.setAsideAt }
      : null,
});

export interface NewCardStatement {
  readonly id: string;
  readonly memberId: string;
  readonly source: 'upload' | 'email';
  readonly storageKey: string;
  readonly contentType: string;
  readonly byteSize: number;
  readonly sha256: string;
}

export type FileStatementResult =
  | { readonly status: 'filed'; readonly statementId: string; readonly event: CommittedEvent }
  /** The member brought the same file in before; nothing changes. */
  | { readonly status: 'exists'; readonly statementId: string };

const lockFile = (tx: Transaction, orgId: string, memberId: string, sha256: string) =>
  tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`statement:${orgId}:${memberId}:${sha256}`}, 0))`,
  );

async function sameFile(tx: Transaction, memberId: string, sha256: string, id: string) {
  const [same] = await tx
    .select({ id: cardStatements.id })
    .from(cardStatements)
    .where(
      and(
        eq(cardStatements.memberId, memberId),
        sql`(${cardStatements.sha256} = ${sha256} OR ${cardStatements.id} = ${id})`,
      ),
    )
    .limit(1);
  return same?.id;
}

/**
 * Files a statement PDF a member uploaded or emailed: the row, the event that has it read, and
 * the audit event, in the caller's transaction. The same file again is the one filed before.
 * Call inside withOrg().
 */
export async function fileCardStatement(
  tx: Transaction,
  orgId: string,
  input: NewCardStatement,
  actor: AuditEntry['actor'],
): Promise<FileStatementResult> {
  await lockFile(tx, orgId, input.memberId, input.sha256);
  const same = await sameFile(tx, input.memberId, input.sha256, input.id);
  if (same) return { status: 'exists', statementId: same };
  await tx.insert(cardStatements).values({ ...input, orgId, status: 'reading' });
  const payload = { statementId: input.id };
  const outboxId = await enqueueOutbox(tx, orgId, CARD_STATEMENT_FILED, payload);
  await appendAuditEvent(tx, orgId, {
    actor,
    entityType: 'card_statement',
    entityId: input.id,
    action: 'card_statement.filed',
    payload: { source: input.source, byteSize: input.byteSize, sha256: input.sha256 },
  });
  return {
    status: 'filed',
    statementId: input.id,
    event: { outboxId, topic: CARD_STATEMENT_FILED, orgId, payload },
  };
}

/** What a statement's reading found, to keep. */
export interface StatementReading {
  readonly status: Exclude<StatementStatus, 'reading'>;
  readonly problem: string | null;
  readonly cardLastFour: string | null;
  readonly periodStart: string | null;
  readonly periodEnd: string | null;
  readonly currency: string | null;
  readonly charges: Money | null;
  readonly credits: Money | null;
  readonly transactions: readonly CardTransaction[];
  /** The model and instructions that read it, and the cost; null for a list. */
  readonly model: string | null;
  readonly version: string | null;
  readonly costNanoUsd: number | null;
}

/**
 * Keeps what a statement's reading found: its transactions, each once by its key, so one already
 * brought in by another statement isn't added again (US-CAP-07 AC4), and the statement's own
 * totals. A statement read in full is matched at once; one that needs a look waits for the person
 * (AC5). Settling a statement already settled changes nothing. Returns how many transactions were
 * new. Call inside withOrg().
 */
export async function settleCardStatement(
  tx: Transaction,
  orgId: string,
  statementId: string,
  reading: StatementReading,
): Promise<{ readonly added: number; readonly matched: number } | undefined> {
  const [statement] = await tx
    .select({ memberId: cardStatements.memberId, status: cardStatements.status })
    .from(cardStatements)
    .where(eq(cardStatements.id, statementId))
    .for('update');
  if (!statement || statement.status !== 'reading') return undefined;
  const keys = transactionKeys(reading.transactions);
  const added =
    reading.transactions.length === 0
      ? []
      : await tx
          .insert(cardTransactions)
          .values(
            reading.transactions.map((t, i) => ({
              orgId,
              memberId: statement.memberId,
              statementId,
              key: keys[i]!,
              transactionDate: t.transactionDate,
              postedOn: t.postedOn,
              merchant: t.merchant,
              amountMinor: t.amount.amountMinor,
              currency: t.amount.currency,
              cardLastFour: t.cardLastFour,
              reference: t.reference,
            })),
          )
          .onConflictDoNothing()
          .returning({ id: cardTransactions.id });
  await tx
    .update(cardStatements)
    .set({
      status: reading.status,
      problem: reading.problem,
      cardLastFour: reading.cardLastFour,
      periodStart: reading.periodStart,
      periodEnd: reading.periodEnd,
      currency: reading.currency,
      chargesMinor: reading.charges?.amountMinor ?? null,
      creditsMinor: reading.credits?.amountMinor ?? null,
      model: reading.model,
      version: reading.version,
      costNanoUsd: reading.costNanoUsd,
      added: added.length,
      readAt: new Date(),
    })
    .where(eq(cardStatements.id, statementId));
  const system = { type: 'system', id: 'card-statement-workflow' } as const;
  await appendAuditEvent(tx, orgId, {
    actor: system,
    entityType: 'card_statement',
    entityId: statementId,
    action: 'card_statement.read',
    payload: {
      status: reading.status,
      listed: reading.transactions.length,
      added: added.length,
      problem: reading.problem,
      model: reading.model,
      version: reading.version,
    },
  });
  const matched =
    reading.status === 'read'
      ? await matchCardTransactions(tx, orgId, statement.memberId, system)
      : 0;
  return { added: added.length, matched };
}

/**
 * Brings in a transaction list a member downloaded, read in the request with no model
 * (US-CAP-07 AC6): a statement already read, its transactions kept and matched at once. The
 * same file again is the one brought in before. Call inside withOrg(), as the caller.
 */
export async function recordCardList(
  tx: Transaction,
  orgId: string,
  input: {
    readonly id: string;
    readonly memberId: string;
    readonly byteSize: number;
    readonly sha256: string;
    readonly currency: string;
    readonly transactions: readonly CardTransaction[];
  },
  actorUserId: string,
): Promise<
  | {
      readonly status: 'filed';
      readonly statementId: string;
      readonly added: number;
      readonly matched: number;
    }
  | { readonly status: 'exists'; readonly statementId: string }
> {
  await lockFile(tx, orgId, input.memberId, input.sha256);
  const same = await sameFile(tx, input.memberId, input.sha256, input.id);
  if (same) return { status: 'exists', statementId: same };
  await tx.insert(cardStatements).values({
    id: input.id,
    orgId,
    memberId: input.memberId,
    source: 'list',
    storageKey: null,
    contentType: 'text/csv',
    byteSize: input.byteSize,
    sha256: input.sha256,
    status: 'reading',
  });
  await appendAuditEvent(tx, orgId, {
    actor: { type: 'user', id: actorUserId },
    entityType: 'card_statement',
    entityId: input.id,
    action: 'card_statement.filed',
    payload: { source: 'list', byteSize: input.byteSize, sha256: input.sha256 },
  });
  const settled = await settleCardStatement(tx, orgId, input.id, {
    status: 'read',
    problem: null,
    cardLastFour: null,
    periodStart: null,
    periodEnd: null,
    currency: input.currency,
    charges: null,
    credits: null,
    transactions: input.transactions,
    model: null,
    version: null,
    costNanoUsd: null,
  });
  return { status: 'filed', statementId: input.id, ...(settled ?? { added: 0, matched: 0 }) };
}

/**
 * Matches a member's open transactions to their expenses (FR-INT-24, US-CAP-07 AC2): those of a
 * statement read in full, not yet matched or set aside, to expenses not yet matched, by the
 * domain's rule. Returns how many were matched, each audited. Call inside withOrg().
 */
export async function matchCardTransactions(
  tx: Transaction,
  orgId: string,
  memberId: string,
  actor: AuditEntry['actor'],
): Promise<number> {
  const open = await tx
    .select({
      id: cardTransactions.id,
      transactionDate: cardTransactions.transactionDate,
      merchant: cardTransactions.merchant,
      amountMinor: cardTransactions.amountMinor,
      currency: cardTransactions.currency,
    })
    .from(cardTransactions)
    .innerJoin(
      cardStatements,
      and(
        eq(cardStatements.orgId, cardTransactions.orgId),
        eq(cardStatements.id, cardTransactions.statementId),
      ),
    )
    .where(
      and(
        eq(cardTransactions.memberId, memberId),
        isNull(cardTransactions.expenseId),
        isNull(cardTransactions.setAsideReason),
        eq(cardStatements.status, 'read'),
      ),
    );
  if (open.length === 0) return 0;
  const dates = open.map((t) => t.transactionDate).sort();
  const shift = (day: string, by: number) =>
    new Date(Date.parse(`${day}T00:00:00Z`) + by * 86_400_000).toISOString().slice(0, 10);
  const candidates = await tx
    .select({
      id: expenses.id,
      transactionDate: expenses.transactionDate,
      merchant: expenses.merchant,
      amountMinor: expenses.amountMinor,
      currency: expenses.currency,
    })
    .from(expenses)
    .where(
      and(
        eq(expenses.memberId, memberId),
        // Only an expense with its receipt documents a charge (FR-INT-26); a drive has none.
        sql`EXISTS (SELECT 1 FROM receipts r WHERE r.org_id = ${expenses.orgId} AND r.expense_id = ${expenses.id})`,
        isNotNull(expenses.amountMinor),
        isNotNull(expenses.currency),
        gte(expenses.transactionDate, shift(dates[0]!, -7)),
        lte(expenses.transactionDate, shift(dates.at(-1)!, 7)),
        sql`NOT EXISTS (SELECT 1 FROM card_transactions m WHERE m.org_id = ${expenses.orgId} AND m.expense_id = ${expenses.id})`,
      ),
    );
  const matches = matchTransactions(
    open.map((t) => ({
      id: t.id,
      transactionDate: t.transactionDate,
      merchant: t.merchant,
      amount: money(t.amountMinor, t.currency),
    })),
    candidates.map((e) => ({
      id: e.id,
      transactionDate: e.transactionDate,
      merchant: e.merchant,
      amount: e.amountMinor !== null && e.currency ? money(e.amountMinor, e.currency) : null,
    })),
  );
  const now = new Date();
  for (const m of matches) {
    await tx
      .update(cardTransactions)
      .set({ expenseId: m.expenseId, matchedBy: 'auto', matchedAt: now })
      .where(eq(cardTransactions.id, m.transactionId));
    await appendAuditEvent(tx, orgId, {
      actor,
      entityType: 'card_transaction',
      entityId: m.transactionId,
      action: 'card_transaction.matched',
      payload: { expenseId: m.expenseId, by: 'auto' },
    });
  }
  // The company's card paid for each, so none is claimed (FR-INT-25, Q52).
  await followCardCharges(
    tx,
    orgId,
    matches.map((m) => m.expenseId),
    actor,
  );
  return matches.length;
}

/** How a person's change to a transaction or statement ended. */
export type CardChangeResult =
  | { readonly status: 'changed' }
  | { readonly status: 'unchanged' }
  | { readonly status: 'missing' }
  /** Matched to an expense: let it go first. */
  | { readonly status: 'matched' }
  /** Set aside: bring it back first. */
  | { readonly status: 'set_aside' }
  /** The expense isn't one of the transaction's member's, or is paid by another transaction. */
  | { readonly status: 'not_matchable' }
  /** Only a statement that needs a look is confirmed. */
  | { readonly status: 'not_waiting' }
  | { readonly status: 'invalid'; readonly problem: SetAsideProblem };

async function transactionFor(tx: Transaction, id: string) {
  const [row] = await tx
    .select()
    .from(cardTransactions)
    .where(eq(cardTransactions.id, id))
    .for('update');
  return row;
}

/**
 * Sets a transaction aside with a reason, such as a personal charge, so it is no longer a
 * missing receipt (US-CAP-07 AC3); a transaction set aside takes the new reason. Call inside
 * withOrg(), as the caller.
 */
export async function setAsideCardTransaction(
  tx: Transaction,
  orgId: string,
  id: string,
  input: { readonly reason: string; readonly note?: string | null },
  actorUserId: string,
): Promise<CardChangeResult> {
  const checked = checkSetAside(input.reason, input.note);
  if (!checked.ok) return { status: 'invalid', problem: checked.error };
  const row = await transactionFor(tx, id);
  if (!row) return { status: 'missing' };
  if (row.expenseId) return { status: 'matched' };
  const { reason, note } = checked.value;
  if (row.setAsideReason === reason && row.setAsideNote === note) return { status: 'unchanged' };
  await tx
    .update(cardTransactions)
    .set({ setAsideReason: reason, setAsideNote: note, setAsideAt: new Date() })
    .where(eq(cardTransactions.id, id));
  await appendAuditEvent(tx, orgId, {
    actor: { type: 'user', id: actorUserId },
    entityType: 'card_transaction',
    entityId: id,
    action: 'card_transaction.set_aside',
    payload: {
      reason,
      note,
      ...(row.setAsideReason
        ? { previous: { reason: row.setAsideReason, note: row.setAsideNote } }
        : {}),
    },
  });
  return { status: 'changed' };
}

/** Brings a transaction set aside back: a missing receipt again. Call inside withOrg(). */
export async function bringBackCardTransaction(
  tx: Transaction,
  orgId: string,
  id: string,
  actorUserId: string,
): Promise<CardChangeResult> {
  const row = await transactionFor(tx, id);
  if (!row) return { status: 'missing' };
  if (!row.setAsideReason) return { status: 'unchanged' };
  await tx
    .update(cardTransactions)
    .set({ setAsideReason: null, setAsideNote: null, setAsideAt: null })
    .where(eq(cardTransactions.id, id));
  await appendAuditEvent(tx, orgId, {
    actor: { type: 'user', id: actorUserId },
    entityType: 'card_transaction',
    entityId: id,
    action: 'card_transaction.brought_back',
    payload: { reason: row.setAsideReason },
  });
  return { status: 'changed' };
}

/**
 * Matches a transaction to an expense a person chose (US-CAP-07 AC7), whatever its amount or
 * currency: a tip added after the receipt, or a charge abroad. The expense must be the same
 * member's, have its receipt (FR-INT-26) and not be paid by another transaction. Call inside
 * withOrg(), as the caller.
 */
export async function matchCardTransactionTo(
  tx: Transaction,
  orgId: string,
  id: string,
  expenseId: string,
  actorUserId: string,
): Promise<CardChangeResult> {
  const row = await transactionFor(tx, id);
  if (!row) return { status: 'missing' };
  if (row.setAsideReason) return { status: 'set_aside' };
  if (row.expenseId === expenseId) return { status: 'unchanged' };
  const [expense] = await tx
    .select({ memberId: expenses.memberId })
    .from(expenses)
    .where(eq(expenses.id, expenseId));
  const [receipt] = await tx
    .select({ id: receipts.id })
    .from(receipts)
    .where(eq(receipts.expenseId, expenseId))
    .limit(1);
  const [taken] = await tx
    .select({ id: cardTransactions.id })
    .from(cardTransactions)
    .where(and(eq(cardTransactions.expenseId, expenseId), ne(cardTransactions.id, id)));
  // Only an expense with its receipt documents a charge (FR-INT-26): never a drive, nor one
  // typed in with no receipt, which leaves the charge a missing receipt.
  if (!expense || expense.memberId !== row.memberId || !receipt || taken) {
    return { status: 'not_matchable' };
  }
  await tx
    .update(cardTransactions)
    .set({ expenseId, matchedBy: 'person', matchedAt: new Date() })
    .where(eq(cardTransactions.id, id));
  await appendAuditEvent(tx, orgId, {
    actor: { type: 'user', id: actorUserId },
    entityType: 'card_transaction',
    entityId: id,
    action: 'card_transaction.matched',
    payload: { expenseId, by: 'person', ...(row.expenseId ? { previous: row.expenseId } : {}) },
  });
  await followCardCharges(tx, orgId, [expenseId, row.expenseId], {
    type: 'user',
    id: actorUserId,
  });
  return { status: 'changed' };
}

/** Lets a transaction go of its expense: a missing receipt again. Call inside withOrg(). */
export async function unmatchCardTransaction(
  tx: Transaction,
  orgId: string,
  id: string,
  actorUserId: string,
): Promise<CardChangeResult> {
  const row = await transactionFor(tx, id);
  if (!row) return { status: 'missing' };
  if (!row.expenseId) return { status: 'unchanged' };
  await tx
    .update(cardTransactions)
    .set({ expenseId: null, matchedBy: null, matchedAt: null })
    .where(eq(cardTransactions.id, id));
  await appendAuditEvent(tx, orgId, {
    actor: { type: 'user', id: actorUserId },
    entityType: 'card_transaction',
    entityId: id,
    action: 'card_transaction.unmatched',
    payload: { expenseId: row.expenseId, by: row.matchedBy },
  });
  // Let go, the expense goes back to its type's policy (US-CAP-08 AC4).
  await followCardCharges(tx, orgId, [row.expenseId], { type: 'user', id: actorUserId });
  return { status: 'changed' };
}

/**
 * Takes a statement that needed a look as read, once the person has looked (US-CAP-07 AC5), and
 * matches its transactions. Call inside withOrg(), as the caller.
 */
export async function confirmCardStatement(
  tx: Transaction,
  orgId: string,
  statementId: string,
  actorUserId: string,
): Promise<CardChangeResult> {
  const [statement] = await tx
    .select({ memberId: cardStatements.memberId, status: cardStatements.status })
    .from(cardStatements)
    .where(eq(cardStatements.id, statementId))
    .for('update');
  if (!statement) return { status: 'missing' };
  if (statement.status !== 'needs_look') return { status: 'not_waiting' };
  await tx.update(cardStatements).set({ status: 'read' }).where(eq(cardStatements.id, statementId));
  const actor = { type: 'user', id: actorUserId } as const;
  await appendAuditEvent(tx, orgId, {
    actor,
    entityType: 'card_statement',
    entityId: statementId,
    action: 'card_statement.confirmed',
  });
  await matchCardTransactions(tx, orgId, statement.memberId, actor);
  return { status: 'changed' };
}

/**
 * Deletes a statement brought in by mistake, with the transactions it brought in. Returns where
 * its file is kept, for the caller to remove once this commits, or undefined when there is no such
 * statement. Call inside withOrg(), as the caller.
 */
export async function deleteCardStatement(
  tx: Transaction,
  orgId: string,
  statementId: string,
  actorUserId: string,
): Promise<{ readonly storageKey: string | null } | undefined> {
  const [statement] = await tx
    .select({ storageKey: cardStatements.storageKey, added: cardStatements.added })
    .from(cardStatements)
    .where(eq(cardStatements.id, statementId))
    .for('update');
  if (!statement) return undefined;
  const paid = await tx
    .select({ expenseId: cardTransactions.expenseId })
    .from(cardTransactions)
    .where(
      and(eq(cardTransactions.statementId, statementId), isNotNull(cardTransactions.expenseId)),
    );
  await tx.delete(cardStatements).where(eq(cardStatements.id, statementId));
  await appendAuditEvent(tx, orgId, {
    actor: { type: 'user', id: actorUserId },
    entityType: 'card_statement',
    entityId: statementId,
    action: 'card_statement.deleted',
    payload: { transactions: statement.added },
  });
  // The expenses its charges paid for go back to their types' policy.
  await followCardCharges(
    tx,
    orgId,
    paid.map((p) => p.expenseId),
    { type: 'user', id: actorUserId },
  );
  return { storageKey: statement.storageKey };
}

/** A statement's status, for the workflow that reads it, or undefined. Call inside withOrg(). */
export async function getCardStatement(
  tx: Transaction,
  statementId: string,
): Promise<CardStatementRecord | undefined> {
  const [row] = await tx
    .select(statementColumns)
    .from(cardStatements)
    .where(eq(cardStatements.id, statementId));
  return row;
}

/** The member's statements, newest first, and every transaction they brought in. */
export async function listCardStatements(
  tx: Transaction,
  memberId: string,
): Promise<{
  readonly statements: CardStatementRecord[];
  readonly transactions: CardTransactionRecord[];
}> {
  const statements = await tx
    .select(statementColumns)
    .from(cardStatements)
    .where(eq(cardStatements.memberId, memberId))
    .orderBy(desc(cardStatements.createdAt));
  const rows = await tx
    .select()
    .from(cardTransactions)
    .where(eq(cardTransactions.memberId, memberId))
    .orderBy(desc(cardTransactions.transactionDate), asc(cardTransactions.createdAt));
  return { statements, transactions: rows.map(transactionOf) };
}

/** The transactions that paid for these expenses. Call inside withOrg(). */
export async function cardTransactionsOfExpenses(
  tx: Transaction,
  expenseIds: readonly string[],
): Promise<CardTransactionRecord[]> {
  if (expenseIds.length === 0) return [];
  const rows = await tx
    .select()
    .from(cardTransactions)
    .where(inArray(cardTransactions.expenseId, [...expenseIds]));
  return rows.map(transactionOf);
}

/**
 * A member's missing receipts (US-CAP-07 AC3): transactions of statements read in full, charges
 * not matched or set aside, oldest first. Call inside withOrg().
 */
export async function missingReceipts(
  tx: Transaction,
  memberId: string,
): Promise<CardTransactionRecord[]> {
  const rows = await tx
    .select({ t: cardTransactions })
    .from(cardTransactions)
    .innerJoin(
      cardStatements,
      and(
        eq(cardStatements.orgId, cardTransactions.orgId),
        eq(cardStatements.id, cardTransactions.statementId),
      ),
    )
    .where(
      and(
        eq(cardTransactions.memberId, memberId),
        isNull(cardTransactions.expenseId),
        isNull(cardTransactions.setAsideReason),
        sql`${cardTransactions.amountMinor} > 0`,
        eq(cardStatements.status, 'read'),
      ),
    )
    .orderBy(asc(cardTransactions.transactionDate), asc(cardTransactions.createdAt));
  return rows.map((r) => transactionOf(r.t));
}

/**
 * Expenses a person might match a transaction to by hand: the member's own, not paid by another
 * transaction, dated within a week of it, nearest first. Call inside withOrg().
 */
export async function matchableExpenses(
  tx: Transaction,
  memberId: string,
  around: string,
): Promise<
  {
    readonly id: string;
    readonly merchant: string | null;
    readonly transactionDate: string | null;
    readonly amountMinor: number | null;
    readonly currency: string | null;
  }[]
> {
  const shift = (by: number) =>
    new Date(Date.parse(`${around}T00:00:00Z`) + by * 86_400_000).toISOString().slice(0, 10);
  const rows = await tx
    .select({
      id: expenses.id,
      merchant: expenses.merchant,
      transactionDate: expenses.transactionDate,
      amountMinor: expenses.amountMinor,
      currency: expenses.currency,
    })
    .from(expenses)
    .where(
      and(
        eq(expenses.memberId, memberId),
        sql`EXISTS (SELECT 1 FROM receipts r WHERE r.org_id = ${expenses.orgId} AND r.expense_id = ${expenses.id})`,
        gte(expenses.transactionDate, shift(-7)),
        lte(expenses.transactionDate, shift(7)),
        sql`NOT EXISTS (SELECT 1 FROM card_transactions m WHERE m.org_id = ${expenses.orgId} AND m.expense_id = ${expenses.id})`,
      ),
    );
  return rows.sort(
    (a, b) =>
      Math.abs(daysBetween(around, a.transactionDate ?? around)) -
      Math.abs(daysBetween(around, b.transactionDate ?? around)),
  );
}
