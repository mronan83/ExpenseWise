import {
  closeReport,
  getReport,
  justifyExpense,
  listReports,
  listUnjustifiedExpenses,
  moveToReport,
  reopenReport,
  reportForExport,
  type CloseReportResult,
  type Database,
  type ExpenseRecord,
  type JustifyExpenseResult,
  type MoveToReportResult,
  type ReopenReportResult,
  type ReportChoice,
  type ReportContents,
  type ReportForExport,
  type Transaction,
  withReportAmounts,
} from '@expensewise/db';
import { asCaller } from './caller.ts';

/** What Needs you shows of reports: a member's open and closed ones, and unjustified expenses. */
export interface ReportsNeedingYou {
  readonly reports: ReportContents[];
  readonly unjustified: ExpenseRecord[];
}

/** What the API needs from the database for reports (FR-EXP-05). Tests use an in-memory fake. */
export interface ReportStore {
  /** A member's reports, newest first. */
  list(orgId: string, memberId: string, limit: number): Promise<ReportContents[]>;
  get(orgId: string, reportId: string): Promise<ReportContents | undefined>;
  /** What of a member's reports and local expenses may need them. */
  needsYou(orgId: string, memberId: string, limit: number): Promise<ReportsNeedingYou>;
  close(orgId: string, reportId: string, actorUserId: string): Promise<CloseReportResult>;
  reopen(orgId: string, reportId: string, actorUserId: string): Promise<ReopenReportResult>;
  move(
    orgId: string,
    item: { readonly tripId: string } | { readonly expenseId: string },
    choice: ReportChoice,
    actorUserId: string,
  ): Promise<MoveToReportResult>;
  justify(
    orgId: string,
    expenseId: string,
    text: string,
    actorUserId: string,
  ): Promise<JustifyExpenseResult>;
  /** A report with every expense on it, for its CSV and PDF (FR-SET-01). */
  forExport(orgId: string, reportId: string): Promise<ReportForExport | undefined>;
}

/** A member's open and closed reports, and their unjustified local expenses. */
export async function reportsNeedingYou(
  tx: Transaction,
  memberId: string,
  limit: number,
): Promise<ReportsNeedingYou> {
  const reports = await listReports(tx, limit, { memberId, statuses: ['open', 'closed'] });
  return {
    // With each amount's conversion, shown while it is on (FR-EXP-13).
    reports: await withReportAmounts(tx, reports),
    unjustified: await listUnjustifiedExpenses(tx, memberId, limit),
  };
}

/**
 * The report store on Postgres, as expensewise_app, for the request's caller: they see and
 * change only what their role allows (ADR-0035). It checks the role once.
 */
export function dbReportStore(db: Database): ReportStore {
  const inOrg = asCaller(db);
  return {
    // Reports and their pages carry each amount's conversion, shown while it is on (FR-EXP-13).
    list: (orgId, memberId, limit) =>
      inOrg(orgId, async (tx) => withReportAmounts(tx, await listReports(tx, limit, { memberId }))),
    get: (orgId, reportId) =>
      inOrg(orgId, async (tx) => {
        const found = await getReport(tx, reportId);
        return found && (await withReportAmounts(tx, [found]))[0];
      }),
    needsYou: (orgId, memberId, limit) =>
      inOrg(orgId, (tx) => reportsNeedingYou(tx, memberId, limit)),
    close: (orgId, reportId, actor) =>
      inOrg(orgId, (tx) => closeReport(tx, orgId, reportId, actor)),
    reopen: (orgId, reportId, actor) =>
      inOrg(orgId, (tx) => reopenReport(tx, orgId, reportId, actor)),
    move: (orgId, item, choice, actor) =>
      inOrg(orgId, (tx) => moveToReport(tx, orgId, item, choice, actor)),
    justify: (orgId, expenseId, text, actor) =>
      inOrg(orgId, (tx) => justifyExpense(tx, orgId, expenseId, text, actor)),
    forExport: (orgId, reportId) => inOrg(orgId, (tx) => reportForExport(tx, reportId)),
  };
}
