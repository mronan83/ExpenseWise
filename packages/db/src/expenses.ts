import {
  applyDetailsEdit,
  applyExpenseEdit,
  applyTravelEdit,
  isComplete,
  NO_DETAILS,
  NO_VALUES,
  sameDetails,
  sameTravel,
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
  type ExpenseTravel,
  type ExpenseValues,
  type AmountMatch,
  type TravelChange,
  type TravelEdit,
  type TravelEditProblem,
  type Itemization,
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
import { claimFromLines, copyReadLines } from './itemized.ts';
import { reopenChangedReports, reportsOfExpenses } from './report-touch.ts';
import { expenses, members, receipts, trips } from './schema.ts';
import { containing, fileExpenseToTrip } from './trips.ts';

/**
 * An expense as it is read back. Its journey and stay (FR-INT-20, FR-INT-21) are always read
 * from the database; a record made elsewhere, such as a test's, may leave them out.
 */
export interface ExpenseRecord extends ExpenseValues, ExpenseDetails, Partial<ExpenseTravel> {
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
  /** Why it claims less than its receipt (FR-EXP-10); read from the database, else unknown. */
  readonly claimReason?: string | null;
  /**
   * How many of its receipt's lines it leaves out of the claim, each with its reason
   * (FR-EXP-16): its reason for claiming less, line by line. Read from the database.
   */
  readonly excludedLines?: number;
  readonly editedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** The columns an ExpenseRecord is read from, joined as withProof() joins them. */
export const expenseColumns = {
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
  journeyFrom: expenses.journeyFrom,
  journeyTo: expenses.journeyTo,
  departsOn: expenses.departsOn,
  checkIn: expenses.checkIn,
  checkOut: expenses.checkOut,
  reportId: expenses.reportId,
  tripReportId: trips.reportId,
  justification: expenses.justification,
  claimReason: expenses.claimReason,
  excludedLines: sql<number>`(select count(*)::int from expense_lines l
    where l.org_id = ${expenses.orgId} and l.expense_id = ${expenses.id}
      and l.excluded_reason is not null)`,
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
  /** Only this member's (ADR-0035): a person's Expenses lists their own. */
  readonly memberId?: string;
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
  if (filter.memberId) where.push(eq(expenses.memberId, filter.memberId));
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

/**
 * A member's own expenses with no category and type yet, oldest first (FR-EXP-11, Q27). Only
 * Ready ones: one being read or needing a look is in Needs you for that already, or soon will
 * be, and a submitted one keeps what it went in with. One held as a possible duplicate waits
 * for the person's decision on the pair, so it isn't asked for twice. Call inside withOrg().
 */
export function listUncodedExpenses(
  tx: Transaction,
  memberId: string,
  limit: number,
): Promise<ExpenseRecord[]> {
  return withProof(tx)
    .where(
      and(
        eq(expenses.memberId, memberId),
        eq(expenses.status, 'ready'),
        isNull(expenses.typeId),
        sql`not ${heldAsDuplicate(expenses.id)}`,
      ),
    )
    .orderBy(sql`${expenses.transactionDate} asc nulls last`, expenses.createdAt, expenses.id)
    .limit(limit);
}

/** These expenses, those the caller may see, in date order. Call inside withOrg(). */
export async function expensesByIds(
  tx: Transaction,
  ids: readonly string[],
): Promise<ExpenseRecord[]> {
  if (ids.length === 0) return [];
  return withProof(tx)
    .where(inArray(expenses.id, [...ids]))
    .orderBy(sql`${expenses.transactionDate} asc nulls last`, expenses.createdAt, expenses.id);
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
  /**
   * Its journey and stay, from a reading asked for them (FR-INT-20, FR-INT-21). Absent: they
   * stay as they are, as for a reading made before, or with Journeys and stays off.
   */
  readonly travel?: ExpenseTravel;
  /**
   * The reading's itemized lines (ADR-0041); null when it prints none. Absent, as from a
   * confirmation, the lines stay as they are.
   */
  readonly lines?: Itemization | null;
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

/** The journey and stay, as their columns are named. */
const travelSelection = {
  journeyFrom: expenses.journeyFrom,
  journeyTo: expenses.journeyTo,
  departsOn: expenses.departsOn,
  checkIn: expenses.checkIn,
  checkOut: expenses.checkOut,
};

const travelOf = (row: ExpenseTravel): ExpenseTravel => ({
  journeyFrom: row.journeyFrom,
  journeyTo: row.journeyTo,
  departsOn: row.departsOn,
  checkIn: row.checkIn,
  checkOut: row.checkOut,
});

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
      ...(offered?.travel ? travelOf(offered.travel) : {}),
    });
    await tx.update(receipts).set({ expenseId: id }).where(eq(receipts.id, receiptId));
    await appendAuditEvent(tx, orgId, {
      actor,
      entityType: 'expense',
      entityId: id,
      action: 'expense.created',
      payload: { receiptId, status },
    });
    if (offered?.lines) await copyReadLines(tx, orgId, id, offered.lines, actor);
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
      ...travelSelection,
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
  // The journey and stay follow the same rule: a reading asked for them, until an edit.
  const currentTravel = travelOf(expense);
  const travel = fresh && offered.travel ? offered.travel : currentTravel;
  const status = receiptExpenseStatus(expense.status, receipt.status, values);
  if (status === null) return;
  // Its lines follow the receipt as its values do, until a person edits it (ADR-0041).
  if (fresh && offered.lines !== undefined) {
    await copyReadLines(tx, orgId, receipt.expenseId, offered.lines, actor);
  }
  const refreshed = !sameValues(values, current);
  const placed = !sameDetails(details, currentDetails);
  const travelled = !sameTravel(travel, currentTravel);
  if (status === expense.status && !refreshed && !placed && !travelled) return;
  await tx
    .update(expenses)
    .set({
      status,
      ...values,
      ...detailColumns(details),
      ...travelOf(travel),
      updatedAt: new Date(),
    })
    .where(eq(expenses.id, receipt.expenseId));
  await appendAuditEvent(tx, orgId, {
    actor,
    entityType: 'expense',
    entityId: receipt.expenseId,
    action: 'expense.filed',
    payload: {
      receiptId,
      status,
      previous: expense.status,
      refreshed,
      placed,
      ...(travelled ? { travelled } : {}),
    },
  });
  await reopenChangedReports(
    tx,
    orgId,
    await reportsOfExpenses(tx, [receipt.expenseId]),
    actor,
    'its receipt changed',
  );
  // A new date, or a ticket's new departure, may mean another trip (FR-EXP-19).
  if (refreshed || travel.departsOn !== currentTravel.departsOn) {
    await fileExpenseToTrip(tx, orgId, receipt.expenseId, actor);
  }
}

export type EditExpenseResult =
  | {
      readonly status: 'edited';
      readonly changes: readonly ExpenseChange[];
      readonly detailChanges: readonly DetailChange[];
      /** Its journey and stay, when the edit changed them (FR-INT-20, FR-INT-21). */
      readonly travelChanges?: readonly TravelChange[];
    }
  /** The values were already those. Nothing changed and nothing was recorded. */
  | { readonly status: 'unchanged' }
  | {
      readonly status: 'invalid';
      readonly problem: ExpenseEditProblem | DetailsEditProblem | TravelEditProblem;
    }
  | { readonly status: 'missing' }
  /** Being read, or submitted or later: not open to edits (FR-EXP-09). */
  | { readonly status: 'not_editable'; readonly current: ExpenseStatus }
  /** A mileage expense: its amount is miles × its rate, so it is edited as mileage (ADR-0038). */
  | { readonly status: 'mileage' }
  /**
   * Its amount is made of its lines or parts: a line is excluded, or it is split. Its amount or
   * currency changes only once those go (ADR-0041).
   */
  | { readonly status: 'itemized' };

/**
 * Applies a person's edit (FR-EXP-09) with its audit event, and sets the status again: a
 * receipt-based expense is Ready when its receipt is Ready and the claim is complete; one
 * typed in by hand when the claim is complete. Call inside withOrg().
 */
export async function editExpense(
  tx: Transaction,
  orgId: string,
  expenseId: string,
  edit: ExpenseEdit & { readonly details?: DetailsEdit; readonly travel?: TravelEdit },
  actorUserId: string,
): Promise<EditExpenseResult> {
  await lockOrgWrites(tx, orgId);
  const [expense] = await tx
    .select({
      status: expenses.status,
      source: expenses.source,
      merchant: expenses.merchant,
      transactionDate: expenses.transactionDate,
      currency: expenses.currency,
      amountMinor: expenses.amountMinor,
      ...detailSelection,
      ...travelSelection,
    })
    .from(expenses)
    .where(eq(expenses.id, expenseId))
    .for('update');
  if (!expense) return { status: 'missing' };
  if (expense.status !== 'needs_review' && expense.status !== 'ready') {
    return { status: 'not_editable', current: expense.status };
  }
  if (expense.source === 'mileage') return { status: 'mileage' };
  const { details: detailsEdit, travel: travelEdit, ...valuesEdit } = edit;
  const result = applyExpenseEdit(valuesOf(expense), valuesEdit);
  if (!result.ok) return { status: 'invalid', problem: result.error };
  const placed = applyDetailsEdit(detailsOf(expense), detailsEdit ?? {});
  if (!placed.ok) return { status: 'invalid', problem: placed.error };
  const travelled = applyTravelEdit(travelOf(expense), travelEdit ?? {});
  if (!travelled.ok) return { status: 'invalid', problem: travelled.error };
  const { values, changes } = result.value;
  const { details, changes: detailChanges } = placed.value;
  const { travel, changes: travelChanges } = travelled.value;
  if (changes.length === 0 && detailChanges.length === 0 && travelChanges.length === 0) {
    return { status: 'unchanged' };
  }
  if (
    changes.some((c) => c.field === 'amount' || c.field === 'currency') &&
    (await claimFromLines(tx, expenseId))
  ) {
    return { status: 'itemized' };
  }
  // Recorded only when the journey or stay changed, so other edits record what they always did.
  const travelRecord = travelChanges.length > 0 ? { travelChanges } : {};

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
    .set({
      ...values,
      ...detailColumns(details),
      ...travelOf(travel),
      status,
      editedAt: now,
      updatedAt: now,
    })
    .where(eq(expenses.id, expenseId));
  await appendAuditEvent(tx, orgId, {
    actor: { type: 'user', id: actorUserId },
    entityType: 'expense',
    entityId: expenseId,
    action: 'expense.edited',
    payload: { changes, detailChanges, ...travelRecord, status, previous: expense.status },
  });
  await reopenChangedReports(
    tx,
    orgId,
    await reportsOfExpenses(tx, [expenseId]),
    { type: 'user', id: actorUserId },
    'an expense on it was edited',
  );
  if (
    changes.some((c) => c.field === 'date') ||
    travelChanges.some((c) => c.field === 'departsOn')
  ) {
    await fileExpenseToTrip(tx, orgId, expenseId, { type: 'user', id: actorUserId });
  }
  return { status: 'edited', changes, detailChanges, ...travelRecord };
}
