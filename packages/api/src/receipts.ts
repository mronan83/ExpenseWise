import {
  confirmReceipt,
  correctReceipt,
  deleteDuplicateReceipt,
  deleteReceipt,
  fileReceipt,
  findReceiptBySha256,
  getReceipt,
  keepBothReceipts,
  listExtractionRuns,
  listOpenDuplicatePairs,
  listReceiptReviews,
  listReceipts,
  mergeDuplicateReceipt,
  requestReceiptReading,
  type CommittedEvent,
  type ConfirmReceiptResult,
  type CorrectReceiptResult,
  type Database,
  type DeleteReceiptResult,
  type DuplicatePairRecord,
  type ExtractionRunRecord,
  type FileReceiptResult,
  type NewReceipt,
  type NewReceiptReview,
  type ReceiptRecord,
  type ReceiptFilter,
  type ReceiptFieldChange,
  type ReceiptReviewRecord,
  type ResolveDuplicateResult,
} from '@expensewise/db';
import type { ExpenseDetails, ExpenseEdit, ExpenseTravel, MergeField } from '@expensewise/domain';
import { asCaller } from './caller.ts';

/** A receipt with what its expense shows of it: its readings and any confirmations. */
export interface ReceiptWithReadings {
  readonly receipt: ReceiptRecord;
  readonly runs: ExtractionRunRecord[];
  readonly reviews: ReceiptReviewRecord[];
}

/** A receipt with everything its page shows, the possible duplicates too (FR-INT-18). */
export interface ReceiptInReview extends ReceiptWithReadings {
  readonly pairs: DuplicatePairRecord[];
}

/**
 * What the person decided about two receipts flagged as possible duplicates (FR-INT-18):
 * different purchases; one to delete, keeping the other; or one merged into the primary.
 */
export type DuplicateDecision =
  | { readonly action: 'keep_both' }
  | { readonly action: 'delete'; readonly keep: string }
  | { readonly action: 'merge'; readonly primary: string; readonly fields: readonly MergeField[] };

/**
 * What the API needs from the database for receipts. Filing and asking for a reading write
 * the outbox event and the audit event in the same transaction. Tests use an in-memory fake.
 */
export interface ReceiptStore {
  findBySha256(orgId: string, sha256: string): Promise<string | undefined>;
  file(orgId: string, input: NewReceipt, actorUserId: string): Promise<FileReceiptResult>;
  /** The newest receipts with their readings, filtered by status or member when asked. */
  list(
    orgId: string,
    limit: number,
    filter?: ReceiptFilter,
  ): Promise<{
    receipts: ReceiptRecord[];
    runs: ExtractionRunRecord[];
    reviews: ReceiptReviewRecord[];
    pairs: DuplicatePairRecord[];
  }>;
  get(orgId: string, receiptId: string): Promise<ReceiptInReview | undefined>;
  requestReading(
    orgId: string,
    receiptId: string,
    actorUserId: string,
  ): Promise<CommittedEvent | undefined>;
  /** Makes a receipt that needs a look Ready; the review and audit event commit together. */
  confirm(
    orgId: string,
    receiptId: string,
    review: NewReceiptReview,
    actorUserId: string,
    /** The time and place of the reading confirmed (FR-INT-17). */
    details?: ExpenseDetails,
    /** Its journey and stay, when it was asked for them (FR-INT-20, FR-INT-21). */
    travel?: ExpenseTravel,
  ): Promise<ConfirmReceiptResult>;
  /**
   * Corrects fields of a Ready receipt (GAP-14): the review, the edit of its expense and the
   * audit events commit together, or nothing does.
   */
  correct(
    orgId: string,
    receiptId: string,
    correction: {
      readonly review: NewReceiptReview;
      readonly expense: ExpenseEdit;
      readonly changes: readonly ReceiptFieldChange[];
    },
    actorUserId: string,
  ): Promise<CorrectReceiptResult>;
  /**
   * Settles an open pair as the person decided. The receipt kept is one of the two; any other
   * is deleted with its expense, and the caller removes its file once this returns.
   */
  resolveDuplicate(
    orgId: string,
    receiptId: string,
    otherReceiptId: string,
    decision: DuplicateDecision,
    actorUserId: string,
  ): Promise<ResolveDuplicateResult>;
  /**
   * Deletes a receipt of the caller's own filed by mistake, with its expense (FR-CAP-11); the
   * caller removes its file once this returns.
   */
  delete(orgId: string, receiptId: string, actorUserId: string): Promise<DeleteReceiptResult>;
}

/**
 * The receipt store on Postgres, as expensewise_app, for the request's caller: they see and
 * change only what their role allows (ADR-0035). It checks the role once.
 */
export function dbReceiptStore(db: Database): ReceiptStore {
  const inOrg = asCaller(db);

  return {
    findBySha256: (orgId, sha256) =>
      inOrg(orgId, async (tx) => (await findReceiptBySha256(tx, sha256))?.id),
    file: (orgId, input, actor) => inOrg(orgId, (tx) => fileReceipt(tx, orgId, input, actor)),
    list: (orgId, limit, filter) =>
      inOrg(orgId, async (tx) => {
        const receipts = await listReceipts(tx, limit, filter);
        const ids = receipts.map((r) => r.id);
        const runs = await listExtractionRuns(tx, ids);
        const reviews = await listReceiptReviews(tx, ids);
        const pairs = await listOpenDuplicatePairs(tx, ids);
        return { receipts, runs, reviews, pairs };
      }),
    get: (orgId, receiptId) =>
      inOrg(orgId, async (tx) => {
        const receipt = await getReceipt(tx, receiptId);
        if (!receipt) return undefined;
        return {
          receipt,
          runs: await listExtractionRuns(tx, [receiptId]),
          reviews: await listReceiptReviews(tx, [receiptId]),
          pairs: await listOpenDuplicatePairs(tx, [receiptId]),
        };
      }),
    requestReading: (orgId, receiptId, actor) =>
      inOrg(orgId, (tx) => requestReceiptReading(tx, orgId, receiptId, actor)),
    confirm: (orgId, receiptId, review, actor, details, travel) =>
      inOrg(orgId, (tx) => confirmReceipt(tx, orgId, receiptId, review, actor, details, travel)),
    correct: (orgId, receiptId, correction, actor) =>
      inOrg(orgId, (tx) => correctReceipt(tx, orgId, receiptId, correction, actor)),
    resolveDuplicate: (orgId, receiptId, otherReceiptId, decision, actor) =>
      inOrg(orgId, (tx) => {
        if (decision.action === 'keep_both') {
          return keepBothReceipts(tx, orgId, receiptId, otherReceiptId, actor);
        }
        const kept = decision.action === 'delete' ? decision.keep : decision.primary;
        const other = kept === receiptId ? otherReceiptId : receiptId;
        return decision.action === 'delete'
          ? deleteDuplicateReceipt(tx, orgId, other, kept, actor)
          : mergeDuplicateReceipt(tx, orgId, kept, other, decision.fields, actor);
      }),
    delete: (orgId, receiptId, actor) =>
      inOrg(orgId, (tx) => deleteReceipt(tx, orgId, receiptId, actor)),
  };
}
