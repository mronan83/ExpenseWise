import {
  applyExpenseEdit,
  isComplete,
  NO_VALUES,
  newId,
  receiptExpenseStatus,
  type ExpenseChange,
  type ExpenseEdit,
  type ExpenseEditProblem,
  type ExpenseSource,
  type ExpenseStatus,
  type ExpenseValues,
} from '@expensewise/domain';
import { and, desc, eq } from 'drizzle-orm';
import { appendAuditEvent, type AuditEntry } from './audit.ts';
import type { Transaction } from './client.ts';
import { expenses, members, receipts } from './schema.ts';

export interface ExpenseRecord extends ExpenseValues {
  readonly id: string;
  readonly memberId: string;
  readonly owner: string;
  readonly status: ExpenseStatus;
  readonly source: ExpenseSource;
  /** The receipt that proves it (FR-EXP-08); null for an expense typed in by hand. */
  readonly receiptId: string | null;
  readonly editedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

const expenseColumns = {
  id: expenses.id,
  memberId: expenses.memberId,
  owner: members.displayName,
  status: expenses.status,
  source: expenses.source,
  merchant: expenses.merchant,
  transactionDate: expenses.transactionDate,
  currency: expenses.currency,
  amountMinor: expenses.amountMinor,
  receiptId: receipts.id,
  editedAt: expenses.editedAt,
  createdAt: expenses.createdAt,
  updatedAt: expenses.updatedAt,
};

const withProof = (tx: Transaction) =>
  tx
    .select(expenseColumns)
    .from(expenses)
    .innerJoin(members, and(eq(members.orgId, expenses.orgId), eq(members.id, expenses.memberId)))
    .leftJoin(
      receipts,
      and(eq(receipts.orgId, expenses.orgId), eq(receipts.expenseId, expenses.id)),
    );

/** The newest expenses first. Call inside withOrg(). */
export function listExpenses(tx: Transaction, limit: number): Promise<ExpenseRecord[]> {
  return withProof(tx).orderBy(desc(expenses.createdAt), desc(expenses.id)).limit(limit);
}

/** One expense, or undefined. Call inside withOrg(). */
export async function getExpense(
  tx: Transaction,
  expenseId: string,
): Promise<ExpenseRecord | undefined> {
  const [row] = await withProof(tx).where(eq(expenses.id, expenseId));
  return row;
}

const valuesOf = (v: ExpenseValues): ExpenseValues => ({
  merchant: v.merchant,
  transactionDate: v.transactionDate,
  currency: v.currency,
  amountMinor: v.amountMinor,
});
const sameValues = (a: ExpenseValues, b: ExpenseValues) =>
  a.merchant === b.merchant &&
  a.transactionDate === b.transactionDate &&
  a.currency === b.currency &&
  a.amountMinor === b.amountMinor;

/**
 * Files or refreshes the expense a receipt proves, after the receipt changed: filed, read,
 * read again or confirmed (ADR-0022). Creates the expense the first time. Takes the values
 * offered (the reading or the confirmation) unless a person has edited the expense, and sets
 * its status from the receipt's. Leaves an expense that is submitted or later alone. Call
 * inside withOrg(), in the same transaction as the receipt's change.
 */
export async function fileReceiptExpense(
  tx: Transaction,
  orgId: string,
  receiptId: string,
  offered: ExpenseValues | null,
  actor: AuditEntry['actor'],
): Promise<void> {
  const [receipt] = await tx
    .select({
      status: receipts.status,
      expenseId: receipts.expenseId,
      memberId: receipts.memberId,
      source: receipts.source,
    })
    .from(receipts)
    .where(eq(receipts.id, receiptId));
  if (!receipt) return;

  if (!receipt.expenseId) {
    const values = valuesOf(offered ?? NO_VALUES);
    const status = receiptExpenseStatus(null, receipt.status, values) ?? 'needs_review';
    const id = newId();
    await tx.insert(expenses).values({
      id,
      orgId,
      memberId: receipt.memberId,
      status,
      source: receipt.source,
      ...values,
    });
    await tx.update(receipts).set({ expenseId: id }).where(eq(receipts.id, receiptId));
    await appendAuditEvent(tx, orgId, {
      actor,
      entityType: 'expense',
      entityId: id,
      action: 'expense.created',
      payload: { receiptId, status },
    });
    return;
  }

  const [expense] = await tx
    .select({
      status: expenses.status,
      editedAt: expenses.editedAt,
      merchant: expenses.merchant,
      transactionDate: expenses.transactionDate,
      currency: expenses.currency,
      amountMinor: expenses.amountMinor,
    })
    .from(expenses)
    .where(eq(expenses.id, receipt.expenseId))
    .for('update');
  if (!expense) return;
  const current = valuesOf(expense);
  // A person's edit always wins over a reading.
  const values = offered && expense.editedAt === null ? valuesOf(offered) : current;
  const status = receiptExpenseStatus(expense.status, receipt.status, values);
  if (status === null) return;
  const refreshed = !sameValues(values, current);
  if (status === expense.status && !refreshed) return;
  await tx
    .update(expenses)
    .set({ status, ...values, updatedAt: new Date() })
    .where(eq(expenses.id, receipt.expenseId));
  await appendAuditEvent(tx, orgId, {
    actor,
    entityType: 'expense',
    entityId: receipt.expenseId,
    action: 'expense.filed',
    payload: { receiptId, status, previous: expense.status, refreshed },
  });
}

export type EditExpenseResult =
  | { readonly status: 'edited'; readonly changes: readonly ExpenseChange[] }
  /** The values were already those. Nothing changed and nothing was recorded. */
  | { readonly status: 'unchanged' }
  | { readonly status: 'invalid'; readonly problem: ExpenseEditProblem }
  | { readonly status: 'missing' }
  /** Being read, or submitted or later: not open to edits (FR-EXP-09). */
  | { readonly status: 'not_editable'; readonly current: ExpenseStatus };

/**
 * Applies a person's edit (FR-EXP-09) with its audit event, and sets the status again: a
 * receipt-based expense is Ready when its receipt is Ready and the claim is complete; one
 * typed in by hand when the claim is complete. Call inside withOrg().
 */
export async function editExpense(
  tx: Transaction,
  orgId: string,
  expenseId: string,
  edit: ExpenseEdit,
  actorUserId: string,
): Promise<EditExpenseResult> {
  const [expense] = await tx
    .select({
      status: expenses.status,
      merchant: expenses.merchant,
      transactionDate: expenses.transactionDate,
      currency: expenses.currency,
      amountMinor: expenses.amountMinor,
    })
    .from(expenses)
    .where(eq(expenses.id, expenseId))
    .for('update');
  if (!expense) return { status: 'missing' };
  if (expense.status !== 'needs_review' && expense.status !== 'ready') {
    return { status: 'not_editable', current: expense.status };
  }
  const result = applyExpenseEdit(valuesOf(expense), edit);
  if (!result.ok) return { status: 'invalid', problem: result.error };
  const { values, changes } = result.value;
  if (changes.length === 0) return { status: 'unchanged' };

  const [proof] = await tx
    .select({ id: receipts.id, status: receipts.status })
    .from(receipts)
    .where(eq(receipts.expenseId, expenseId));
  const status = proof
    ? (receiptExpenseStatus(expense.status, proof.status, values) ?? expense.status)
    : isComplete(values)
      ? 'ready'
      : 'needs_review';
  const now = new Date();
  await tx
    .update(expenses)
    .set({ ...values, status, editedAt: now, updatedAt: now })
    .where(eq(expenses.id, expenseId));
  await appendAuditEvent(tx, orgId, {
    actor: { type: 'user', id: actorUserId },
    entityType: 'expense',
    entityId: expenseId,
    action: 'expense.edited',
    payload: { changes, status, previous: expense.status },
  });
  return { status: 'edited', changes };
}
