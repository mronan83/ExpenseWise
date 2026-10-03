import {
  assertRowSecurityApplies,
  editExpense,
  getExpense,
  getReceipt,
  listExpenses,
  listExtractionRuns,
  listReceiptReviews,
  receiptsById,
  withOrg,
  type Database,
  type EditExpenseResult,
  type ExpenseRecord,
  type ExtractionRunRecord,
  type ReceiptRecord,
  type ReceiptReviewRecord,
} from '@expensewise/db';
import type { ExpenseEdit } from '@expensewise/domain';
import type { ReceiptWithReadings } from './receipts.ts';

/** What the API needs from the database for expenses. Tests use an in-memory fake. */
export interface ExpenseStore {
  list(
    orgId: string,
    limit: number,
  ): Promise<{
    expenses: ExpenseRecord[];
    receipts: ReceiptRecord[];
    runs: ExtractionRunRecord[];
    reviews: ReceiptReviewRecord[];
  }>;
  get(
    orgId: string,
    expenseId: string,
  ): Promise<{ expense: ExpenseRecord; proof: ReceiptWithReadings | null } | undefined>;
  /** Applies a person's edit; the audit event commits with it. */
  edit(
    orgId: string,
    expenseId: string,
    edit: ExpenseEdit,
    actorUserId: string,
  ): Promise<EditExpenseResult>;
}

/** The expense store on Postgres, as expensewise_app. It checks the role once. */
export function dbExpenseStore(db: Database): ExpenseStore {
  let checked: Promise<void> | undefined;
  const safe = () =>
    (checked ??= assertRowSecurityApplies(db).catch((error: unknown) => {
      checked = undefined;
      throw error;
    }));
  const inOrg = async <T>(orgId: string, work: Parameters<typeof withOrg<T>>[2]) => {
    await safe();
    return withOrg(db, orgId, work);
  };

  return {
    list: (orgId, limit) =>
      inOrg(orgId, async (tx) => {
        const expenses = await listExpenses(tx, limit);
        const receiptIds = expenses.flatMap((e) => (e.receiptId ? [e.receiptId] : []));
        const receipts = await receiptsById(tx, receiptIds);
        return {
          expenses,
          receipts,
          runs: await listExtractionRuns(tx, receiptIds),
          reviews: await listReceiptReviews(tx, receiptIds),
        };
      }),
    get: (orgId, expenseId) =>
      inOrg(orgId, async (tx) => {
        const expense = await getExpense(tx, expenseId);
        if (!expense) return undefined;
        const receipt = expense.receiptId ? await getReceipt(tx, expense.receiptId) : undefined;
        return {
          expense,
          proof: receipt
            ? {
                receipt,
                runs: await listExtractionRuns(tx, [receipt.id]),
                reviews: await listReceiptReviews(tx, [receipt.id]),
              }
            : null,
        };
      }),
    edit: (orgId, expenseId, edit, actor) =>
      inOrg(orgId, (tx) => editExpense(tx, orgId, expenseId, edit, actor)),
  };
}
