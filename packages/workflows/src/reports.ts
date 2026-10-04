import {
  reportWorkDue,
  runReportSchedule,
  type Database,
  type ReportScheduleResult,
} from '@expensewise/db';
import type { Inngest } from 'inngest';

/**
 * Hourly, at seven minutes past, so it misses the top of the hour. About 720 runs a month, a
 * small part of the free plan's 50,000 executions (ADR-0014). A trip joins a report at noon
 * UTC (joinsReportAt), so it is on its report within the hour.
 */
export const REPORT_SCHEDULE = '7 * * * *';

export interface ReportSchedulePorts {
  /** The organizations with report work due, as ids only (report_work_due()). */
  dueOrganizations(now: Date): Promise<string[]>;
  /** One organization's work, in one transaction inside it. */
  runFor(orgId: string, now: Date): Promise<ReportScheduleResult>;
  now?(): Date;
}

export interface ReportScheduleSummary {
  readonly organizations: number;
  readonly joined: number;
  readonly opened: number;
  readonly closed: number;
  readonly moved: number;
  readonly dropped: number;
  readonly failed: number;
}

/**
 * Joins what is due to reports and closes those on day 28, organization by organization
 * (ADR-0029). One organization failing doesn't hold up the rest; the run then fails, so it is
 * retried, which is safe since nothing joins or closes twice. Logs one line with counts only.
 */
export async function scheduleReports(ports: ReportSchedulePorts): Promise<ReportScheduleSummary> {
  const now = ports.now?.() ?? new Date();
  const organizations = await ports.dueOrganizations(now);
  const results: ReportScheduleResult[] = [];
  const failures: unknown[] = [];
  for (const orgId of organizations) {
    try {
      results.push(await ports.runFor(orgId, now));
    } catch (error) {
      failures.push(error);
    }
  }
  const sum = (pick: (r: ReportScheduleResult) => number) =>
    results.reduce((n, r) => n + pick(r), 0);
  const summary: ReportScheduleSummary = {
    organizations: organizations.length,
    joined: sum((r) => r.joined.trips + r.joined.expenses),
    opened: sum((r) => r.joined.opened),
    closed: sum((r) => r.closed.closed),
    moved: sum((r) => r.closed.moved),
    dropped: sum((r) => r.closed.dropped),
    failed: failures.length,
  };
  console.log('report-schedule', summary);
  if (failures.length > 0) {
    throw new AggregateError(failures, `Report work failed for ${failures.length} organization(s)`);
  }
  return summary;
}

/** Wires the schedule to Postgres as expensewise_app. */
export function reportSchedulePorts(db: Database): ReportSchedulePorts {
  return {
    dueOrganizations: (now) => reportWorkDue(db, now),
    runFor: (orgId, now) => runReportSchedule(db, orgId, now),
  };
}

/** Opens, fills and closes expense reports on the hour. A run while one is going is skipped. */
export function reportScheduleFunction(client: Inngest, ports: () => ReportSchedulePorts) {
  return client.createFunction(
    {
      id: 'report-schedule',
      name: 'Expense report schedule',
      triggers: [{ cron: REPORT_SCHEDULE }],
      singleton: { mode: 'skip' },
      retries: 2,
    },
    () => scheduleReports(ports()),
  );
}
