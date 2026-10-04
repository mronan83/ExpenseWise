import type { ConversionRecord } from '@expensewise/domain';
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import type { Transaction } from './client.ts';
import { conversionRecord, onItsReport, recordColumns, tripOf } from './conversions.ts';
import { heldAsDuplicate } from './duplicates.ts';
import type { ReportContents } from './reports.ts';
import { expenseConversions, expenses, reports } from './schema.ts';

/** An amount on a report, with its conversion to the report's currency, if one is recorded. */
export interface ReportAmount {
  readonly reportId: string;
  readonly expenseId: string;
  /** Its trip; null for a local expense. */
  readonly tripId: string | null;
  readonly amountMinor: number;
  readonly currency: string;
  readonly purchaseDate: string;
  /** Held as a possible duplicate: it counts in no total until the person decides. */
  readonly held: boolean;
  readonly conversion: ConversionRecord | null;
}

/**
 * Every amount on these reports, through a trip or as a local expense, with its amount,
 * currency and date known, and the conversion recorded for it (FR-EXP-13). Call inside
 * withOrg().
 */
export async function listReportAmounts(
  tx: Transaction,
  reportIds: readonly string[],
): Promise<ReportAmount[]> {
  if (reportIds.length === 0) return [];
  const rows = await tx
    .select({
      reportId: reports.id,
      expenseId: expenses.id,
      tripId: expenses.tripId,
      amount: expenses.amountMinor,
      expenseCurrency: expenses.currency,
      date: expenses.transactionDate,
      held: sql<boolean>`${heldAsDuplicate(expenses.id)}`,
      ...recordColumns,
    })
    .from(expenses)
    .leftJoin(tripOf, and(eq(tripOf.orgId, expenses.orgId), eq(tripOf.id, expenses.tripId)))
    .innerJoin(reports, onItsReport())
    .leftJoin(
      expenseConversions,
      and(
        eq(expenseConversions.orgId, expenses.orgId),
        eq(expenseConversions.expenseId, expenses.id),
      ),
    )
    .where(
      and(
        inArray(reports.id, [...reportIds]),
        isNotNull(expenses.amountMinor),
        isNotNull(expenses.currency),
        isNotNull(expenses.transactionDate),
      ),
    )
    .orderBy(expenses.transactionDate, expenses.id);
  return rows.map((r) => ({
    reportId: r.reportId,
    expenseId: r.expenseId,
    tripId: r.tripId,
    amountMinor: r.amount!,
    currency: r.expenseCurrency!,
    purchaseDate: r.date!,
    held: r.held,
    conversion: conversionRecord(r),
  }));
}

/** These reports, each with its amounts and their conversions. Call inside withOrg(). */
export async function withReportAmounts(
  tx: Transaction,
  contents: readonly ReportContents[],
): Promise<ReportContents[]> {
  const amounts = await listReportAmounts(
    tx,
    contents.map((c) => c.report.id),
  );
  return contents.map((c) => ({
    ...c,
    amounts: amounts.filter((a) => a.reportId === c.report.id),
  }));
}
