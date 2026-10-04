import { reopenedClosesAt } from '@expensewise/domain';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { appendAuditEvent, type AuditEntry } from './audit.ts';
import type { Transaction } from './client.ts';
import { expenses, reports, trips } from './schema.ts';

/** The reports these expenses are on: a trip's report, or a local expense's own. */
export async function reportsOfExpenses(
  tx: Transaction,
  expenseIds: readonly string[],
): Promise<string[]> {
  if (expenseIds.length === 0) return [];
  const rows = await tx
    .select({ own: expenses.reportId, viaTrip: trips.reportId })
    .from(expenses)
    .leftJoin(trips, and(eq(trips.orgId, expenses.orgId), eq(trips.id, expenses.tripId)))
    .where(inArray(expenses.id, [...expenseIds]));
  return [...new Set(rows.flatMap((r) => [r.own, r.viaTrip].filter((id) => id !== null)))];
}

/** The reports these trips are on. */
export async function reportsOfTrips(
  tx: Transaction,
  tripIds: readonly (string | null)[],
): Promise<string[]> {
  const ids = tripIds.filter((id) => id !== null);
  if (ids.length === 0) return [];
  const rows = await tx
    .select({ reportId: trips.reportId })
    .from(trips)
    .where(and(inArray(trips.id, ids), isNotNull(trips.reportId)));
  return [...new Set(rows.map((r) => r.reportId).filter((id) => id !== null))];
}

/**
 * Reopens each of these reports that is closed, because something in it changed (ADR-0029):
 * a closed report had nothing left to review, and a change may undo that. It keeps its day
 * 28, or gets a week if that is sooner. A submitted report is never touched here. Call
 * inside withOrg(), in the transaction that made the change.
 */
export async function reopenChangedReports(
  tx: Transaction,
  orgId: string,
  reportIds: readonly string[],
  actor: AuditEntry['actor'],
  reason: string,
  now = new Date(),
): Promise<string[]> {
  if (reportIds.length === 0) return [];
  const closed = await tx
    .select({ id: reports.id, closesAt: reports.closesAt })
    .from(reports)
    .where(and(inArray(reports.id, [...reportIds]), eq(reports.status, 'closed')))
    .orderBy(reports.id)
    .for('update');
  for (const report of closed) {
    const closesAt = reopenedClosesAt(report.closesAt, now);
    await tx
      .update(reports)
      .set({ status: 'open', closedAt: null, closesAt, updatedAt: now })
      .where(eq(reports.id, report.id));
    await appendAuditEvent(tx, orgId, {
      actor,
      entityType: 'report',
      entityId: report.id,
      action: 'report.reopened',
      payload: { reason, closesAt: closesAt.toISOString() },
    });
  }
  return closed.map((r) => r.id);
}
