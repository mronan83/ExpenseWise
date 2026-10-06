import {
  cleanJustification,
  lastDayToJoin,
  localExpenseReady,
  planAutoClose,
  reopenedClosesAt,
  reportClosesAt,
  transitionReport,
  type ReportItemState,
  type ReportStatus,
} from '@expensewise/domain';
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  sql,
  type SQL,
} from 'drizzle-orm';
import { appendAuditEvent, lockOrgWrites, type AuditEntry } from './audit.ts';
import { withOrg, type Database, type Transaction } from './client.ts';
import {
  listCompanyPaid,
  tallyPayers,
  type CompanyPaidRecord,
  type PayerTally,
} from './company-paid.ts';
import { featureOn } from './features.ts';
import { CONVERSION_FLAG, getReimbursementCurrency, requestConversions } from './conversions.ts';
import { listReportExpenses, type ReportExpenseRecord } from './expenses.ts';
import { organizationTimeZone } from './organizations.ts';
import type { ReportAmount } from './report-amounts.ts';
import { reopenChangedReports, reportsOfExpenses } from './report-touch.ts';
import {
  approvalSteps,
  expenses,
  members,
  mileageLogs,
  organizations,
  reports,
  trips,
} from './schema.ts';
import { tallyTrips, tripsWithOwner, type TripRecord, type TripTally } from './trips.ts';

const SCHEDULE: AuditEntry['actor'] = { type: 'system', id: 'report-schedule' };

export interface ReportRecord {
  readonly id: string;
  readonly memberId: string;
  readonly owner: string;
  readonly title: string;
  readonly status: ReportStatus;
  /**
   * The currency it is reimbursed in: its member's reimbursement currency, which it follows
   * until it is submitted while conversion is on (FR-EXP-13); otherwise the organization's.
   */
  readonly currency: string;
  readonly closesAt: Date;
  readonly closedAt: Date | null;
  readonly submittedAt: Date | null;
  readonly createdAt: Date;
}

const reportColumns = {
  id: reports.id,
  memberId: reports.memberId,
  owner: members.displayName,
  title: reports.title,
  status: reports.status,
  currency: reports.currency,
  closesAt: reports.closesAt,
  closedAt: reports.closedAt,
  submittedAt: reports.submittedAt,
  createdAt: reports.createdAt,
};

const reportsWithOwner = (tx: Transaction) =>
  tx
    .select(reportColumns)
    .from(reports)
    .innerJoin(members, and(eq(members.orgId, reports.orgId), eq(members.id, reports.memberId)));

/** How many expenses a trip has, and how many of them hold its report open. */
export interface TripCount {
  readonly tripId: string;
  readonly total: number;
  /** Being read or needing review, possible duplicates included. */
  readonly unsettled: number;
}

/** A report with everything on it (FR-EXP-05, FR-EXP-14). */
export interface ReportContents {
  readonly report: ReportRecord;
  readonly trips: readonly TripRecord[];
  /** What is on each trip, by currency and status; possible duplicates are left out. */
  readonly tallies: readonly TripTally[];
  readonly counts: readonly TripCount[];
  readonly locals: readonly ReportExpenseRecord[];
  /** Every amount on it with its conversion, where asked for (withReportAmounts()). */
  readonly amounts?: readonly ReportAmount[];
  /**
   * What is on it by who paid, and each expense the company paid (FR-EXP-17), read from the
   * database; shown only while Paid by the company is on. A report made elsewhere, such as a
   * test's, may leave them out.
   */
  readonly payers?: readonly PayerTally[];
  readonly companyPaid?: readonly CompanyPaidRecord[];
}

/**
 * What can close: each trip with expenses on it, and each local expense, and whether it is
 * ready. A trip whose expenses all moved away is no longer part of what closes.
 */
export function reportItems(contents: ReportContents): ReportItemState[] {
  const count = new Map(contents.counts.map((c) => [c.tripId, c]));
  return [
    ...contents.trips.flatMap((t) => {
      const c = count.get(t.id);
      return c && c.total > 0 ? [{ id: t.id, ready: c.unsettled === 0 }] : [];
    }),
    ...contents.locals.map((e) => ({
      id: e.id,
      ready: localExpenseReady(e.status, e.justification),
    })),
  ];
}

/** These reports with everything on them, in the order asked. Call inside withOrg(). */
export async function loadReports(
  tx: Transaction,
  reportIds: readonly string[],
): Promise<ReportContents[]> {
  if (reportIds.length === 0) return [];
  const ids = [...reportIds];
  const found = await reportsWithOwner(tx).where(inArray(reports.id, ids));
  const onReports = await tripsWithOwner(tx)
    .where(inArray(trips.reportId, ids))
    .orderBy(asc(trips.startDate), asc(trips.id));
  const tripIds = onReports.map((t) => t.id);
  const tallies = await tallyTrips(tx, tripIds);
  const counts =
    tripIds.length === 0
      ? []
      : await tx
          .select({
            tripId: sql<string>`${expenses.tripId}`.mapWith(String),
            total: sql<number>`count(*)::int`,
            unsettled: sql<number>`(count(*) filter (where ${expenses.status} in ('processing', 'needs_review')))::int`,
          })
          .from(expenses)
          .where(inArray(expenses.tripId, tripIds))
          .groupBy(expenses.tripId);
  const locals = await listReportExpenses(tx, ids);
  const payers = await tallyPayers(tx, { reportIds: ids });
  const companyPaid = await listCompanyPaid(tx, ids);
  const byId = new Map(found.map((r) => [r.id, r]));
  return ids.flatMap((id) => {
    const report = byId.get(id);
    if (!report) return [];
    const mine = onReports.filter((t) => t.reportId === id);
    const mineIds = new Set(mine.map((t) => t.id));
    return [
      {
        report,
        trips: mine,
        tallies: tallies.filter((t) => mineIds.has(t.tripId)),
        counts: counts.filter((c) => mineIds.has(c.tripId)),
        locals: locals.filter((e) => e.reportId === id),
        payers: payers.filter((p) => p.reportId === id),
        companyPaid: companyPaid.filter((e) => e.onReportId === id),
      },
    ];
  });
}

/** Which reports to list: a member's, and in which states. */
export interface ReportFilter {
  readonly memberId?: string;
  readonly statuses?: readonly ReportStatus[];
}

/** Reports newest first, with everything on them. Call inside withOrg(). */
export async function listReports(
  tx: Transaction,
  limit: number,
  filter: ReportFilter = {},
): Promise<ReportContents[]> {
  const where: SQL[] = [];
  if (filter.memberId) where.push(eq(reports.memberId, filter.memberId));
  if (filter.statuses) where.push(inArray(reports.status, [...filter.statuses]));
  const rows = await tx
    .select({ id: reports.id })
    .from(reports)
    .where(and(...where))
    .orderBy(desc(reports.createdAt), desc(reports.id))
    .limit(limit);
  return loadReports(
    tx,
    rows.map((r) => r.id),
  );
}

/** One report with everything on it, or undefined. Call inside withOrg(). */
export async function getReport(
  tx: Transaction,
  reportId: string,
): Promise<ReportContents | undefined> {
  const [contents] = await loadReports(tx, [reportId]);
  return contents;
}

/**
 * "Report from 3 Oct 2026": a name until a person gives it one. The date is the organization's
 * own when it keeps a time zone (ADR-0037), and UTC's otherwise.
 */
const titleFor = (day: Date, timeZone: string | null) =>
  `Report from ${day.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: timeZone ?? 'UTC' })}`;

/**
 * Opens a report for a member, closing itself in 28 days, with its audit event. Its currency is
 * the organization's home currency as it is now, and stays so if that changes later.
 */
async function openReport(
  tx: Transaction,
  orgId: string,
  memberId: string,
  now: Date,
  actor: AuditEntry['actor'],
  reason: string,
): Promise<string> {
  const [org] = await tx
    .select({ currency: organizations.homeCurrency })
    .from(organizations)
    .where(eq(organizations.id, orgId));
  if (!org) throw new Error('The organization is not visible');
  const timeZone = await organizationTimeZone(tx, orgId);
  // While conversion is on, it opens in its member's reimbursement currency (FR-EXP-13).
  const currency = (await featureOn(tx, orgId, CONVERSION_FLAG))
    ? ((await getReimbursementCurrency(tx, memberId))?.currency ?? org.currency)
    : org.currency;
  const closesAt = reportClosesAt(now, timeZone);
  const [report] = await tx
    .insert(reports)
    .values({
      orgId,
      memberId,
      title: titleFor(now, timeZone),
      currency,
      closesAt,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: reports.id });
  if (!report) throw new Error('The new report is not visible');
  await appendAuditEvent(tx, orgId, {
    actor,
    entityType: 'report',
    entityId: report.id,
    action: 'report.opened',
    payload: { memberId, closesAt: closesAt.toISOString(), reason },
  });
  return report.id;
}

/** The member's newest open report other than `except`, opening one if there is none. */
async function openReportOf(
  tx: Transaction,
  orgId: string,
  memberId: string,
  now: Date,
  actor: AuditEntry['actor'],
  reason: string,
  except?: string,
): Promise<{ id: string; opened: boolean }> {
  const [open] = await tx
    .select({ id: reports.id })
    .from(reports)
    .where(
      and(
        eq(reports.memberId, memberId),
        eq(reports.status, 'open'),
        except ? ne(reports.id, except) : undefined,
      ),
    )
    .orderBy(desc(reports.createdAt), desc(reports.id))
    .limit(1);
  if (open) return { id: open.id, opened: false };
  return { id: await openReport(tx, orgId, memberId, now, actor, reason), opened: true };
}

async function addTrip(
  tx: Transaction,
  orgId: string,
  tripId: string,
  reportId: string,
  actor: AuditEntry['actor'],
  reason: string,
) {
  await tx.update(trips).set({ reportId }).where(eq(trips.id, tripId));
  await appendAuditEvent(tx, orgId, {
    actor,
    entityType: 'report',
    entityId: reportId,
    action: 'report.trip_added',
    payload: { tripId, reason },
  });
}

async function addLocalExpense(
  tx: Transaction,
  orgId: string,
  expenseId: string,
  reportId: string,
  actor: AuditEntry['actor'],
  reason: string,
) {
  await tx
    .update(expenses)
    .set({ reportId, updatedAt: new Date() })
    .where(eq(expenses.id, expenseId));
  await appendAuditEvent(tx, orgId, {
    actor,
    entityType: 'report',
    entityId: reportId,
    action: 'report.expense_added',
    payload: { expenseId, reason },
  });
}

/**
 * Puts on a report each trip and local expense whose time has come (FR-EXP-05, FR-EXP-14): a
 * trip with expenses on it 24 hours after its return date ends, a local expense 24 hours after
 * its own date ends, counted in the organization's time zone when it keeps one and at UTC−12
 * otherwise (lastDayToJoin(), ADR-0037). Each goes to its member's newest open report, or one
 * opens for it. Call inside withOrg(). Returns how many joined.
 */
export async function joinDueItems(
  tx: Transaction,
  orgId: string,
  now: Date,
  actor: AuditEntry['actor'] = SCHEDULE,
): Promise<{ trips: number; expenses: number; opened: number }> {
  await lockOrgWrites(tx, orgId);
  const timeZone = await organizationTimeZone(tx, orgId);
  const lastDay = lastDayToJoin(now, timeZone ?? undefined);
  const dueTrips = await tx
    .select({ id: trips.id, memberId: trips.memberId })
    .from(trips)
    .where(
      and(
        isNull(trips.reportId),
        lte(trips.endDate, lastDay),
        sql`exists (select 1 from ${expenses} e where e.org_id = ${trips.orgId} and e.trip_id = ${trips.id}
                     and e.status in ('processing', 'needs_review', 'ready'))`,
      ),
    )
    .orderBy(asc(trips.endDate), asc(trips.id))
    .for('update');
  const dueLocals = await tx
    .select({ id: expenses.id, memberId: expenses.memberId })
    .from(expenses)
    .where(
      and(
        isNull(expenses.tripId),
        isNull(expenses.reportId),
        isNotNull(expenses.transactionDate),
        inArray(expenses.status, ['needs_review', 'ready']),
        lte(expenses.transactionDate, lastDay),
      ),
    )
    .orderBy(asc(expenses.transactionDate), asc(expenses.id))
    .for('update');
  const target = new Map<string, string>();
  let opened = 0;
  const reportFor = async (memberId: string) => {
    const known = target.get(memberId);
    if (known) return known;
    const report = await openReportOf(tx, orgId, memberId, now, actor, 'a trip or expense was due');
    if (report.opened) opened++;
    target.set(memberId, report.id);
    return report.id;
  };
  for (const trip of dueTrips) {
    await addTrip(tx, orgId, trip.id, await reportFor(trip.memberId), actor, 'completed');
  }
  for (const expense of dueLocals) {
    const reportId = await reportFor(expense.memberId);
    await addLocalExpense(tx, orgId, expense.id, reportId, actor, 'local');
  }
  return { trips: dueTrips.length, expenses: dueLocals.length, opened };
}

/** Moves what is listed from one report to `to`, recording each move. */
async function moveItems(
  tx: Transaction,
  orgId: string,
  contents: ReportContents,
  ids: readonly string[],
  to: string,
  actor: AuditEntry['actor'],
  reason: string,
) {
  const tripIds = new Set(contents.trips.map((t) => t.id));
  for (const id of ids) {
    if (tripIds.has(id)) await tx.update(trips).set({ reportId: to }).where(eq(trips.id, id));
    else {
      await tx
        .update(expenses)
        .set({ reportId: to, updatedAt: new Date() })
        .where(eq(expenses.id, id));
    }
    await appendAuditEvent(tx, orgId, {
      actor,
      entityType: 'report',
      entityId: contents.report.id,
      action: 'report.item_moved',
      payload: { [tripIds.has(id) ? 'tripId' : 'expenseId']: id, to, reason },
    });
  }
}

/** Whether a report has been through approval (#24): then it is kept, as its history. */
export async function hasApprovalHistory(tx: Transaction, reportId: string): Promise<boolean> {
  const [step] = await tx
    .select({ id: approvalSteps.id })
    .from(approvalSteps)
    .where(eq(approvalSteps.reportId, reportId))
    .limit(1);
  return step !== undefined;
}

/**
 * Deletes an open report with nothing to claim on it, with its audit event. A trip left on it
 * with no expenses comes off, and joins again once something is on it. A report that has been
 * through approval stays, empty, since its steps and rejections are its history. Returns
 * whether it was dropped.
 */
async function dropReport(
  tx: Transaction,
  orgId: string,
  reportId: string,
  actor: AuditEntry['actor'],
): Promise<boolean> {
  if (await hasApprovalHistory(tx, reportId)) return false;
  await tx.update(trips).set({ reportId: null }).where(eq(trips.reportId, reportId));
  await tx.delete(reports).where(and(eq(reports.id, reportId), eq(reports.status, 'open')));
  await appendAuditEvent(tx, orgId, {
    actor,
    entityType: 'report',
    entityId: reportId,
    action: 'report.dropped',
    payload: { reason: 'nothing on it' },
  });
  return true;
}

/** Whether a report has nothing to claim: no trip with expenses, and no local expense. */
const holdsNothing = (c: ReportContents) => reportItems(c).length === 0;

/**
 * Day 28 (FR-EXP-12, Q20): each open report past its time closes with what is ready, and
 * whatever still needs review moves to the member's next open report, opened for it if need
 * be. One with nothing ready waits, overdue. An open report holding nothing is dropped,
 * whatever its day. Call inside withOrg().
 */
export async function closeDueReports(
  tx: Transaction,
  orgId: string,
  now: Date,
  actor: AuditEntry['actor'] = SCHEDULE,
): Promise<{ closed: number; moved: number; dropped: number }> {
  await lockOrgWrites(tx, orgId);
  const open = await tx
    .select({ id: reports.id, closesAt: reports.closesAt })
    .from(reports)
    .where(eq(reports.status, 'open'))
    .orderBy(asc(reports.createdAt), asc(reports.id))
    .for('update');
  let closed = 0;
  let moved = 0;
  let dropped = 0;
  for (const row of open) {
    const contents = await getReport(tx, row.id);
    if (!contents) continue;
    if (holdsNothing(contents)) {
      if (await dropReport(tx, orgId, row.id, actor)) dropped++;
      continue;
    }
    if (row.closesAt > now) continue;
    const plan = planAutoClose(reportItems(contents));
    // An empty report was dropped above; nothing ready means it waits, overdue.
    if (plan.action !== 'close') continue;
    if (plan.move.length > 0) {
      const next = await openReportOf(
        tx,
        orgId,
        contents.report.memberId,
        now,
        actor,
        'what still needed review on day 28',
        row.id,
      );
      await moveItems(
        tx,
        orgId,
        contents,
        plan.move,
        next.id,
        actor,
        'still needed review on day 28',
      );
      moved += plan.move.length;
    }
    await tx
      .update(reports)
      .set({ status: 'closed', closedAt: now, updatedAt: now })
      .where(eq(reports.id, row.id));
    await appendAuditEvent(tx, orgId, {
      actor,
      entityType: 'report',
      entityId: row.id,
      action: 'report.closed',
      payload: { by: 'day 28', moved: plan.move },
    });
    closed++;
  }
  return { closed, moved, dropped };
}

export type CloseReportResult =
  | { readonly status: 'closed' }
  | { readonly status: 'missing' }
  | { readonly status: 'not_open'; readonly current: ReportStatus }
  | { readonly status: 'empty' }
  /** These trips and local expenses still need review or a justification. */
  | { readonly status: 'needs_attention'; readonly blocking: readonly string[] };

/** The person closes a report: only one with nothing left to review (FR-EXP-12). */
export async function closeReport(
  tx: Transaction,
  orgId: string,
  reportId: string,
  actorUserId: string,
  now = new Date(),
): Promise<CloseReportResult> {
  await lockOrgWrites(tx, orgId);
  const [row] = await tx
    .select({ status: reports.status })
    .from(reports)
    .where(eq(reports.id, reportId))
    .for('update');
  if (!row) return { status: 'missing' };
  const contents = await getReport(tx, reportId);
  if (!contents) return { status: 'missing' };
  const items = reportItems(contents);
  const blocking = items.filter((i) => !i.ready).map((i) => i.id);
  const next = transitionReport(row.status, {
    type: 'close',
    itemCount: items.length,
    blockers: blocking.length,
  });
  if (!next.ok) {
    if (next.error.code === 'empty_report') return { status: 'empty' };
    if (next.error.code === 'needs_attention') return { status: 'needs_attention', blocking };
    return { status: 'not_open', current: row.status };
  }
  await tx
    .update(reports)
    .set({ status: 'closed', closedAt: now, updatedAt: now })
    .where(eq(reports.id, reportId));
  await appendAuditEvent(tx, orgId, {
    actor: { type: 'user', id: actorUserId },
    entityType: 'report',
    entityId: reportId,
    action: 'report.closed',
    payload: { by: 'person' },
  });
  return { status: 'closed' };
}

export type ReopenReportResult =
  | { readonly status: 'reopened'; readonly closesAt: Date }
  | { readonly status: 'missing' }
  /** Open already, or submitted and locked. */
  | { readonly status: 'not_closed'; readonly current: ReportStatus };

/** The person reopens a closed report, which stays possible until it is submitted. */
export async function reopenReport(
  tx: Transaction,
  orgId: string,
  reportId: string,
  actorUserId: string,
  now = new Date(),
): Promise<ReopenReportResult> {
  await lockOrgWrites(tx, orgId);
  const [row] = await tx
    .select({ status: reports.status, closesAt: reports.closesAt })
    .from(reports)
    .where(eq(reports.id, reportId))
    .for('update');
  if (!row) return { status: 'missing' };
  const next = transitionReport(row.status, { type: 'reopen' });
  if (!next.ok) return { status: 'not_closed', current: row.status };
  const closesAt = reopenedClosesAt(row.closesAt, now);
  await tx
    .update(reports)
    .set({ status: 'open', closedAt: null, closesAt, updatedAt: now })
    .where(eq(reports.id, reportId));
  await appendAuditEvent(tx, orgId, {
    actor: { type: 'user', id: actorUserId },
    entityType: 'report',
    entityId: reportId,
    action: 'report.reopened',
    payload: { reason: 'person', closesAt: closesAt.toISOString() },
  });
  return { status: 'reopened', closesAt };
}

/** Where a person moves a trip or local expense: an open report, or a new one. */
export type ReportChoice = { readonly reportId: string } | { readonly newReport: true };

export type MoveToReportResult =
  | { readonly status: 'moved'; readonly reportId: string; readonly dropped: string | null }
  | { readonly status: 'unchanged' }
  | { readonly status: 'missing' }
  /** Not a local expense: one on a trip goes with its trip. */
  | { readonly status: 'not_local' }
  /** The report it is on, or the one chosen, is closed or submitted: reopen it first. */
  | { readonly status: 'not_open' }
  | { readonly status: 'no_such_report' }
  | { readonly status: 'other_member' };

/**
 * A person moves a trip, or a local expense, to another open report or a new one (FR-EXP-05).
 * A report left holding nothing is dropped. Call inside withOrg().
 */
export async function moveToReport(
  tx: Transaction,
  orgId: string,
  item: { readonly tripId: string } | { readonly expenseId: string },
  choice: ReportChoice,
  actorUserId: string,
  now = new Date(),
): Promise<MoveToReportResult> {
  await lockOrgWrites(tx, orgId);
  const actor = { type: 'user', id: actorUserId } as const;
  let memberId: string;
  let from: string | null;
  if ('tripId' in item) {
    const [trip] = await tx
      .select({ memberId: trips.memberId, reportId: trips.reportId })
      .from(trips)
      .where(eq(trips.id, item.tripId))
      .for('update');
    if (!trip) return { status: 'missing' };
    ({ memberId, reportId: from } = trip);
  } else {
    const [expense] = await tx
      .select({
        memberId: expenses.memberId,
        reportId: expenses.reportId,
        tripId: expenses.tripId,
        status: expenses.status,
        date: expenses.transactionDate,
      })
      .from(expenses)
      .where(eq(expenses.id, item.expenseId))
      .for('update');
    if (!expense) return { status: 'missing' };
    if (expense.tripId !== null || expense.date === null) return { status: 'not_local' };
    if (expense.status !== 'needs_review' && expense.status !== 'ready') {
      return { status: 'not_open' };
    }
    ({ memberId, reportId: from } = expense);
  }
  if (from) {
    const [source] = await tx
      .select({ status: reports.status })
      .from(reports)
      .where(eq(reports.id, from))
      .for('update');
    if (source?.status !== 'open') return { status: 'not_open' };
  }
  let to: string;
  if ('newReport' in choice) {
    to = await openReport(tx, orgId, memberId, now, actor, 'a person moved something to it');
  } else {
    if (choice.reportId === from) return { status: 'unchanged' };
    const [target] = await tx
      .select({ status: reports.status, memberId: reports.memberId })
      .from(reports)
      .where(eq(reports.id, choice.reportId))
      .for('update');
    if (!target) return { status: 'no_such_report' };
    if (target.memberId !== memberId) return { status: 'other_member' };
    if (target.status !== 'open') return { status: 'not_open' };
    to = choice.reportId;
  }
  if ('tripId' in item) {
    await tx.update(trips).set({ reportId: to }).where(eq(trips.id, item.tripId));
  } else {
    await tx
      .update(expenses)
      .set({ reportId: to, updatedAt: now })
      .where(eq(expenses.id, item.expenseId));
  }
  await appendAuditEvent(tx, orgId, {
    actor,
    entityType: 'report',
    entityId: to,
    action: 'report.item_moved',
    payload: { ...item, from, to, reason: 'person' },
  });
  let dropped: string | null = null;
  if (from) {
    const left = await getReport(tx, from);
    if (left && holdsNothing(left) && (await dropReport(tx, orgId, from, actor))) {
      dropped = from;
    }
  }
  return { status: 'moved', reportId: to, dropped };
}

export type JustifyExpenseResult =
  | { readonly status: 'justified'; readonly justification: string | null }
  | { readonly status: 'unchanged' }
  | { readonly status: 'missing' }
  | { readonly status: 'invalid'; readonly message: string }
  /** Not a local expense: a trip says why one on it was spent. */
  | { readonly status: 'not_local' }
  /** Being read, or submitted or later. */
  | { readonly status: 'not_editable' };

/**
 * A person says why a local expense was for business (FR-EXP-14), with its audit event. A
 * closed report it is on reopens. Call inside withOrg().
 */
export async function justifyExpense(
  tx: Transaction,
  orgId: string,
  expenseId: string,
  text: string,
  actorUserId: string,
): Promise<JustifyExpenseResult> {
  const cleaned = cleanJustification(text);
  if ('error' in cleaned) return { status: 'invalid', message: cleaned.error };
  await lockOrgWrites(tx, orgId);
  const [expense] = await tx
    .select({
      tripId: expenses.tripId,
      status: expenses.status,
      source: expenses.source,
      justification: expenses.justification,
    })
    .from(expenses)
    .where(eq(expenses.id, expenseId))
    .for('update');
  if (!expense) return { status: 'missing' };
  if (expense.tripId !== null) return { status: 'not_local' };
  if (expense.status !== 'needs_review' && expense.status !== 'ready') {
    return { status: 'not_editable' };
  }
  if (cleaned.value === expense.justification) return { status: 'unchanged' };
  // A drive's business purpose is its justification: they change together (ADR-0038).
  const mileage = expense.source === 'mileage';
  if (mileage && cleaned.value === null) {
    return { status: 'invalid', message: 'A drive keeps its business purpose: change it instead.' };
  }
  const actor = { type: 'user', id: actorUserId } as const;
  await tx
    .update(expenses)
    .set({ justification: cleaned.value, updatedAt: new Date() })
    .where(eq(expenses.id, expenseId));
  if (mileage && cleaned.value !== null) {
    await tx
      .update(mileageLogs)
      .set({ purpose: cleaned.value })
      .where(eq(mileageLogs.expenseId, expenseId));
  }
  await appendAuditEvent(tx, orgId, {
    actor,
    entityType: 'expense',
    entityId: expenseId,
    action: 'expense.justified',
    payload: { from: expense.justification, to: cleaned.value },
  });
  await reopenChangedReports(
    tx,
    orgId,
    await reportsOfExpenses(tx, [expenseId]),
    actor,
    'a justification changed',
  );
  return { status: 'justified', justification: cleaned.value };
}

/**
 * The organizations with report work due at `now`, asked outside any organization: the
 * database answers with ids and nothing else (report_work_due()).
 */
export async function reportWorkDue(db: Database, now: Date): Promise<string[]> {
  const { rows } = await db.execute<{ org_id: string }>(
    sql`select report_work_due as org_id from report_work_due(${now.toISOString()}::timestamptz)`,
  );
  return rows.map((r) => r.org_id);
}

export interface ReportScheduleResult {
  readonly orgId: string;
  readonly joined: { trips: number; expenses: number; opened: number };
  readonly closed: { closed: number; moved: number; dropped: number };
}

/**
 * The hourly work for one organization, in one transaction as the app: what is due joins
 * reports, then day 28 closes them. Safe to repeat: nothing joins twice and a closed report
 * stays closed.
 */
export function runReportSchedule(
  db: Database,
  orgId: string,
  now: Date,
): Promise<ReportScheduleResult> {
  return withOrg(db, orgId, async (tx) => {
    const result = {
      orgId,
      joined: await joinDueItems(tx, orgId, now),
      closed: await closeDueReports(tx, orgId, now),
    };
    // What joined may be in another currency: have it converted (FR-EXP-13).
    if (result.joined.trips + result.joined.expenses > 0) await requestConversions(tx, orgId, now);
    return result;
  });
}
