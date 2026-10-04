import {
  applyTripInput,
  isTripMovable,
  tripFor,
  type ExpenseStatus,
  type TripChange,
  type TripInput,
  type TripProblem,
  type TripValues,
  type TripWindow,
} from '@expensewise/domain';
import { and, desc, eq, exists, gte, inArray, lte, not, or, sql, type SQL } from 'drizzle-orm';
import { appendAuditEvent, lockOrgWrites, type AuditEntry } from './audit.ts';
import type { Transaction } from './client.ts';
import { heldAsDuplicate } from './duplicates.ts';
import { reopenChangedReports, reportsOfExpenses, reportsOfTrips } from './report-touch.ts';
import { expenses, members, trips } from './schema.ts';

export interface TripRecord extends TripValues {
  readonly id: string;
  readonly memberId: string;
  readonly owner: string;
  /** The report it is on (FR-EXP-05), or null before it joins one. */
  readonly reportId: string | null;
  readonly createdAt: Date;
}

const tripColumns = {
  id: trips.id,
  memberId: trips.memberId,
  owner: members.displayName,
  name: trips.name,
  purpose: trips.purpose,
  primaryCity: trips.primaryCity,
  startDate: trips.startDate,
  endDate: trips.endDate,
  reportId: trips.reportId,
  createdAt: trips.createdAt,
};

/** Trips with their owner's name, to be filtered and ordered. Call inside withOrg(). */
export const tripsWithOwner = (tx: Transaction) =>
  tx
    .select(tripColumns)
    .from(trips)
    .innerJoin(members, and(eq(members.orgId, trips.orgId), eq(members.id, trips.memberId)));

/** `text` as a case-insensitive LIKE pattern that matches it anywhere, wildcards escaped. */
export const containing = (text: string): string =>
  `%${text.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

export interface TripFilter {
  /** Matches the name, purpose or city, or the merchant of an expense on the trip. */
  readonly q?: string;
  /** Trips that end on or after this date. */
  readonly from?: string;
  /** Trips that start on or before this date. */
  readonly to?: string;
  /** Only this member's (ADR-0035): a person's Trips lists their own. */
  readonly memberId?: string;
}

/** The trips that match, latest first (FR-INS-02). Call inside withOrg(). */
export function listTrips(
  tx: Transaction,
  limit: number,
  filter: TripFilter = {},
): Promise<TripRecord[]> {
  const where: SQL[] = [];
  if (filter.q?.trim()) {
    const like = containing(filter.q);
    const onTrip = tx
      .select({ id: expenses.id })
      .from(expenses)
      .where(
        and(
          eq(expenses.orgId, trips.orgId),
          eq(expenses.tripId, trips.id),
          sql`${expenses.merchant} ilike ${like}`,
        ),
      );
    where.push(
      or(
        sql`${trips.name} ilike ${like}`,
        sql`${trips.purpose} ilike ${like}`,
        sql`${trips.primaryCity} ilike ${like}`,
        exists(onTrip),
      ) as SQL,
    );
  }
  if (filter.from) where.push(gte(trips.endDate, filter.from));
  if (filter.to) where.push(lte(trips.startDate, filter.to));
  if (filter.memberId) where.push(eq(trips.memberId, filter.memberId));
  return tripsWithOwner(tx)
    .where(and(...where))
    .orderBy(desc(trips.startDate), desc(trips.createdAt), desc(trips.id))
    .limit(limit);
}

/** One trip, or undefined. Call inside withOrg(). */
export async function getTrip(tx: Transaction, tripId: string): Promise<TripRecord | undefined> {
  const [row] = await tripsWithOwner(tx).where(eq(trips.id, tripId));
  return row;
}

/** Counts and sums of a trip's expenses, by currency and status. */
export interface TripTally {
  readonly tripId: string;
  readonly status: ExpenseStatus;
  readonly currency: string | null;
  readonly count: number;
  /** Integer minor units; null where no amount is known yet. */
  readonly amountMinor: number | null;
}

/** What is on each of these trips, tallied. Call inside withOrg(). */
export async function tallyTrips(
  tx: Transaction,
  tripIds: readonly string[],
): Promise<TripTally[]> {
  if (tripIds.length === 0) return [];
  const rows = await tx
    .select({
      tripId: sql<string>`${expenses.tripId}`.mapWith(String),
      status: expenses.status,
      currency: expenses.currency,
      count: sql<number>`count(*)::int`,
      // Summed as text so a large total is never squeezed through a float.
      amountMinor: sql<string | null>`sum(${expenses.amountMinor})::text`,
    })
    .from(expenses)
    .where(and(inArray(expenses.tripId, [...tripIds]), not(heldAsDuplicate(expenses.id))))
    .groupBy(expenses.tripId, expenses.status, expenses.currency);
  return rows.map((r) => ({
    ...r,
    amountMinor: r.amountMinor === null ? null : safeMinor(r.amountMinor),
  }));
}

/** A summed bigint as a number, refusing one beyond the range money is kept in. */
export const safeMinor = (digits: string): number => {
  const value = BigInt(digits);
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new RangeError('A trip total is beyond the range money is kept in');
  }
  return Number(value);
};

/** An expense as filing to trips sees it. */
interface Fileable {
  readonly id: string;
  readonly tripId: string | null;
  readonly tripPinned: boolean;
  readonly status: ExpenseStatus;
  readonly transactionDate: string | null;
}

const fileableColumns = {
  id: expenses.id,
  tripId: expenses.tripId,
  tripPinned: expenses.tripPinned,
  status: expenses.status,
  transactionDate: expenses.transactionDate,
};

/** The member's trips that share at least one day with from–to. */
const tripsOverlapping = (
  tx: Transaction,
  memberId: string,
  from: string,
  to: string,
): Promise<TripWindow[]> =>
  tx
    .select({
      id: trips.id,
      startDate: trips.startDate,
      endDate: trips.endDate,
      createdAt: trips.createdAt,
    })
    .from(trips)
    .where(and(eq(trips.memberId, memberId), lte(trips.startDate, to), gte(trips.endDate, from)));

/**
 * Files each expense to the trip its date falls in, among `windows`, unless a person chose its
 * trip or it is submitted or later. Records each move. Returns how many moved.
 */
async function fileByDate(
  tx: Transaction,
  orgId: string,
  candidates: readonly Fileable[],
  windows: readonly TripWindow[],
  actor: AuditEntry['actor'],
): Promise<number> {
  let moved = 0;
  for (const expense of candidates) {
    if (expense.tripPinned || !isTripMovable(expense.status)) continue;
    const tripId = tripFor(expense.transactionDate, windows)?.id ?? null;
    if (tripId === expense.tripId) continue;
    // The reports it leaves and joins change: a closed one reopens (ADR-0029).
    const touched = [
      ...(await reportsOfExpenses(tx, [expense.id])),
      ...(await reportsOfTrips(tx, [tripId])),
    ];
    // On a trip it goes with the trip's report; leaving one, it is local and joins its own.
    await tx
      .update(expenses)
      .set({ tripId, reportId: null, updatedAt: new Date() })
      .where(eq(expenses.id, expense.id));
    await reopenChangedReports(tx, orgId, touched, actor, 'an expense moved trips');
    await appendAuditEvent(tx, orgId, {
      actor,
      entityType: 'expense',
      entityId: expense.id,
      action: 'expense.trip_filed',
      payload: { tripId, previous: expense.tripId, date: expense.transactionDate },
    });
    moved++;
  }
  return moved;
}

/**
 * Files one expense to the trip its date falls in (FR-EXP-01, ADR-0023), after its values
 * changed. Leaves it where it is if a person chose its trip or it is submitted or later. The
 * caller takes lockOrgWrites() before it locks the expense. Call inside withOrg().
 */
export async function fileExpenseToTrip(
  tx: Transaction,
  orgId: string,
  expenseId: string,
  actor: AuditEntry['actor'],
): Promise<void> {
  await lockOrgWrites(tx, orgId);
  const [expense] = await tx
    .select({ ...fileableColumns, memberId: expenses.memberId })
    .from(expenses)
    .where(eq(expenses.id, expenseId))
    .for('update');
  if (!expense || expense.tripPinned || !isTripMovable(expense.status)) return;
  const date = expense.transactionDate;
  const windows = date ? await tripsOverlapping(tx, expense.memberId, date, date) : [];
  await fileByDate(tx, orgId, [expense], windows, actor);
}

/**
 * Files again the member's expenses that a trip's dates touch: those dated from–to, and those
 * on the trip now. Locks them first, so no change to them is lost.
 */
async function refileAround(
  tx: Transaction,
  orgId: string,
  memberId: string,
  tripId: string,
  from: string,
  to: string,
  actor: AuditEntry['actor'],
): Promise<number> {
  const candidates = await tx
    .select(fileableColumns)
    .from(expenses)
    .where(
      and(
        eq(expenses.memberId, memberId),
        eq(expenses.tripPinned, false),
        inArray(expenses.status, ['processing', 'needs_review', 'ready']),
        or(
          eq(expenses.tripId, tripId),
          and(gte(expenses.transactionDate, from), lte(expenses.transactionDate, to)),
        ),
      ),
    )
    .orderBy(expenses.transactionDate, expenses.id)
    .for('update');
  if (candidates.length === 0) return 0;
  const dates = candidates.flatMap((e) => (e.transactionDate ? [e.transactionDate] : []));
  const lo = [from, ...dates].reduce((a, b) => (a < b ? a : b));
  const hi = [to, ...dates].reduce((a, b) => (a > b ? a : b));
  const windows = await tripsOverlapping(tx, memberId, lo, hi);
  return fileByDate(tx, orgId, candidates, windows, actor);
}

export type SaveTripResult =
  | { readonly status: 'saved'; readonly tripId: string; readonly refiled: number }
  /** The values were already those. Nothing changed and nothing was recorded. */
  | { readonly status: 'unchanged'; readonly tripId: string }
  | { readonly status: 'invalid'; readonly problem: TripProblem }
  | { readonly status: 'missing' };

const changePayload = (changes: readonly TripChange[]) =>
  Object.fromEntries(changes.map((c) => [c.field, { from: c.from, to: c.to }]));

/**
 * Makes a trip for a member (FR-EXP-04) and files their expenses dated in it, with the audit
 * events. Call inside withOrg().
 */
export async function createTrip(
  tx: Transaction,
  orgId: string,
  memberId: string,
  input: TripInput,
  actorUserId: string,
): Promise<SaveTripResult> {
  const applied = applyTripInput(null, input);
  if (!applied.ok) return { status: 'invalid', problem: applied.error };
  const { values, changes } = applied.value;
  const actor = { type: 'user', id: actorUserId } as const;
  await lockOrgWrites(tx, orgId);
  const [trip] = await tx
    .insert(trips)
    .values({ orgId, memberId, ...values })
    .returning({ id: trips.id });
  if (!trip) throw new Error('The new trip is not visible');
  await appendAuditEvent(tx, orgId, {
    actor,
    entityType: 'trip',
    entityId: trip.id,
    action: 'trip.created',
    payload: { memberId, ...changePayload(changes) },
  });
  const refiled = await refileAround(
    tx,
    orgId,
    memberId,
    trip.id,
    values.startDate,
    values.endDate,
    actor,
  );
  return { status: 'saved', tripId: trip.id, refiled };
}

/**
 * Changes the fields sent, records each change, and files again the expenses whose trip the
 * new dates change. Call inside withOrg().
 */
export async function editTrip(
  tx: Transaction,
  orgId: string,
  tripId: string,
  input: TripInput,
  actorUserId: string,
): Promise<SaveTripResult> {
  await lockOrgWrites(tx, orgId);
  const [current] = await tx
    .select({
      memberId: trips.memberId,
      name: trips.name,
      purpose: trips.purpose,
      primaryCity: trips.primaryCity,
      startDate: trips.startDate,
      endDate: trips.endDate,
    })
    .from(trips)
    .where(eq(trips.id, tripId))
    .for('update');
  if (!current) return { status: 'missing' };
  const applied = applyTripInput(current, input);
  if (!applied.ok) return { status: 'invalid', problem: applied.error };
  const { values, changes } = applied.value;
  if (changes.length === 0) return { status: 'unchanged', tripId };

  const actor = { type: 'user', id: actorUserId } as const;
  await tx.update(trips).set(values).where(eq(trips.id, tripId));
  await appendAuditEvent(tx, orgId, {
    actor,
    entityType: 'trip',
    entityId: tripId,
    action: 'trip.edited',
    payload: changePayload(changes),
  });
  await reopenChangedReports(
    tx,
    orgId,
    await reportsOfTrips(tx, [tripId]),
    actor,
    'a trip on it was edited',
  );
  const datesMoved = changes.some((c) => c.field === 'startDate' || c.field === 'endDate');
  const refiled = datesMoved
    ? await refileAround(
        tx,
        orgId,
        current.memberId,
        tripId,
        values.startDate < current.startDate ? values.startDate : current.startDate,
        values.endDate > current.endDate ? values.endDate : current.endDate,
        actor,
      )
    : 0;
  return { status: 'saved', tripId, refiled };
}

export type DeleteTripResult =
  | { readonly status: 'deleted'; readonly refiled: number }
  | { readonly status: 'missing' }
  /** Some of its expenses are submitted or later; they stay with their trip. */
  | { readonly status: 'has_submitted'; readonly count: number };

/**
 * Deletes a trip that nothing submitted rests on. Its expenses file by date to whatever other
 * trip covers them, including any a person had put on it. Call inside withOrg().
 */
export async function deleteTrip(
  tx: Transaction,
  orgId: string,
  tripId: string,
  actorUserId: string,
): Promise<DeleteTripResult> {
  await lockOrgWrites(tx, orgId);
  const [trip] = await tx
    .select({
      memberId: trips.memberId,
      name: trips.name,
      startDate: trips.startDate,
      endDate: trips.endDate,
    })
    .from(trips)
    .where(eq(trips.id, tripId))
    .for('update');
  if (!trip) return { status: 'missing' };
  const onTrip = await tx
    .select(fileableColumns)
    .from(expenses)
    .where(eq(expenses.tripId, tripId))
    .orderBy(expenses.transactionDate, expenses.id)
    .for('update');
  const submitted = onTrip.filter((e) => !isTripMovable(e.status)).length;
  if (submitted > 0) return { status: 'has_submitted', count: submitted };

  const actor = { type: 'user', id: actorUserId } as const;
  // The trip leaves its report; a closed one reopens, and one left empty is dropped later.
  await reopenChangedReports(
    tx,
    orgId,
    await reportsOfTrips(tx, [tripId]),
    actor,
    'a trip on it was deleted',
  );
  // A choice of this trip goes with it: each expense files by date again.
  await tx
    .update(expenses)
    .set({ tripId: null, tripPinned: false, updatedAt: new Date() })
    .where(eq(expenses.tripId, tripId));
  await tx.delete(trips).where(eq(trips.id, tripId));
  await appendAuditEvent(tx, orgId, {
    actor,
    entityType: 'trip',
    entityId: tripId,
    action: 'trip.deleted',
    payload: {
      name: trip.name,
      startDate: trip.startDate,
      endDate: trip.endDate,
      expenses: onTrip.map((e) => e.id),
    },
  });
  const dates = onTrip.flatMap((e) => (e.transactionDate ? [e.transactionDate] : []));
  if (dates.length === 0) return { status: 'deleted', refiled: 0 };
  const lo = dates.reduce((a, b) => (a < b ? a : b));
  const hi = dates.reduce((a, b) => (a > b ? a : b));
  const windows = await tripsOverlapping(tx, trip.memberId, lo, hi);
  const refiled = await fileByDate(
    tx,
    orgId,
    onTrip.map((e) => ({ ...e, tripId: null, tripPinned: false })),
    windows,
    actor,
  );
  return { status: 'deleted', refiled };
}

/** Where a person puts an expense: on a trip, on no trip, or back to filing by date. */
export type TripChoice = { readonly tripId: string | null } | { readonly byDate: true };

export type SetExpenseTripResult =
  | { readonly status: 'set'; readonly tripId: string | null; readonly pinned: boolean }
  | { readonly status: 'unchanged' }
  | { readonly status: 'missing' }
  /** Submitted or later: it stays with its report. */
  | { readonly status: 'not_movable'; readonly current: ExpenseStatus }
  | { readonly status: 'no_such_trip' }
  /** The trip is another member's. */
  | { readonly status: 'other_member' };

/**
 * A person puts an expense on a trip, or on none, and filing by date leaves it there from then
 * on (ADR-0023); or hands it back to filing by date. Call inside withOrg().
 */
export async function setExpenseTrip(
  tx: Transaction,
  orgId: string,
  expenseId: string,
  choice: TripChoice,
  actorUserId: string,
): Promise<SetExpenseTripResult> {
  await lockOrgWrites(tx, orgId);
  const [expense] = await tx
    .select({ ...fileableColumns, memberId: expenses.memberId })
    .from(expenses)
    .where(eq(expenses.id, expenseId))
    .for('update');
  if (!expense) return { status: 'missing' };
  if (!isTripMovable(expense.status)) return { status: 'not_movable', current: expense.status };

  let tripId: string | null;
  let pinned: boolean;
  if ('byDate' in choice) {
    const date = expense.transactionDate;
    const windows = date ? await tripsOverlapping(tx, expense.memberId, date, date) : [];
    tripId = tripFor(date, windows)?.id ?? null;
    pinned = false;
  } else {
    if (choice.tripId !== null) {
      const [trip] = await tx
        .select({ memberId: trips.memberId })
        .from(trips)
        .where(eq(trips.id, choice.tripId));
      if (!trip) return { status: 'no_such_trip' };
      if (trip.memberId !== expense.memberId) return { status: 'other_member' };
    }
    tripId = choice.tripId;
    pinned = true;
  }
  if (tripId === expense.tripId && pinned === expense.tripPinned) return { status: 'unchanged' };

  const touched =
    tripId === expense.tripId
      ? []
      : [...(await reportsOfExpenses(tx, [expenseId])), ...(await reportsOfTrips(tx, [tripId]))];
  await tx
    .update(expenses)
    .set({
      tripId,
      tripPinned: pinned,
      ...(tripId === expense.tripId ? {} : { reportId: null }),
      updatedAt: new Date(),
    })
    .where(eq(expenses.id, expenseId));
  await reopenChangedReports(
    tx,
    orgId,
    touched,
    { type: 'user', id: actorUserId },
    'an expense moved trips',
  );
  await appendAuditEvent(tx, orgId, {
    actor: { type: 'user', id: actorUserId },
    entityType: 'expense',
    entityId: expenseId,
    action: 'expense.trip_set',
    payload: { tripId, previous: expense.tripId, byDate: !pinned },
  });
  return { status: 'set', tripId, pinned };
}
