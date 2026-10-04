import {
  isExpenseEditable,
  type DetailsEditProblem,
  type ExpenseEdit,
  type ExpenseEditProblem,
} from '@expensewise/domain';
import { desc, eq } from 'drizzle-orm';
import { appendAuditEvent, lockOrgWrites } from './audit.ts';
import type { Transaction } from './client.ts';
import { editExpense } from './expenses.ts';
import type { NewReceiptReview } from './receipts.ts';
import { expenses, extractionRuns, receiptReviews, receipts } from './schema.ts';

/** One field a person corrected on a Ready receipt: what it was filed with, and now. */
export interface ReceiptFieldChange {
  readonly field: string;
  readonly from: string | null;
  readonly to: string;
}

export type CorrectReceiptResult =
  | { readonly status: 'corrected' }
  /** No such receipt in this organization. */
  | { readonly status: 'missing' }
  /** Not Ready: being read, or waiting for a look, which Edit a field confirms instead. */
  | { readonly status: 'not_ready' }
  /** It was read again after the reading corrected was shown. */
  | { readonly status: 'stale' }
  /** Its expense is submitted or further along: locked (FR-EXP-03). */
  | { readonly status: 'locked' }
  /** The expense can't take the value, such as an amount its currency can't hold. */
  | { readonly status: 'invalid'; readonly problem: ExpenseEditProblem | DetailsEditProblem };

/**
 * Corrects fields of a Ready receipt (GAP-14): a new review row with every value it is now
 * filed with and each correction beside what the model read, the same eval candidate Edit a
 * field keeps (ADR-0021); the change to its expense as an edit, before submission, audited as
 * any edit is (ADR-0022); and `receipt.corrected` in the audit trail, all in the caller's
 * transaction. An expense submitted or further along is locked: correcting an approved one is a
 * reversal (FR-EXP-03), which isn't built. Call inside withOrg().
 */
export async function correctReceipt(
  tx: Transaction,
  orgId: string,
  receiptId: string,
  correction: {
    /** Every value the receipt is filed with now, and every correction to the reading. */
    readonly review: NewReceiptReview;
    /** What changes on its expense: the merchant, date, currency or amount, as typed. */
    readonly expense: ExpenseEdit;
    /** The fields changed now, from what was filed to what is. */
    readonly changes: readonly ReceiptFieldChange[];
  },
  actorUserId: string,
): Promise<CorrectReceiptResult> {
  // The organization first, then the receipt, then its expense: the order every writer takes.
  await lockOrgWrites(tx, orgId);
  const [receipt] = await tx
    .select({ status: receipts.status, expenseId: receipts.expenseId })
    .from(receipts)
    .where(eq(receipts.id, receiptId))
    .for('update');
  if (!receipt) return { status: 'missing' };
  if (receipt.status !== 'extracted') return { status: 'not_ready' };
  const [latest] = await tx
    .select({ requestId: extractionRuns.requestId })
    .from(extractionRuns)
    .where(eq(extractionRuns.receiptId, receiptId))
    .orderBy(desc(extractionRuns.createdAt), desc(extractionRuns.id))
    .limit(1);
  if ((latest?.requestId ?? null) !== correction.review.requestId) return { status: 'stale' };

  if (receipt.expenseId) {
    const [expense] = await tx
      .select({ status: expenses.status })
      .from(expenses)
      .where(eq(expenses.id, receipt.expenseId))
      .for('update');
    if (expense && !isExpenseEditable(expense.status)) return { status: 'locked' };
    if (Object.keys(correction.expense).length > 0) {
      // Validated before anything is written, so a refusal leaves nothing behind.
      const edited = await editExpense(
        tx,
        orgId,
        receipt.expenseId,
        correction.expense,
        actorUserId,
      );
      if (edited.status === 'invalid') return edited;
      if (edited.status === 'not_editable') return { status: 'locked' };
    }
  }

  await tx.insert(receiptReviews).values({ ...correction.review, orgId, receiptId });
  await appendAuditEvent(tx, orgId, {
    actor: { type: 'user', id: actorUserId },
    entityType: 'receipt',
    entityId: receiptId,
    action: 'receipt.corrected',
    payload: {
      requestId: correction.review.requestId,
      model: correction.review.model,
      changes: correction.changes,
    },
  });
  return { status: 'corrected' };
}
