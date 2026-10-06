import {
  lineClaims,
  plainMiles,
  type ExportExclusion,
  type ExportExpense,
  type ExportPart,
  type ReportStatus,
} from '@expensewise/domain';
import { and, eq, not, or, sql } from 'drizzle-orm';
import type { Transaction } from './client.ts';
import { heldAsDuplicate } from './duplicates.ts';
import { itemizationsOf, partsOf } from './itemized.ts';
import { shownCategoryName, shownTypeName } from './submitted-names.ts';
import {
  categories,
  expenses,
  expenseTypes,
  members,
  mileageLogs,
  mileageRoutes,
  organizations,
  reports,
  trips,
} from './schema.ts';

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
      id: expenses.id,
      date: expenses.transactionDate,
      merchant: expenses.merchant,
      // As submitted, once its report is (NFR-DAT-04, #70).
      category: shownCategoryName,
      type: shownTypeName,
      trip: trips.name,
      tripPurpose: trips.purpose,
      justification: expenses.justification,
      note: expenses.notes,
      amountMinor: expenses.amountMinor,
      currency: expenses.currency,
      method: mileageLogs.method,
      claimedMiles: mileageLogs.distance,
      measuredMiles: mileageRoutes.measuredMiles,
      milesReason: mileageRoutes.milesReason,
      journeyFrom: expenses.journeyFrom,
      journeyTo: expenses.journeyTo,
      checkIn: expenses.checkIn,
      checkOut: expenses.checkOut,
      companyPaid: expenses.companyPaid,
    })
    .from(expenses)
    .leftJoin(trips, and(eq(trips.orgId, expenses.orgId), eq(trips.id, expenses.tripId)))
    .leftJoin(
      categories,
      and(eq(categories.orgId, expenses.orgId), eq(categories.id, expenses.categoryId)),
    )
    .leftJoin(
      expenseTypes,
      and(eq(expenseTypes.orgId, expenses.orgId), eq(expenseTypes.id, expenses.typeId)),
    )
    .leftJoin(
      mileageLogs,
      and(eq(mileageLogs.orgId, expenses.orgId), eq(mileageLogs.expenseId, expenses.id)),
    )
    .leftJoin(
      mileageRoutes,
      and(eq(mileageRoutes.orgId, expenses.orgId), eq(mileageRoutes.expenseId, expenses.id)),
    )
    .where(
      and(
        or(eq(expenses.reportId, reportId), eq(trips.reportId, reportId)),
        not(heldAsDuplicate(expenses.id)),
      ),
    )
    .orderBy(sql`${expenses.transactionDate} asc nulls last`, expenses.createdAt, expenses.id);
  const ids = rows.map((r) => r.id);
  const parts = await partsOf(tx, ids);
  const lines = await itemizationsOf(tx, ids);
  return {
    report,
    expenses: rows.map((r) => {
      const split: ExportPart[] = parts
        .filter((p) => p.expenseId === r.id)
        .map((p) => ({
          // A part of the lines left with the expense's own is under its category and type.
          category: p.categoryId === null ? r.category : p.category,
          type: p.typeId === null ? r.type : p.type,
          amountMinor: p.amountMinor,
        }));
      const excluded = excludedLines(lines.find((l) => l.expenseId === r.id));
      return {
        date: r.date,
        merchant: r.merchant,
        category: r.category,
        type: r.type,
        trip: r.trip,
        purpose: r.trip === null ? r.justification : r.tripPurpose,
        note: r.note,
        amountMinor: r.amountMinor,
        currency: r.currency,
        // A drive's miles: measured on its route, if it was, and claimed, with why they differ.
        ...(r.method === null || r.claimedMiles === null
          ? {}
          : {
              miles: {
                measured: r.measuredMiles === null ? null : plainMiles(r.measuredMiles),
                claimed: plainMiles(r.claimedMiles),
                reason: r.milesReason,
              },
            }),
        ...(split.length > 0 ? { parts: split } : {}),
        ...(excluded.length > 0 ? { excluded } : {}),
        // Where a journey went and a stay's dates, once the expense has either (FR-INT-20/21).
        ...(r.journeyFrom === null &&
        r.journeyTo === null &&
        r.checkIn === null &&
        r.checkOut === null
          ? {}
          : {
              travel: {
                journeyFrom: r.journeyFrom,
                journeyTo: r.journeyTo,
                checkIn: r.checkIn,
                checkOut: r.checkOut,
              },
            }),
        // Paid by the company directly (FR-EXP-17): listed apart from the claim while it is on.
        ...(r.companyPaid ? { paidBy: 'company' as const } : {}),
      };
    }),
  };
}

/** An expense's excluded lines, each with what it and its share of tax, tip and fees took off. */
function excludedLines(lines: Awaited<ReturnType<typeof itemizationsOf>>[number] | undefined) {
  if (!lines) return [];
  const claims = lineClaims(lines) ?? [];
  return lines.lines.flatMap((l): ExportExclusion[] =>
    l.excluded
      ? [
          {
            line: l.description,
            amountMinor:
              claims.find((c) => c.position === l.position)?.claimed.amountMinor ??
              l.amount.amountMinor,
            reason: l.excluded.reason,
            note: l.excluded.note,
          },
        ]
      : [],
  );
}
