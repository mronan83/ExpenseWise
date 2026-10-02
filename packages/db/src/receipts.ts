import type { ExpenseSource } from '@expensewise/domain';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { appendAuditEvent } from './audit.ts';
import type { Transaction } from './client.ts';
import { enqueueOutbox } from './outbox.ts';
import type { receiptStatus } from './schema.ts';
import { auditEvents, extractionRuns, members, receipts } from './schema.ts';

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
  readonly createdAt: Date;
}

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

/** The newest receipts first. Call inside withOrg(). */
export function listReceipts(tx: Transaction, limit: number): Promise<ReceiptRecord[]> {
  return withUploader(tx).orderBy(desc(receipts.createdAt), desc(receipts.id)).limit(limit);
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
  outcome: { status: ReceiptStatus; requestId: string; detail: Record<string, unknown> },
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
}
