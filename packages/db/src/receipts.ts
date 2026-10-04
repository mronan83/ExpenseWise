import type { ExpenseDetails, ExpenseSource } from '@expensewise/domain';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { appendAuditEvent } from './audit.ts';
import type { Transaction } from './client.ts';
import { fileReceiptExpense, type ReceiptOffer } from './expenses.ts';
import { checkForDuplicate } from './duplicates.ts';
import { enqueueOutbox } from './outbox.ts';
import type { receiptStatus } from './schema.ts';
import {
  auditEvents,
  extractionRuns,
  members,
  receiptDuplicates,
  receiptReviews,
  receipts,
} from './schema.ts';

export type ReceiptStatus = (typeof receiptStatus.enumValues)[number];

/** Asks the receipt workflow to read a receipt. A new event for each request. */
export const RECEIPT_UPLOADED = 'receipt.uploaded';
export const RECEIPT_READ_REQUESTED = 'receipt.read_requested';

export interface ReceiptRecord {
  readonly id: string;
  readonly memberId: string;
  readonly uploadedBy: string;
  readonly source: ExpenseSource;
  readonly storageKey: string;
  readonly contentType: string;
  readonly byteSize: number;
  readonly sha256: string;
  readonly status: ReceiptStatus;
  /** The expense this receipt proves (FR-EXP-08); null only before it is filed. */
  readonly expenseId: string | null;
  readonly createdAt: Date;
}

export interface ExtractionRunRecord {
  readonly id: string;
  readonly receiptId: string;
  readonly requestId: string | null;
  readonly model: string;
  readonly promptVersion: string;
  readonly outcome: 'confident' | 'unsure' | 'failed';
  /** The model's raw structured output; normalized when read. */
  readonly output: unknown;
  readonly error: string | null;
  readonly latencyMs: number | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly costMicroUsd: number | null;
  /**
   * primary or backup when read under the organization's AI model settings (FR-INT-16);
   * null or absent for readings made side by side (ADR-0017).
   */
  readonly role?: string | null;
  readonly createdAt: Date;
}

/** Why a model read a receipt under the organization's AI model settings (FR-INT-16). */
export type ModelRole = 'primary' | 'backup';

const receiptColumns = {
  id: receipts.id,
  memberId: receipts.memberId,
  uploadedBy: members.displayName,
  source: receipts.source,
  storageKey: receipts.storageKey,
  contentType: receipts.contentType,
  byteSize: receipts.byteSize,
  sha256: receipts.sha256,
  status: receipts.status,
  expenseId: receipts.expenseId,
  createdAt: receipts.createdAt,
};

const runColumns = {
  id: extractionRuns.id,
  receiptId: extractionRuns.receiptId,
  requestId: extractionRuns.requestId,
  model: extractionRuns.model,
  promptVersion: extractionRuns.promptVersion,
  outcome: extractionRuns.outcome,
  output: extractionRuns.output,
  error: extractionRuns.error,
  latencyMs: extractionRuns.latencyMs,
  inputTokens: extractionRuns.inputTokens,
  outputTokens: extractionRuns.outputTokens,
  costMicroUsd: extractionRuns.costMicroUsd,
  role: extractionRuns.role,
  createdAt: extractionRuns.createdAt,
};

const withUploader = (tx: Transaction) =>
  tx
    .select(receiptColumns)
    .from(receipts)
    .innerJoin(members, and(eq(members.orgId, receipts.orgId), eq(members.id, receipts.memberId)));

/** One receipt, or undefined. Call inside withOrg(). */
export async function getReceipt(
  tx: Transaction,
  receiptId: string,
): Promise<ReceiptRecord | undefined> {
  const [row] = await withUploader(tx).where(eq(receipts.id, receiptId));
  return row;
}

/** The receipt already filed with this exact file, if any. Call inside withOrg(). */
export async function findReceiptBySha256(
  tx: Transaction,
  sha256: string,
): Promise<{ id: string } | undefined> {
  const [row] = await tx
    .select({ id: receipts.id })
    .from(receipts)
    .where(eq(receipts.sha256, sha256));
  return row;
}

/** Which receipts to list: only those in `statuses`, only `memberId`'s, when given. */
export interface ReceiptFilter {
  readonly statuses?: readonly ReceiptStatus[];
  readonly memberId?: string;
}

/** The newest receipts first. Call inside withOrg(). */
export function listReceipts(
  tx: Transaction,
  limit: number,
  filter: ReceiptFilter = {},
): Promise<ReceiptRecord[]> {
  return withUploader(tx)
    .where(
      and(
        filter.statuses ? inArray(receipts.status, [...filter.statuses]) : undefined,
        filter.memberId ? eq(receipts.memberId, filter.memberId) : undefined,
      ),
    )
    .orderBy(desc(receipts.createdAt), desc(receipts.id))
    .limit(limit);
}

/** These receipts, in no particular order. Call inside withOrg(). */
export function receiptsById(
  tx: Transaction,
  receiptIds: readonly string[],
): Promise<ReceiptRecord[]> {
  if (receiptIds.length === 0) return Promise.resolve([]);
  return withUploader(tx).where(inArray(receipts.id, [...receiptIds]));
}

/** Every reading of these receipts, newest first. Call inside withOrg(). */
export function listExtractionRuns(
  tx: Transaction,
  receiptIds: readonly string[],
): Promise<ExtractionRunRecord[]> {
  if (receiptIds.length === 0) return Promise.resolve([]);
  return tx
    .select(runColumns)
    .from(extractionRuns)
    .where(inArray(extractionRuns.receiptId, [...receiptIds]))
    .orderBy(desc(extractionRuns.createdAt), desc(extractionRuns.id));
}

export interface NewReceipt {
  readonly id: string;
  readonly memberId: string;
  readonly source: ExpenseSource;
  readonly storageKey: string;
  readonly contentType: string;
  readonly byteSize: number;
  readonly sha256: string;
}

/** An event the caller should hand to the workflow runner once the transaction commits. */
export interface CommittedEvent {
  readonly outboxId: string;
  readonly topic: string;
  readonly orgId: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export type FileReceiptResult =
  | { readonly status: 'filed'; readonly receipt: ReceiptRecord; readonly event: CommittedEvent }
  /** The same id was filed before: a retried request. Nothing changes. */
  | { readonly status: 'exists'; readonly receipt: ReceiptRecord }
  /** Another receipt holds the same file. */
  | { readonly status: 'duplicate'; readonly receiptId: string };

/**
 * Files an uploaded receipt: the row, the event that has it read, and the audit event, in the
 * caller's transaction (the outbox pattern). Safe to retry with the same id. Call inside
 * withOrg().
 */
export async function fileReceipt(
  tx: Transaction,
  orgId: string,
  input: NewReceipt,
  actorUserId: string,
): Promise<FileReceiptResult> {
  // Two uploads of one file can race; the lock makes the duplicate check reliable.
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`receipt:${orgId}:${input.sha256}`}, 0))`,
  );
  const existing = await getReceipt(tx, input.id);
  if (existing) return { status: 'exists', receipt: existing };
  const same = await findReceiptBySha256(tx, input.sha256);
  if (same) return { status: 'duplicate', receiptId: same.id };

  await tx.insert(receipts).values({ ...input, orgId, status: 'processing' });
  const payload = { receiptId: input.id };
  const outboxId = await enqueueOutbox(tx, orgId, RECEIPT_UPLOADED, payload);
  await appendAuditEvent(tx, orgId, {
    actor: { type: 'user', id: actorUserId },
    entityType: 'receipt',
    entityId: input.id,
    action: 'receipt.captured',
    payload: { source: input.source, byteSize: input.byteSize, sha256: input.sha256 },
  });
  // Its expense exists from the start, processing while the receipt is read (ADR-0022).
  await fileReceiptExpense(tx, orgId, input.id, null, { type: 'user', id: actorUserId });
  const receipt = await getReceipt(tx, input.id);
  if (!receipt) throw new Error('The new receipt is not visible');
  return { status: 'filed', receipt, event: { outboxId, topic: RECEIPT_UPLOADED, orgId, payload } };
}

/**
 * Asks for the receipt to be read again, for example after a key was added. Call inside
 * withOrg(). Undefined when there is no such receipt.
 */
export async function requestReceiptReading(
  tx: Transaction,
  orgId: string,
  receiptId: string,
  actorUserId: string,
): Promise<CommittedEvent | undefined> {
  const updated = await tx
    .update(receipts)
    .set({ status: 'processing' })
    .where(eq(receipts.id, receiptId))
    .returning({ id: receipts.id });
  if (updated.length === 0) return undefined;
  const payload = { receiptId };
  const outboxId = await enqueueOutbox(tx, orgId, RECEIPT_READ_REQUESTED, payload);
  await appendAuditEvent(tx, orgId, {
    actor: { type: 'user', id: actorUserId },
    entityType: 'receipt',
    entityId: receiptId,
    action: 'receipt.read_requested',
  });
  await fileReceiptExpense(tx, orgId, receiptId, null, { type: 'user', id: actorUserId });
  return { outboxId, topic: RECEIPT_READ_REQUESTED, orgId, payload };
}

export interface NewExtractionRun {
  readonly receiptId: string;
  readonly requestId: string;
  readonly extractor: string;
  readonly model: string;
  readonly promptVersion: string;
  readonly schemaVersion: string;
  readonly outcome: 'confident' | 'unsure' | 'failed';
  readonly output: unknown;
  readonly fieldConfidence: unknown;
  readonly error: string | null;
  readonly latencyMs: number | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly costMicroUsd: number | null;
  /** Why it read, under the organization's AI model settings; absent side by side. */
  readonly role?: ModelRole;
}

/**
 * Stores one reading. A second write for the same request and model (a retried workflow
 * step) is ignored. Call inside withOrg().
 */
export async function recordExtractionRun(
  tx: Transaction,
  orgId: string,
  run: NewExtractionRun,
): Promise<void> {
  await tx
    .insert(extractionRuns)
    .values({ ...run, orgId })
    .onConflictDoNothing({
      target: [
        extractionRuns.orgId,
        extractionRuns.receiptId,
        extractionRuns.model,
        extractionRuns.requestId,
      ],
    });
}

/** The readings made for one request. Call inside withOrg(). */
export function runsForRequest(
  tx: Transaction,
  receiptId: string,
  requestId: string,
): Promise<ExtractionRunRecord[]> {
  return tx
    .select(runColumns)
    .from(extractionRuns)
    .where(and(eq(extractionRuns.receiptId, receiptId), eq(extractionRuns.requestId, requestId)));
}

/**
 * Records how a reading request ended, with its audit event. Settling the same request twice
 * (a retried step) changes nothing. Call inside withOrg().
 */
export async function settleReceipt(
  tx: Transaction,
  orgId: string,
  receiptId: string,
  outcome: {
    status: ReceiptStatus;
    requestId: string;
    detail: Record<string, unknown>;
    /** What the reading would file its expense with; null when nothing was read. */
    values?: ReceiptOffer | null;
  },
): Promise<void> {
  const [settled] = await tx
    .select({ id: auditEvents.id })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.entityType, 'receipt'),
        eq(auditEvents.entityId, receiptId),
        eq(auditEvents.action, 'receipt.read'),
        sql`${auditEvents.payload}->>'requestId' = ${outcome.requestId}`,
      ),
    )
    .limit(1);
  if (settled) return;
  await tx.update(receipts).set({ status: outcome.status }).where(eq(receipts.id, receiptId));
  await appendAuditEvent(tx, orgId, {
    actor: { type: 'system', id: 'receipt-workflow' },
    entityType: 'receipt',
    entityId: receiptId,
    action: 'receipt.read',
    payload: { status: outcome.status, requestId: outcome.requestId, ...outcome.detail },
  });
  await fileReceiptExpense(tx, orgId, receiptId, outcome.values ?? null, {
    type: 'system',
    id: 'receipt-workflow',
  });
  // A copy of a purchase already filed waits for the person (FR-INT-18).
  await checkForDuplicate(tx, orgId, receiptId, outcome.status);
}

/** A member's confirmation of a reading that needed a look (ADR-0021). */
export interface ReceiptReviewRecord {
  readonly id: string;
  readonly receiptId: string;
  readonly requestId: string | null;
  readonly model: string;
  readonly reviewedBy: string;
  readonly merchant: string;
  readonly transactionDate: string;
  readonly currency: string;
  readonly totalMinor: number;
  readonly taxMinor: number | null;
  readonly tipMinor: number | null;
  readonly corrections: unknown;
  readonly createdAt: Date;
}

/** Every review of these receipts, newest first. Call inside withOrg(). */
export function listReceiptReviews(
  tx: Transaction,
  receiptIds: readonly string[],
): Promise<ReceiptReviewRecord[]> {
  if (receiptIds.length === 0) return Promise.resolve([]);
  return tx
    .select({
      id: receiptReviews.id,
      receiptId: receiptReviews.receiptId,
      requestId: receiptReviews.requestId,
      model: receiptReviews.model,
      reviewedBy: members.displayName,
      merchant: receiptReviews.merchant,
      transactionDate: receiptReviews.transactionDate,
      currency: receiptReviews.currency,
      totalMinor: receiptReviews.totalMinor,
      taxMinor: receiptReviews.taxMinor,
      tipMinor: receiptReviews.tipMinor,
      corrections: receiptReviews.corrections,
      createdAt: receiptReviews.createdAt,
    })
    .from(receiptReviews)
    .innerJoin(
      members,
      and(eq(members.orgId, receiptReviews.orgId), eq(members.id, receiptReviews.memberId)),
    )
    .where(inArray(receiptReviews.receiptId, [...receiptIds]))
    .orderBy(desc(receiptReviews.createdAt), desc(receiptReviews.id));
}

export interface NewReceiptReview {
  readonly memberId: string;
  /** The request whose readings were shown; refused if a newer one has started since. */
  readonly requestId: string | null;
  readonly model: string;
  readonly merchant: string;
  readonly transactionDate: string;
  readonly currency: string;
  readonly totalMinor: number;
  readonly taxMinor: number | null;
  readonly tipMinor: number | null;
  readonly corrections: readonly { field: string; read: string | null; corrected: string }[];
}

export type ConfirmReceiptResult =
  | 'confirmed'
  /** No such receipt in this organization. */
  | 'missing'
  /** Held as a possible duplicate: the person decides that first (FR-INT-18). */
  | 'duplicate'
  /** It is not waiting for a look: being read, or already Ready. */
  | 'not_waiting'
  /** It was read again after the readings the person confirmed were shown. */
  | 'stale';

/**
 * Makes a receipt that needs a look Ready with the values a member confirmed: the review
 * row, the status and the audit event, in the caller's transaction. Call inside withOrg().
 */
export async function confirmReceipt(
  tx: Transaction,
  orgId: string,
  receiptId: string,
  review: NewReceiptReview,
  actorUserId: string,
  /** The time and place of the reading confirmed (FR-INT-17). */
  details?: ExpenseDetails,
): Promise<ConfirmReceiptResult> {
  // The lock orders this against a concurrent read-again or a second confirmation.
  const [current] = await tx
    .select({ status: receipts.status })
    .from(receipts)
    .where(eq(receipts.id, receiptId))
    .for('update');
  if (!current) return 'missing';
  // Not read counts too: a person enters every field, so its expense isn't a dead end.
  if (current.status !== 'needs_review' && current.status !== 'failed') return 'not_waiting';
  const [held] = await tx
    .select({ id: receiptDuplicates.id })
    .from(receiptDuplicates)
    .where(and(eq(receiptDuplicates.receiptId, receiptId), eq(receiptDuplicates.state, 'open')))
    .limit(1);
  if (held) return 'duplicate';
  const [latest] = await tx
    .select({ requestId: extractionRuns.requestId })
    .from(extractionRuns)
    .where(eq(extractionRuns.receiptId, receiptId))
    .orderBy(desc(extractionRuns.createdAt), desc(extractionRuns.id))
    .limit(1);
  if ((latest?.requestId ?? null) !== review.requestId) return 'stale';

  await tx.insert(receiptReviews).values({ ...review, orgId, receiptId });
  await tx.update(receipts).set({ status: 'extracted' }).where(eq(receipts.id, receiptId));
  await appendAuditEvent(tx, orgId, {
    actor: { type: 'user', id: actorUserId },
    entityType: 'receipt',
    entityId: receiptId,
    action: 'receipt.confirmed',
    payload: {
      requestId: review.requestId,
      model: review.model,
      corrections: review.corrections,
    },
  });
  await fileReceiptExpense(
    tx,
    orgId,
    receiptId,
    {
      merchant: review.merchant,
      transactionDate: review.transactionDate,
      currency: review.currency,
      amountMinor: review.totalMinor,
      ...(details ? { details } : {}),
    },
    { type: 'user', id: actorUserId },
  );
  return 'confirmed';
}

/**
 * Files an expense for every receipt that has none: those captured before expenses were made
 * from receipts (#6). A confirmed receipt files what was confirmed; any other receipt gets an
 * expense that needs review, filled in when it is next read or confirmed. Safe to run again.
 * Runs as the schema owner, across organizations, after migrations.
 */
export async function fileMissingReceiptExpenses(db: {
  transaction: <T>(work: (tx: Transaction) => Promise<T>) => Promise<T>;
}): Promise<number> {
  return db.transaction(async (tx) => {
    const missing = await tx
      .select({ id: receipts.id, orgId: receipts.orgId })
      .from(receipts)
      .where(sql`${receipts.expenseId} is null`)
      .orderBy(receipts.createdAt);
    for (const receipt of missing) {
      const [review] = await tx
        .select()
        .from(receiptReviews)
        .where(eq(receiptReviews.receiptId, receipt.id))
        .orderBy(desc(receiptReviews.createdAt), desc(receiptReviews.id))
        .limit(1);
      await fileReceiptExpense(
        tx,
        receipt.orgId,
        receipt.id,
        review
          ? {
              merchant: review.merchant,
              transactionDate: review.transactionDate,
              currency: review.currency,
              amountMinor: review.totalMinor,
            }
          : null,
        { type: 'system', id: 'expense-backfill' },
      );
    }
    return missing.length;
  });
}
