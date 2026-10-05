import { createRoute, z } from '@hono/zod-openapi';
import {
  ApprovalSchema,
  ClaimReasonBodySchema,
  ClaimReasonSchema,
  ReturnReportSchema,
} from '../approval-schemas.ts';
import { ProblemSchema, ReportListSchema } from '../schemas.ts';

const problem = (description: string) => ({
  description,
  content: { 'application/problem+json': { schema: ProblemSchema } },
});

const secured = { security: [{ bearerAuth: [] }] };

const common = {
  401: problem('Sign in required.'),
  403: problem('The caller has no organization yet: call POST /v1/me/organization first.'),
  503: problem('Sign-in or the database is not configured on this server.'),
};

const off = { 404: problem('No such report, or approval is switched off (feature_off).') };

const uuidParam = (name: string) =>
  z
    .string()
    .uuid()
    .openapi({ param: { name, in: 'path' } });

const reportParam = z.object({ reportId: uuidParam('reportId') });

const approval = (description: string) => ({
  description,
  content: { 'application/json': { schema: ApprovalSchema } },
});

export const getApprovalRoute = createRoute({
  method: 'get',
  path: '/v1/reports/{reportId}/approval',
  tags: ['Approval'],
  summary: 'A report’s approval: each expense against its receipt, and what the caller may do',
  description:
    'Who it is with, or would go to; each round so far; every expense on it judged against its ' +
    'receipt (Q6); a return’s comment and rejections while it is back (FR-GOV-12). Behind ' +
    '`reports.approval`.',
  ...secured,
  request: { params: reportParam },
  responses: { 200: approval('The approval.'), ...common, ...off },
});

export const submitReportRoute = createRoute({
  method: 'post',
  path: '/v1/reports/{reportId}/submit',
  tags: ['Approval'],
  summary: 'Submit a closed report for approval',
  description:
    'Only the person’s own closed report (FR-EXP-12), and never while an expense on it differs ' +
    'from its receipt without a reason (FR-GOV-13). It goes to its approver in one step ' +
    '(FR-GOV-02); in a one-person organization, to its owner, who self-attests (FR-GOV-03). ' +
    'Each expense’s category and type names are kept as they are now (NFR-DAT-04).',
  ...secured,
  request: { params: reportParam },
  responses: {
    200: approval('Submitted: it waits for its approver.'),
    ...common,
    403: problem('It is another person’s report (not_yours), or the caller has no organization.'),
    ...off,
    409: problem(
      'It is not closed, holds nothing, an expense on it differs from its receipt without a ' +
        'reason (differs_from_receipt, naming each), or no one else in the team can approve it ' +
        '(no_approver).',
    ),
  },
});

export const approveReportRoute = createRoute({
  method: 'post',
  path: '/v1/reports/{reportId}/approve',
  tags: ['Approval'],
  summary: 'Approve a report waiting for approval',
  description:
    'By the approver it went to, or an owner or finance admin in their place; never one’s own ' +
    'in a team (FR-GOV-03). Approving someone else’s needs the second factor in this session ' +
    '(FR-GOV-04). An expense that differs from its receipt is rejected (FR-GOV-10), so the ' +
    'report can only be returned. Its expenses are then approved, and locked.',
  ...secured,
  request: { params: reportParam },
  responses: {
    200: approval('Approved.'),
    ...common,
    403: problem(
      'Not the caller’s to decide (self_approval, not_an_approver, not_your_approval), or the ' +
        'second factor is needed (second_factor_required).',
    ),
    ...off,
    409: problem(
      'It is not waiting for approval, or an expense on it differs from its receipt ' +
        '(rejected_on_review, naming each): return it instead.',
    ),
  },
});

export const returnReportRoute = createRoute({
  method: 'post',
  path: '/v1/reports/{reportId}/return',
  tags: ['Approval'],
  summary: 'Return a report to its member, with a comment and each rejected expense',
  description:
    'The whole report goes back (FR-GOV-11), open again with a week to close, each rejected ' +
    'expense kept with why (FR-GOV-12); any that differ from their receipts are rejected on ' +
    'their own (FR-GOV-10).',
  ...secured,
  request: {
    params: reportParam,
    body: { content: { 'application/json': { schema: ReturnReportSchema } }, required: true },
  },
  responses: {
    200: approval('Returned.'),
    ...common,
    403: problem('Not the caller’s to decide (self_approval, not_an_approver, not_your_approval).'),
    ...off,
    409: problem('It is not waiting for approval.'),
    422: problem('No comment, a reason missing or too long, or an expense not on it.'),
  },
});

export const listApprovalsRoute = createRoute({
  method: 'get',
  path: '/v1/approvals',
  tags: ['Approval'],
  summary: 'The reports waiting for the caller’s decision, oldest first',
  ...secured,
  responses: {
    200: {
      description: 'Every report routed to the caller and not yet decided.',
      content: { 'application/json': { schema: ReportListSchema } },
    },
    ...common,
    404: problem('Approval is switched off (feature_off).'),
  },
});

export const claimReasonRoute = createRoute({
  method: 'put',
  path: '/v1/expenses/{expenseId}/claim-reason',
  tags: ['Expenses'],
  summary: 'Say why an expense claims less than its receipt',
  description:
    'An expense may claim less than its receipt with a reason, never more (FR-EXP-10, Q6). A ' +
    'closed report it is on reopens. Behind `reports.approval`.',
  ...secured,
  request: {
    params: z.object({ expenseId: uuidParam('expenseId') }),
    body: { content: { 'application/json': { schema: ClaimReasonBodySchema } }, required: true },
  },
  responses: {
    200: {
      description: 'Saved.',
      content: { 'application/json': { schema: ClaimReasonSchema } },
    },
    ...common,
    404: problem('No such expense, or approval is switched off (feature_off).'),
    409: problem('It is being read, or submitted or later.'),
    422: problem('The reason is too long.'),
  },
});
