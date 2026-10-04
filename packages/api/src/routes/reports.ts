import { createRoute, z } from '@hono/zod-openapi';
import {
  JustificationSchema,
  JustifyExpenseSchema,
  MoveToReportSchema,
  ProblemSchema,
  ReportDetailSchema,
  ReportListSchema,
  ReportMoveResultSchema,
} from '../schemas.ts';

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

const uuidParam = (name: string) =>
  z
    .string()
    .uuid()
    .openapi({ param: { name, in: 'path' } });

const reportParam = z.object({ reportId: uuidParam('reportId') });

export const listReportsRoute = createRoute({
  method: 'get',
  path: '/v1/reports',
  tags: ['Reports'],
  summary: 'The caller’s expense reports, newest first',
  description:
    'Trips join a report 24 hours after their return date, and local expenses 24 hours after ' +
    'their own; a report closes within 28 days (FR-EXP-05, FR-EXP-12, ADR-0029).',
  ...secured,
  responses: {
    200: {
      description: 'The 50 newest reports.',
      content: { 'application/json': { schema: ReportListSchema } },
    },
    ...common,
  },
});

export const getReportRoute = createRoute({
  method: 'get',
  path: '/v1/reports/{reportId}',
  tags: ['Reports'],
  summary: 'One report, with each trip and local expense on it',
  ...secured,
  request: { params: reportParam },
  responses: {
    200: {
      description: 'The report.',
      content: { 'application/json': { schema: ReportDetailSchema } },
    },
    ...common,
    404: problem('No such report in this organization.'),
  },
});

export const closeReportRoute = createRoute({
  method: 'post',
  path: '/v1/reports/{reportId}/close',
  tags: ['Reports'],
  summary: 'Close a report',
  description:
    'Only with nothing left on it to review: no expense being read or needing a look, and ' +
    'every local expense justified (FR-EXP-12). Closing never submits it.',
  ...secured,
  request: { params: reportParam },
  responses: {
    200: {
      description: 'It is closed.',
      content: { 'application/json': { schema: ReportDetailSchema } },
    },
    ...common,
    404: problem('No such report in this organization.'),
    409: problem(
      'It is not open, holds nothing, or something on it still needs review or a ' +
        'justification; blocking names what.',
    ),
  },
});

export const reopenReportRoute = createRoute({
  method: 'post',
  path: '/v1/reports/{reportId}/reopen',
  tags: ['Reports'],
  summary: 'Reopen a closed report',
  description:
    'Possible until it is submitted. It closes itself on its day 28, or a week after ' +
    'reopening if that is later.',
  ...secured,
  request: { params: reportParam },
  responses: {
    200: {
      description: 'It is open.',
      content: { 'application/json': { schema: ReportDetailSchema } },
    },
    ...common,
    404: problem('No such report in this organization.'),
    409: problem('It is open already, or submitted and locked.'),
  },
});

const moveResponses = {
  200: {
    description: 'Moved.',
    content: { 'application/json': { schema: ReportMoveResultSchema } },
  },
  ...common,
  404: problem('No such trip, expense or report in this organization.'),
  409: problem(
    'The report it is on, or the one chosen, is not open; or the report is another person’s.',
  ),
};

export const moveTripToReportRoute = createRoute({
  method: 'put',
  path: '/v1/trips/{tripId}/report',
  tags: ['Reports'],
  summary: 'Move a trip to another open report, or a new one',
  description:
    'Its expenses go with it. A report left holding nothing is dropped (FR-EXP-05, Q20).',
  ...secured,
  request: {
    params: z.object({ tripId: uuidParam('tripId') }),
    body: { content: { 'application/json': { schema: MoveToReportSchema } }, required: true },
  },
  responses: moveResponses,
});

export const moveExpenseToReportRoute = createRoute({
  method: 'put',
  path: '/v1/expenses/{expenseId}/report',
  tags: ['Reports'],
  summary: 'Move a local expense to another open report, or a new one',
  description: 'Only a local expense: one on a trip goes with its trip.',
  ...secured,
  request: {
    params: z.object({ expenseId: uuidParam('expenseId') }),
    body: { content: { 'application/json': { schema: MoveToReportSchema } }, required: true },
  },
  responses: {
    ...moveResponses,
    422: problem('It is on a trip, or has no date yet, so it is not a local expense.'),
  },
});

export const justifyExpenseRoute = createRoute({
  method: 'put',
  path: '/v1/expenses/{expenseId}/justification',
  tags: ['Expenses'],
  summary: 'Say why a local expense was for business',
  description:
    'A local expense, one on no trip, needs a justification before its report can close ' +
    '(FR-EXP-14). A closed report it is on reopens.',
  ...secured,
  request: {
    params: z.object({ expenseId: uuidParam('expenseId') }),
    body: { content: { 'application/json': { schema: JustifyExpenseSchema } }, required: true },
  },
  responses: {
    200: {
      description: 'Saved.',
      content: { 'application/json': { schema: JustificationSchema } },
    },
    ...common,
    404: problem('No such expense in this organization.'),
    409: problem('It is being read, or submitted or later.'),
    422: problem('It is on a trip, or the justification is too long.'),
  },
});
