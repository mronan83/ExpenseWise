import type { Membership, MoveToReportResult } from '@expensewise/db';
import type { OpenAPIHono } from '@hono/zod-openapi';
import { requireIdentity, type AuthVariables, type TokenVerifier } from './auth.ts';
import { ProblemError } from './problem.ts';
import { reportDetail, reportSummary } from './report-views.ts';
import type { ReportStore } from './reports.ts';
import {
  closeReportRoute,
  getReportRoute,
  justifyExpenseRoute,
  listReportsRoute,
  moveExpenseToReportRoute,
  moveTripToReportRoute,
  reopenReportRoute,
} from './routes/reports.ts';
import type { WorkspaceStore } from './workspace.ts';

export interface ReportRouteOptions {
  readonly verifyToken?: TokenVerifier;
  readonly workspace?: WorkspaceStore;
  readonly reports?: ReportStore;
  readonly now?: () => Date;
}

const LIST_LIMIT = 50;

export function registerReportRoutes(
  app: OpenAPIHono<{ Variables: AuthVariables }>,
  options: ReportRouteOptions,
) {
  const auth = requireIdentity(options.verifyToken);
  const paths = new Set(
    [
      listReportsRoute,
      getReportRoute,
      closeReportRoute,
      reopenReportRoute,
      moveTripToReportRoute,
      moveExpenseToReportRoute,
      justifyExpenseRoute,
    ].map((r) => r.getRoutingPath()),
  );
  for (const path of paths) app.use(path, auth);
  const now = () => options.now?.() ?? new Date();

  const stores = () => {
    if (!options.workspace || !options.reports) {
      throw new ProblemError(
        503,
        'database-not-configured',
        'The database is not configured on this server',
        { code: 'database_not_configured' },
      );
    }
    return { workspace: options.workspace, reports: options.reports };
  };
  const member = async (userId: string): Promise<Membership> => {
    const membership = await stores().workspace.findMembership(userId);
    if (!membership) {
      throw new ProblemError(
        403,
        'no-organization',
        'You are not a member of an organization yet',
        { code: 'no_organization', detail: 'Call POST /v1/me/organization after signing in.' },
      );
    }
    return membership;
  };
  const notFound = (what: string) =>
    new ProblemError(404, 'not-found', `No such ${what}`, { code: 'not_found' });
  const conflict = (code: string, title: string, extra: Record<string, unknown> = {}) =>
    new ProblemError(409, code.replaceAll('_', '-'), title, { code, ...extra });
  const detailOf = async (orgId: string, reportId: string) => {
    const found = await stores().reports.get(orgId, reportId);
    if (!found) throw notFound('report');
    return reportDetail(found, now());
  };

  app.openapi(listReportsRoute, async (c) => {
    const who = await member(c.var.identity.userId);
    const found = await stores().reports.list(who.orgId, who.memberId, LIST_LIMIT);
    const at = now();
    return c.json({ reports: found.map((r) => reportSummary(r, at)) }, 200);
  });

  app.openapi(getReportRoute, async (c) => {
    const who = await member(c.var.identity.userId);
    const { reportId } = c.req.valid('param');
    return c.json(await detailOf(who.orgId, reportId), 200);
  });

  app.openapi(closeReportRoute, async (c) => {
    const caller = c.var.identity;
    const who = await member(caller.userId);
    const { reportId } = c.req.valid('param');
    const result = await stores().reports.close(who.orgId, reportId, caller.userId);
    if (result.status === 'missing') throw notFound('report');
    if (result.status === 'not_open') {
      throw conflict('not_open', 'This report is not open', {
        detail: `It is ${result.current.replaceAll('_', ' ')}.`,
      });
    }
    if (result.status === 'empty') {
      throw conflict('empty_report', 'This report holds nothing to claim');
    }
    if (result.status === 'needs_attention') {
      throw conflict('needs_attention', 'Something on this report still needs you', {
        detail: 'Review each expense still needing a look, and justify each local expense.',
        blocking: result.blocking,
      });
    }
    return c.json(await detailOf(who.orgId, reportId), 200);
  });

  app.openapi(reopenReportRoute, async (c) => {
    const caller = c.var.identity;
    const who = await member(caller.userId);
    const { reportId } = c.req.valid('param');
    const result = await stores().reports.reopen(who.orgId, reportId, caller.userId);
    if (result.status === 'missing') throw notFound('report');
    if (result.status === 'not_closed') {
      throw conflict('not_closed', 'This report can’t be reopened', {
        detail:
          result.current === 'open'
            ? 'It is open already.'
            : 'It is submitted, and a submitted report is locked.',
      });
    }
    return c.json(await detailOf(who.orgId, reportId), 200);
  });

  const moved = (result: MoveToReportResult, what: string) => {
    switch (result.status) {
      case 'moved':
        return { reportId: result.reportId, dropped: result.dropped };
      case 'missing':
        throw notFound(what);
      case 'no_such_report':
        throw notFound('report');
      case 'not_local':
        throw new ProblemError(422, 'not-local', 'Only a local expense moves on its own', {
          code: 'not_local',
          detail: 'An expense on a trip goes with its trip.',
        });
      case 'not_open':
        throw conflict('not_open', 'That report is not open', {
          detail: 'Reopen it first; a submitted report is locked.',
        });
      case 'other_member':
        throw conflict('other_member', 'That report is another person’s');
      case 'unchanged':
        return null;
    }
  };

  app.openapi(moveTripToReportRoute, async (c) => {
    const caller = c.var.identity;
    const who = await member(caller.userId);
    const { tripId } = c.req.valid('param');
    const choice = c.req.valid('json');
    const result = await stores().reports.move(who.orgId, { tripId }, choice, caller.userId);
    const body = moved(result, 'trip') ?? {
      reportId: 'reportId' in choice ? choice.reportId : '',
      dropped: null,
    };
    return c.json(body, 200);
  });

  app.openapi(moveExpenseToReportRoute, async (c) => {
    const caller = c.var.identity;
    const who = await member(caller.userId);
    const { expenseId } = c.req.valid('param');
    const choice = c.req.valid('json');
    const result = await stores().reports.move(who.orgId, { expenseId }, choice, caller.userId);
    const body = moved(result, 'expense') ?? {
      reportId: 'reportId' in choice ? choice.reportId : '',
      dropped: null,
    };
    return c.json(body, 200);
  });

  app.openapi(justifyExpenseRoute, async (c) => {
    const caller = c.var.identity;
    const who = await member(caller.userId);
    const { expenseId } = c.req.valid('param');
    const { justification } = c.req.valid('json');
    const result = await stores().reports.justify(
      who.orgId,
      expenseId,
      justification,
      caller.userId,
    );
    switch (result.status) {
      case 'missing':
        throw notFound('expense');
      case 'not_local':
        throw new ProblemError(422, 'not-local', 'Only a local expense needs a justification', {
          code: 'not_local',
          detail: 'A trip says why an expense on it was spent.',
        });
      case 'invalid':
        throw new ProblemError(422, 'invalid-value', 'The justification is not valid', {
          code: 'invalid_value',
          detail: result.message,
        });
      case 'not_editable':
        throw conflict('not_editable', 'This expense can’t be changed now', {
          detail: 'It is being read, or it is submitted or later.',
        });
      case 'unchanged':
        return c.json({ justification: justification.trim() || null }, 200);
      case 'justified':
        return c.json({ justification: result.justification }, 200);
    }
  });
}
