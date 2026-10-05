import { ROUTE_MILEAGE_FLAG, type ReportForExport } from '@expensewise/db';
import {
  canExportReport,
  isExportableOnceApproved,
  isReportExportable,
  reportCsv,
  reportExportTable,
  type ReportStatus,
} from '@expensewise/domain';
import type { OpenAPIHono } from '@hono/zod-openapi';
import { requireIdentity, type AuthVariables, type TokenVerifier } from './auth.ts';
import { featureGate, type FeatureGate } from './features.ts';
import { ProblemError } from './problem.ts';
import { reportPdf } from './report-pdf.ts';
import type { ReportStore } from './reports.ts';
import { exportReportCsvRoute, exportReportPdfRoute } from './routes/report-export.ts';
import type { WorkspaceStore } from './workspace.ts';

export interface ReportExportRouteOptions {
  readonly verifyToken?: TokenVerifier;
  readonly workspace?: WorkspaceStore;
  readonly reports?: ReportStore;
  /** Which features are on. Built from `workspace` when not given. */
  readonly features?: FeatureGate;
  readonly now?: () => Date;
}

/** A report’s state as its PDF names it. */
const STATUS: Record<ReportStatus, string> = {
  open: 'Open',
  closed: 'Closed',
  submitted: 'Submitted',
  in_approval: 'With the approver',
  approved: 'Approved',
  settled: 'Paid',
};

/** "expense-report-riley-2026-10-03.csv": the person, in plain letters, and the day it opened. */
export function exportFileName(found: ReportForExport, extension: 'csv' | 'pdf'): string {
  const person = found.report.owner
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 40)
    .replace(/^-+|-+$/g, '');
  const day = found.report.openedAt.toISOString().slice(0, 10);
  return `${['expense-report', person, day].filter(Boolean).join('-')}.${extension}`;
}

/**
 * A report as CSV and as a PDF summary (FR-SET-01, #25), behind `reports.export`. While
 * approval (#24) is off, a closed report is exported and an open one answers 409 not_closed;
 * with it on, a submitted or approved one, and any other answers 409 not_submitted (Q29).
 * Both files are made in the request: they are read from the database and laid out in memory,
 * with no call to another service.
 */
export function registerReportExportRoutes(
  app: OpenAPIHono<{ Variables: AuthVariables }>,
  options: ReportExportRouteOptions,
) {
  const auth = requireIdentity(options.verifyToken);
  for (const route of [exportReportCsvRoute, exportReportPdfRoute]) {
    app.use(route.getRoutingPath(), auth);
  }
  const features = options.features ?? featureGate({ workspace: options.workspace });
  const now = () => options.now?.() ?? new Date();

  /** The report, once the caller may export it and it is closed. */
  const exportable = async (userId: string, reportId: string) => {
    if (!options.workspace || !options.reports) {
      throw new ProblemError(
        503,
        'database-not-configured',
        'The database is not configured on this server',
        { code: 'database_not_configured' },
      );
    }
    const who = await options.workspace.findMembership(userId);
    if (!who) {
      throw new ProblemError(
        403,
        'no-organization',
        'You are not a member of an organization yet',
        { code: 'no_organization', detail: 'Call POST /v1/me/organization after signing in.' },
      );
    }
    await features.require(who.orgId, 'reports.export');
    const found = await options.reports.forExport(who.orgId, reportId);
    // Another member's report looks absent, as it will everywhere once #50 lands.
    if (!found || !canExportReport(who.role, found.report.memberId === who.memberId)) {
      throw new ProblemError(404, 'not-found', 'No such report', { code: 'not_found' });
    }
    // Once approval exists, submitted and approved reports are exported (Q29).
    if (await features.isOn(who.orgId, 'reports.approval')) {
      if (!isExportableOnceApproved(found.report.status)) {
        throw new ProblemError(409, 'not-submitted', 'Only a submitted report can be exported', {
          code: 'not_submitted',
          detail: 'Submit it for approval first; then it can be exported, and once approved.',
        });
      }
    } else if (!isReportExportable(found.report.status)) {
      throw new ProblemError(409, 'not-closed', 'Only a closed report can be exported', {
        code: 'not_closed',
        detail: 'It is still open. Close it first.',
      });
    }
    return { ...found, expenses: await shownRows(who.orgId, found) };
  };

  /**
   * Each expense with its parts while splits are on, its excluded lines while itemized lines
   * are on (FR-EXP-15, FR-EXP-16), and a drive's measured and claimed miles while route mileage
   * is on (Q33); off, the export reads as it always has.
   */
  const shownRows = async (orgId: string, found: ReportForExport) => {
    const split =
      (await features.isOn(orgId, 'expenses.split')) &&
      (await features.isOn(orgId, 'expenses.categories'));
    const lines = await features.isOn(orgId, 'expenses.itemized');
    const routes = await features.isOn(orgId, ROUTE_MILEAGE_FLAG);
    return found.expenses.map(({ parts, excluded, miles, ...e }) => ({
      ...e,
      ...(routes && miles ? { miles } : {}),
      ...(split && parts ? { parts } : {}),
      ...(lines && excluded ? { excluded } : {}),
    }));
  };

  const download = (found: ReportForExport, extension: 'csv' | 'pdf', contentType: string) => ({
    'content-type': contentType,
    'content-disposition': `attachment; filename="${exportFileName(found, extension)}"`,
    // A person's spending: never kept by a browser or a shared cache.
    'cache-control': 'no-store',
  });

  app.openapi(exportReportCsvRoute, async (c) => {
    const found = await exportable(c.var.identity.userId, c.req.valid('param').reportId);
    const csv = reportCsv(reportExportTable(found.expenses));
    return c.body(csv, 200, download(found, 'csv', 'text/csv; charset=utf-8'));
  });

  app.openapi(exportReportPdfRoute, async (c) => {
    const found = await exportable(c.var.identity.userId, c.req.valid('param').reportId);
    const { report } = found;
    const pdf = await reportPdf(
      {
        title: report.title,
        person: report.owner,
        organization: report.organization,
        status: STATUS[report.status],
        openedAt: report.openedAt,
        closedAt: report.closedAt,
        exportedAt: now(),
      },
      reportExportTable(found.expenses),
    );
    return c.body(pdf, 200, download(found, 'pdf', 'application/pdf'));
  });
}
