import {
  applyDetailsEdit,
  applyExpenseEdit,
  isComplete,
  NO_DETAILS,
  NO_VALUES,
  sameDetails,
  newId,
  receiptExpenseStatus,
  type DetailChange,
  type DetailsEdit,
  type DetailsEditProblem,
  type ExpenseChange,
  type ExpenseDetails,
  type ExpenseEdit,
  type ExpenseEditProblem,
  type ExpenseSource,
  type ExpenseStatus,
  type ExpenseValues,
  type AmountMatch,
} from '@expensewise/domain';
import {
  and,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { appendAuditEvent, lockOrgWrites, type AuditEntry } from './audit.ts';
import type { Transaction } from './client.ts';
import { heldAsDuplicate } from './duplicates.ts';
import { reopenChangedReports, reportsOfExpenses } from './report-touch.ts';
import { expenses, members, receipts, trips } from './schema.ts';
import { containing, fileExpenseToTrip } from './trips.ts';

export interface ExpenseRecord extends ExpenseValues, ExpenseDetails {
  readonly id: string;
  readonly memberId: string;
  readonly owner: string;
  readonly status: ExpenseStatus;
  readonly source: ExpenseSource;
  /** The receipt that proves it (FR-EXP-08); null for an expense typed in by hand. */
  readonly receiptId: string | null;
  /** The trip it is filed to (FR-EXP-04), and its name; null for none. */
  readonly tripId: string | null;
  readonly tripName: string | null;
  /** A person chose its trip, or chose none: filing by date leaves it there (ADR-0023). */
  readonly tripPinned: boolean;
  /** The report a local expense is on (FR-EXP-14); null on a trip, which has its own. */
  readonly reportId: string | null;
  /** The report its trip is on, for an expense on a trip. */
  readonly tripReportId: string | null;
  /** Why a local expense was for business; its report can't close without it. */
  readonly justification: string | null;
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
  tripId: expenses.tripId,
  tripName: trips.name,
  tripPinned: expenses.tripPinned,
  time: expenses.transactionTime,
  timeZone: expenses.timeZone,
  address: expenses.merchantAddress,
  city: expenses.merchantCity,
  region: expenses.merchantRegion,
  country: expenses.merchantCountry,
  reportId: expenses.reportId,
  tripReportId: trips.reportId,
  justification: expenses.justification,
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
    )
    .leftJoin(trips, and(eq(trips.orgId, expenses.orgId), eq(trips.id, expenses.tripId)));

/** Narrows a list of expenses (FR-INS-02). Every part given must match. */
export interface ExpenseFilter {
  /** Part of the merchant's name, in any case. */
  readonly q?: string;
  /** Dated on or after this day. */
  readonly from?: string;
  /** Dated on or before this day. */
  readonly to?: string;
  /** The amount, as it is in each currency it could be (amountMatches in the domain). */
  readonly amounts?: readonly AmountMatch[];
  readonly tripId?: string;
  /** true: on some trip. false: on none. */
  readonly onTrip?: boolean;
}

const matching = (filter: ExpenseFilter): SQL | undefined => {
  const where: SQL[] = [];
  if (filter.q?.trim()) where.push(sql`${expenses.merchant} ilike ${containing(filter.q)}`);
  if (filter.from) where.push(gte(expenses.transactionDate, filter.from));
  if (filter.to) where.push(lte(expenses.transactionDate, filter.to));
  if (filter.amounts) {
    const amounts = filter.amounts.map((m) =>
      and(eq(expenses.amountMinor, m.amountMinor), inArray(expenses.currency, [...m.currencies])),
    );
    where.push(or(...amounts) ?? sql`false`);
  }
  if (filter.tripId) where.push(eq(expenses.tripId, filter.tripId));
  if (filter.onTrip !== undefined) {
    where.push(filter.onTrip ? isNotNull(expenses.tripId) : isNull(expenses.tripId));
  }
  return and(...where);
};

/** The newest expenses first, those that match. Call inside withOrg(). */
export function listExpenses(
  tx: Transaction,
  limit: number,
  filter: ExpenseFilter = {},
): Promise<ExpenseRecord[]> {
  return withProof(tx)
    .where(matching(filter))
    .orderBy(desc(expenses.createdAt), desc(expenses.id))
    .limit(limit);
}

/** A trip's expenses in date order, undated last. Call inside withOrg(). */
export function listTripExpenses(tx: Transaction, tripId: string): Promise<ExpenseRecord[]> {
  return withProof(tx)
    .where(eq(expenses.tripId, tripId))
    .orderBy(sql`${expenses.transactionDate} asc nulls last`, expenses.createdAt, expenses.id);
}

/** A local expense on a report, and whether it is held as a possible duplicate. */
export interface ReportExpenseRecord extends ExpenseRecord {
  /** Held as a possible duplicate: it counts in no total until the person decides. */
  readonly held: boolean;
}

/** The local expenses on these reports, in date order. Call inside withOrg(). */
export async function listReportExpenses(
  tx: Transaction,
  reportIds: readonly string[],
): Promise<ReportExpenseRecord[]> {
  if (reportIds.length === 0) return [];
  return tx
    .select({ ...expenseColumns, held: sql<boolean>`${heldAsDuplicate(expenses.id)}` })
    .from(expenses)
    .innerJoin(members, and(eq(members.orgId, expenses.orgId), eq(members.id, expenses.memberId)))
    .leftJoin(
      receipts,
      and(eq(receipts.orgId, expenses.orgId), eq(receipts.expenseId, expenses.id)),
    )
    .leftJoin(trips, and(eq(trips.orgId, expenses.orgId), eq(trips.id, expenses.tripId)))
    .where(inArray(expenses.reportId, [...reportIds]))
    .orderBy(sql`${expenses.transactionDate} asc nulls last`, expenses.createdAt, expenses.id);
}

/**
 * A member's local expenses that say nothing yet of why they were for business, oldest first
 * (FR-EXP-14). Only Ready ones: one still needing a look is in Needs you for that already.
 */
export function listUnjustifiedExpenses(
  tx: Transaction,
  memberId: string,
  limit: number,
): Promise<ExpenseRecord[]> {
  return withProof(tx)
    .where(
      and(
        eq(expenses.memberId, memberId),
        isNull(expenses.tripId),
        isNotNull(expenses.transactionDate),
        eq(expenses.status, 'ready'),
        isNull(expenses.justification),
      ),
    )
    .orderBy(expenses.transactionDate, expenses.id)
    .limit(limit);
}

/** One expense, or undefined. Call inside withOrg(). */
export async function getExpense(
  tx: Transaction,
  expenseId: string,
): Promise<ExpenseRecord | undefined> {
  const [row] = await withProof(tx).where(eq(expenses.id, expenseId));
  return row;
}

/** What a reading or a confirmation offers an expense: its values, and its time and place. */
export interface ReceiptOffer extends ExpenseValues {
  /** Absent: the time and place stay as they are. */
  readonly details?: ExpenseDetails;
}

/** The time and place as columns. */
const detailColumns = (d: ExpenseDetails) => ({
  transactionTime: d.time,
  timeZone: d.timeZone,
  merchantAddress: d.address,
  merchantCity: d.city,
  merchantRegion: d.region,
  merchantCountry: d.country,
});

const detailsOf = (row: {
  transactionTime: string | null;
  timeZone: string | null;
  merchantAddress: string | null;
  merchantCity: string | null;
  merchantRegion: string | null;
  merchantCountry: string | null;
}): ExpenseDetails => ({
  time: row.transactionTime,
  timeZone: row.timeZone,
  address: row.merchantAddress,
  city: row.merchantCity,
  region: row.merchantRegion,
  country: row.merchantCountry,
});

const detailSelection = {
  transactionTime: expenses.transactionTime,
  timeZone: expenses.timeZone,
  merchantAddress: expenses.merchantAddress,
  merchantCity: expenses.merchantCity,
  merchantRegion: expenses.merchantRegion,
  merchantCountry: expenses.merchantCountry,
};

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
  offered: ReceiptOffer | null,
  actor: AuditEntry['actor'],
): Promise<void> {
  // Before any expense is locked, so filing it to a trip sees every trip settled (ADR-0023).
  await lockOrgWrites(tx, orgId);
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
      ...detailColumns(offered?.details ?? NO_DETAILS),
    });
    await tx.update(receipts).set({ expenseId: id }).where(eq(receipts.id, receiptId));
    await appendAuditEvent(tx, orgId, {
      actor,
      entityType: 'expense',
      entityId: id,
      action: 'expense.created',
      payload: { receiptId, status },
    });
    await fileExpenseToTrip(tx, orgId, id, actor);
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
      ...detailSelection,
    })
    .from(expenses)
    .where(eq(expenses.id, receipt.expenseId))
    .for('update');
  if (!expense) return;
  const current = valuesOf(expense);
  const currentDetails = detailsOf(expense);
  // A person's edit always wins over a reading, its time and place included.
  const fresh = offered !== null && expense.editedAt === null;
  const values = fresh ? valuesOf(offered) : current;
  const details = fresh && offered.details ? offered.details : currentDetails;
  const status = receiptExpenseStatus(expense.status, receipt.status, values);
  if (status === null) return;
  const refreshed = !sameValues(values, current);
  const placed = !sameDetails(details, currentDetails);
  if (status === expense.status && !refreshed && !placed) return;
  await tx
    .update(expenses)
    .set({ status, ...values, ...detailColumns(details), updatedAt: new Date() })
    .where(eq(expenses.id, receipt.expenseId));
  await appendAuditEvent(tx, orgId, {
    actor,
    entityType: 'expense',
    entityId: receipt.expenseId,
    action: 'expense.filed',
    payload: { receiptId, status, previous: expense.status, refreshed, placed },
  });
  await reopenChangedReports(
    tx,
    orgId,
    await reportsOfExpenses(tx, [receipt.expenseId]),
    actor,
    'its receipt changed',
  );
  if (refreshed) await fileExpenseToTrip(tx, orgId, receipt.expenseId, actor);
}

export type EditExpenseResult =
  | {
      readonly status: 'edited';
      readonly changes: readonly ExpenseChange[];
      readonly detailChanges: readonly DetailChange[];
    }
  /** The values were already those. Nothing changed and nothing was recorded. */
  | { readonly status: 'unchanged' }
  | { readonly status: 'invalid'; readonly problem: ExpenseEditProblem | DetailsEditProblem }
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
  edit: ExpenseEdit & { readonly details?: DetailsEdit },
  actorUserId: string,
): Promise<EditExpenseResult> {
  await lockOrgWrites(tx, orgId);
  const [expense] = await tx
    .select({
      status: expenses.status,
      merchant: expenses.merchant,
      transactionDate: expenses.transactionDate,
      currency: expenses.currency,
      amountMinor: expenses.amountMinor,
      ...detailSelection,
    })
    .from(expenses)
    .where(eq(expenses.id, expenseId))
    .for('update');
  if (!expense) return { status: 'missing' };
  if (expense.status !== 'needs_review' && expense.status !== 'ready') {
    return { status: 'not_editable', current: expense.status };
  }
  const { details: detailsEdit, ...valuesEdit } = edit;
  const result = applyExpenseEdit(valuesOf(expense), valuesEdit);
  if (!result.ok) return { status: 'invalid', problem: result.error };
  const placed = applyDetailsEdit(detailsOf(expense), detailsEdit ?? {});
  if (!placed.ok) return { status: 'invalid', problem: placed.error };
  const { values, changes } = result.value;
  const { details, changes: detailChanges } = placed.value;
  if (changes.length === 0 && detailChanges.length === 0) return { status: 'unchanged' };

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
    .set({ ...values, ...detailColumns(details), status, editedAt: now, updatedAt: now })
    .where(eq(expenses.id, expenseId));
  await appendAuditEvent(tx, orgId, {
    actor: { type: 'user', id: actorUserId },
    entityType: 'expense',
    entityId: expenseId,
    action: 'expense.edited',
    payload: { changes, detailChanges, status, previous: expense.status },
  });
  await reopenChangedReports(
    tx,
    orgId,
    await reportsOfExpenses(tx, [expenseId]),
    { type: 'user', id: actorUserId },
    'an expense on it was edited',
  );
  if (changes.some((c) => c.field === 'date')) {
    await fileExpenseToTrip(tx, orgId, expenseId, { type: 'user', id: actorUserId });
  }
  return { status: 'edited', changes, detailChanges };
}
