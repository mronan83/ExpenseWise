import type { Membership } from '@expensewise/db';
import type { OpenAPIHono } from '@hono/zod-openapi';
import type { ApprovalStore } from './approval.ts';
import { approvalView } from './approval-views.ts';
import { requireIdentity, type AuthVariables, type Identity, type TokenVerifier } from './auth.ts';
import { notYours } from './caller.ts';
import { featureGate, type FeatureGate } from './features.ts';
import { ProblemError } from './problem.ts';
import { showConverted } from './reimbursement.ts';
import { reportSummary } from './report-views.ts';
import {
  approveReportRoute,
  claimReasonRoute,
  getApprovalRoute,
  listApprovalsRoute,
  returnReportRoute,
  submitReportRoute,
} from './routes/approval.ts';
import { requireSecondFactor } from './second-factor.ts';
import type { WorkspaceStore } from './workspace.ts';

export interface ApprovalRouteOptions {
  readonly verifyToken?: TokenVerifier;
  readonly workspace?: WorkspaceStore;
  readonly approvals?: ApprovalStore;
  /** Which features are on. Built from `workspace` when not given. */
  readonly features?: FeatureGate;
  readonly now?: () => Date;
}

/** The feature approval ships behind (ADR-0032). */
export const APPROVAL_FEATURE = 'reports.approval';

/**
 * Single-step approval (FR-GOV-02, #24, ADR-0043), behind `reports.approval`: submitting a
 * closed report, approving or returning it, and saying why an expense claims less than its
 * receipt. Off, every route answers 404 feature_off.
 */
export function registerApprovalRoutes(
  app: OpenAPIHono<{ Variables: AuthVariables }>,
  options: ApprovalRouteOptions,
) {
  const auth = requireIdentity(options.verifyToken);
  const features = options.features ?? featureGate(options);
  const routes = [
    getApprovalRoute,
    submitReportRoute,
    approveReportRoute,
    returnReportRoute,
    listApprovalsRoute,
    claimReasonRoute,
  ];
  for (const path of new Set(routes.map((r) => r.getRoutingPath()))) app.use(path, auth);
  const now = () => options.now?.() ?? new Date();

  const stores = () => {
    if (!options.workspace || !options.approvals) {
      throw new ProblemError(
        503,
        'database-not-configured',
        'The database is not configured on this server',
        { code: 'database_not_configured' },
      );
    }
    return { workspace: options.workspace, approvals: options.approvals };
  };
  /** The caller's membership, once approval is on for their organization. */
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
    await features.require(membership.orgId, APPROVAL_FEATURE);
    return membership;
  };
  const notFound = (what: string) =>
    new ProblemError(404, 'not-found', `No such ${what}`, { code: 'not_found' });
  const conflict = (code: string, title: string, extra: Record<string, unknown> = {}) =>
    new ProblemError(409, code.replaceAll('_', '-'), title, { code, ...extra });
  const viewOf = async (who: Membership, identity: Identity, reportId: string) => {
    const data = await stores().approvals.view(who.orgId, reportId);
    if (!data) throw notFound('report');
    return approvalView(data, who, identity);
  };
  const differences = (list: readonly { expenseId: string; reason: string }[]) =>
    list.map((d) => ({ expenseId: d.expenseId, reason: d.reason }));

  app.openapi(getApprovalRoute, async (c) => {
    const who = await member(c.var.identity.userId);
    return c.json(await viewOf(who, c.var.identity, c.req.valid('param').reportId), 200);
  });

  app.openapi(submitReportRoute, async (c) => {
    const identity = c.var.identity;
    const who = await member(identity.userId);
    const { reportId } = c.req.valid('param');
    const result = await stores().approvals.submit(who.orgId, reportId, {
      memberId: who.memberId,
      userId: identity.userId,
    });
    switch (result.status) {
      case 'missing':
        throw notFound('report');
      case 'not_yours':
        throw notYours();
      case 'not_closed':
        throw conflict('not_closed', 'Only a closed report is submitted', {
          detail:
            result.current === 'open'
              ? 'Close it first.'
              : `It is ${result.current.replaceAll('_', ' ')} already.`,
        });
      case 'empty':
        throw conflict('empty_report', 'This report holds nothing to claim');
      case 'differs':
        throw conflict('differs_from_receipt', 'An expense on it differs from its receipt', {
          detail:
            'Fix each one, or say why it claims less than its receipt; it is never more (FR-GOV-13).',
          expenses: differences(result.differences),
        });
      case 'no_approver':
        throw conflict('no_approver', 'No one else here can approve it', {
          detail:
            'In a team, someone else approves your spend. An owner can give someone the approver or finance admin role in Settings › People.',
        });
      case 'submitted':
        return c.json(await viewOf(who, identity, reportId), 200);
    }
  });

  /** Answers a decision that didn't go through. */
  const refused = (
    result: Exclude<
      Awaited<ReturnType<ApprovalStore['decide']>>,
      { status: 'approved' | 'returned' }
    >,
    identity: Identity,
  ): never => {
    switch (result.status) {
      case 'missing':
        throw notFound('report');
      case 'not_in_approval':
        throw conflict('not_in_approval', 'This report isn’t waiting for approval', {
          detail: `It is ${result.current.replaceAll('_', ' ')}.`,
        });
      case 'self_approval':
        throw new ProblemError(403, 'self-approval', 'You can’t approve your own spend', {
          code: 'self_approval',
          detail: 'In a team, someone else approves it (FR-GOV-03).',
        });
      case 'not_an_approver':
        throw new ProblemError(403, 'not-an-approver', 'Only an approver decides a report', {
          code: 'not_an_approver',
          detail: 'An approver, a finance admin or the owner approves a report.',
        });
      case 'not_your_approval':
        throw new ProblemError(403, 'not-your-approval', 'This report went to another approver', {
          code: 'not_your_approval',
        });
      case 'second_factor_required':
        // Approving someone else's spend needs aal2 (FR-GOV-04); this session hasn't it.
        requireSecondFactor(identity);
        throw new Error('A session with the second factor was asked for it again');
      case 'rejected':
        throw conflict('rejected_on_review', 'An expense on it differs from its receipt', {
          detail: 'It is rejected, so the report goes back: return it with a comment (FR-GOV-10).',
          expenses: differences(result.differences),
        });
      case 'invalid':
        throw new ProblemError(422, 'invalid-value', 'The return is not complete', {
          code: 'invalid_value',
          detail: result.message,
        });
    }
  };

  app.openapi(approveReportRoute, async (c) => {
    const identity = c.var.identity;
    const who = await member(identity.userId);
    const { reportId } = c.req.valid('param');
    const result = await stores().approvals.decide(
      who.orgId,
      reportId,
      {
        memberId: who.memberId,
        role: who.role,
        userId: identity.userId,
        secondFactor: identity.assuranceLevel === 'aal2',
      },
      { kind: 'approve' },
    );
    if (result.status !== 'approved' && result.status !== 'returned') refused(result, identity);
    return c.json(await viewOf(who, identity, reportId), 200);
  });

  app.openapi(returnReportRoute, async (c) => {
    const identity = c.var.identity;
    const who = await member(identity.userId);
    const { reportId } = c.req.valid('param');
    const { comment, rejections } = c.req.valid('json');
    const result = await stores().approvals.decide(
      who.orgId,
      reportId,
      {
        memberId: who.memberId,
        role: who.role,
        userId: identity.userId,
        secondFactor: identity.assuranceLevel === 'aal2',
      },
      { kind: 'return', comment, rejections },
    );
    if (result.status !== 'approved' && result.status !== 'returned') refused(result, identity);
    return c.json(await viewOf(who, identity, reportId), 200);
  });

  app.openapi(listApprovalsRoute, async (c) => {
    const who = await member(c.var.identity.userId);
    const found = await stores().approvals.toApprove(who.orgId, who.memberId);
    const at = now();
    const on = await showConverted(features, who.orgId, found);
    return c.json({ reports: found.map((r) => reportSummary(r, at, on)) }, 200);
  });

  app.openapi(claimReasonRoute, async (c) => {
    const identity = c.var.identity;
    const who = await member(identity.userId);
    const { expenseId } = c.req.valid('param');
    const { reason } = c.req.valid('json');
    const result = await stores().approvals.claimReason(
      who.orgId,
      expenseId,
      reason,
      identity.userId,
    );
    switch (result.status) {
      case 'missing':
        throw notFound('expense');
      case 'invalid':
        throw new ProblemError(422, 'invalid-value', 'The reason is not valid', {
          code: 'invalid_value',
          detail: result.message,
        });
      case 'not_editable':
        throw conflict('not_editable', 'This expense can’t be changed now', {
          detail: 'It is being read, or it is submitted or later.',
        });
      case 'saved':
      case 'unchanged':
        return c.json({ reason: result.reason }, 200);
    }
  });
}
