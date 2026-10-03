import {
  assertRowSecurityApplies,
  editExpense,
  getExpense,
  getReceipt,
  listExpenses,
  listExtractionRuns,
  listReceiptReviews,
  receiptsById,
  setExpenseTrip,
  withOrg,
  type Database,
  type EditExpenseResult,
  type ExpenseFilter,
  type ExpenseRecord,
  type ExtractionRunRecord,
  type ReceiptRecord,
  type ReceiptReviewRecord,
  type SetExpenseTripResult,
  type Transaction,
  type TripChoice,
} from '@expensewise/db';
import type { ExpenseEdit } from '@expensewise/domain';
import type { ReceiptWithReadings } from './receipts.ts';

/** Expenses with what their receipts show: the receipts, their readings and reviews. */
export interface ExpensesWithProof {
  readonly expenses: ExpenseRecord[];
  readonly receipts: ReceiptRecord[];
  readonly runs: ExtractionRunRecord[];
  readonly reviews: ReceiptReviewRecord[];
}

/** Loads the receipts that prove these expenses. Call inside withOrg(). */
export async function withProofs(
  tx: Transaction,
  expenses: ExpenseRecord[],
): Promise<ExpensesWithProof> {
  const receiptIds = expenses.flatMap((e) => (e.receiptId ? [e.receiptId] : []));
  return {
    expenses,
    receipts: await receiptsById(tx, receiptIds),
    runs: await listExtractionRuns(tx, receiptIds),
    reviews: await listReceiptReviews(tx, receiptIds),
  };
}

/** What the API needs from the database for expenses. Tests use an in-memory fake. */
export interface ExpenseStore {
  list(orgId: string, limit: number, filter?: ExpenseFilter): Promise<ExpensesWithProof>;
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
  /** Puts it on a trip, on none, or back to filing by date (ADR-0023). */
  setTrip(
    orgId: string,
    expenseId: string,
    choice: TripChoice,
    actorUserId: string,
  ): Promise<SetExpenseTripResult>;
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
    list: (orgId, limit, filter) =>
      inOrg(orgId, async (tx) => withProofs(tx, await listExpenses(tx, limit, filter))),
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
    setTrip: (orgId, expenseId, choice, actor) =>
      inOrg(orgId, (tx) => setExpenseTrip(tx, orgId, expenseId, choice, actor)),
  };
}
