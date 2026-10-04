import type { ExportExpense, ReportStatus } from '@expensewise/domain';
import { and, eq, not, or, sql } from 'drizzle-orm';
import type { Transaction } from './client.ts';
import { heldAsDuplicate } from './duplicates.ts';
import { categories, expenses, members, organizations, reports, trips } from './schema.ts';

/** A report as its export’s heading names it (FR-SET-01). */
export interface ExportReportHeading {
  readonly id: string;
  readonly memberId: string;
  /** The person whose report it is. */
  readonly owner: string;
  readonly organization: string;
  readonly title: string;
  readonly status: ReportStatus;
  readonly openedAt: Date;
  readonly closedAt: Date | null;
}

/** A report with every expense on it, as its CSV and PDF list them. */
export interface ReportForExport {
  readonly report: ExportReportHeading;
  readonly expenses: readonly ExportExpense[];
}

/**
 * A report and every expense on it, through its trips and as local expenses, in date order,
 * undated last. A possible duplicate is left out, as it is from the report’s totals; a closed
 * report holds none, since one needs review and so reopens it. Call inside withOrg().
 */
export async function reportForExport(
  tx: Transaction,
  reportId: string,
): Promise<ReportForExport | undefined> {
  const [report] = await tx
    .select({
      id: reports.id,
      memberId: reports.memberId,
      owner: members.displayName,
      organization: organizations.name,
      title: reports.title,
      status: reports.status,
      openedAt: reports.createdAt,
      closedAt: reports.closedAt,
    })
    .from(reports)
    .innerJoin(members, and(eq(members.orgId, reports.orgId), eq(members.id, reports.memberId)))
    .innerJoin(organizations, eq(organizations.id, reports.orgId))
    .where(eq(reports.id, reportId));
  if (!report) return undefined;
  const rows = await tx
    .select({
      date: expenses.transactionDate,
      merchant: expenses.merchant,
      category: categories.name,
      trip: trips.name,
      tripPurpose: trips.purpose,
      justification: expenses.justification,
      note: expenses.notes,
      amountMinor: expenses.amountMinor,
      currency: expenses.currency,
    })
    .from(expenses)
    .leftJoin(trips, and(eq(trips.orgId, expenses.orgId), eq(trips.id, expenses.tripId)))
    .leftJoin(
      categories,
      and(eq(categories.orgId, expenses.orgId), eq(categories.id, expenses.categoryId)),
    )
    .where(
      and(
        or(eq(expenses.reportId, reportId), eq(trips.reportId, reportId)),
        not(heldAsDuplicate(expenses.id)),
      ),
    )
    .orderBy(sql`${expenses.transactionDate} asc nulls last`, expenses.createdAt, expenses.id);
  return {
    report,
    expenses: rows.map((r) => ({
      date: r.date,
      merchant: r.merchant,
      category: r.category,
      // Types arrive with the organization's own categories and types (#51).
      type: null,
      trip: r.trip,
      purpose: r.trip === null ? r.justification : r.tripPurpose,
      note: r.note,
      amountMinor: r.amountMinor,
      currency: r.currency,
    })),
  };
}
