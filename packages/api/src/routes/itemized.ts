import { createRoute, z } from '@hono/zod-openapi';
import {
  ExcludeLineSchema,
  ReportCategoriesSchema,
  SplitExpenseSchema,
} from '../itemized-schemas.ts';
import { ExpenseDetailSchema, ProblemSchema } from '../schemas.ts';

/*
 * A receipt's itemized lines (FR-INT-22, FR-EXP-16) behind `expenses.itemized`, and splitting an
 * expense into parts (FR-EXP-15) behind `expenses.split` with `expenses.categories`. Each route
 * answers 404 feature_off while its feature is off for the organization (ADR-0041).
 */

const problem = (description: string) => ({
  description,
  content: { 'application/problem+json': { schema: ProblemSchema } },
});

const secured = { security: [{ bearerAuth: [] }] };

const json = <T extends z.ZodType>(schema: T) => ({
  content: { 'application/json': { schema } },
  required: true,
});

const pathId = (name: string) =>
  z
    .string()
    .uuid()
    .openapi({ param: { name, in: 'path' } });

const lineParams = z.object({
  expenseId: pathId('expenseId'),
  position: z.coerce
    .number()
    .int()
    .min(1)
    .openapi({
      param: { name: 'position', in: 'path' },
      description: 'The line’s number, from 1.',
    }),
});

const changed = {
  200: {
    description: 'The expense, as its page shows it.',
    content: { 'application/json': { schema: ExpenseDetailSchema } },
  },
  401: problem('Sign in required.'),
  403: problem(
    'The caller has no organization yet, or it is another member’s expense, which only its ' +
      'member changes (not_yours).',
  ),
  404: problem('No such expense, or the feature is off (feature_off).'),
  409: problem(
    'It can’t change now: being_read, locked once submitted, not_itemized, lines_dont_add_up, ' +
      'other_currency or amount_changed when its lines don’t make up its claim, ' +
      'split_by_amount, no_claim for an expense with no amount yet, or mileage for a drive.',
  ),
  422: problem(
    'A value is not valid: a reason, a note other needs, a line that isn’t an item, parts that ' +
      'don’t add up to the claim, or a category and type that can’t be chosen. field names which.',
  ),
  503: problem('Sign-in or the database is not configured on this server.'),
};

export const excludeLineRoute = createRoute({
  method: 'put',
  path: '/v1/expenses/{expenseId}/lines/{position}/exclusion',
  tags: ['Expenses'],
  summary: 'Leave a line out of what the expense claims, with why',
  description:
    'FR-EXP-16, Q40, Q39. Takes a reason, and a note that other needs. The claim drops by the ' +
    'line and its share of the tax, tip and fees; a split by line is worked out again. A line ' +
    'already excluded takes the new reason. Each change is in the audit trail.',
  ...secured,
  request: { params: lineParams, body: json(ExcludeLineSchema) },
  responses: changed,
});

export const includeLineRoute = createRoute({
  method: 'delete',
  path: '/v1/expenses/{expenseId}/lines/{position}/exclusion',
  tags: ['Expenses'],
  summary: 'Include an excluded line in the claim again',
  description: 'FR-EXP-16. Before submission: the claim goes back up by the line and its share.',
  ...secured,
  request: { params: lineParams },
  responses: changed,
});

const expenseParams = z.object({ expenseId: pathId('expenseId') });

export const splitExpenseRoute = createRoute({
  method: 'put',
  path: '/v1/expenses/{expenseId}/split',
  tags: ['Expenses'],
  summary: 'Split an expense into parts, each with its own category and type',
  description:
    'FR-EXP-15, Q37, Q38. One expense with one receipt. By line, where its lines add up: each ' +
    'line given a category and type is a part, with its share of the tax, tip and fees, and the ' +
    'rest keep the expense’s own. By amount: parts that add up to the claim exactly, or 422 ' +
    'parts_dont_add_up. A new split replaces the one before.',
  ...secured,
  request: { params: expenseParams, body: json(SplitExpenseSchema) },
  responses: changed,
});

export const unsplitExpenseRoute = createRoute({
  method: 'delete',
  path: '/v1/expenses/{expenseId}/split',
  tags: ['Expenses'],
  summary: 'Take a split away',
  description: 'FR-EXP-15. The expense is one part again, with its own category and type.',
  ...secured,
  request: { params: expenseParams },
  responses: changed,
});

export const reportCategoriesRoute = createRoute({
  method: 'get',
  path: '/v1/reports/{reportId}/categories',
  tags: ['Reports'],
  summary: 'What a report comes to by category and type',
  description:
    'FR-EXP-15. Each part of a split expense under its own category and type, every other ' +
    'expense under its own; possible duplicates left out. While currency conversion is on, ' +
    'each also in the report’s currency, each part taking its share of the conversion.',
  ...secured,
  request: { params: z.object({ reportId: pathId('reportId') }) },
  responses: {
    200: {
      description: 'Its totals by category and type.',
      content: { 'application/json': { schema: ReportCategoriesSchema } },
    },
    401: problem('Sign in required.'),
    403: problem('The caller has no organization yet.'),
    404: problem('No such report, or the feature is off (feature_off).'),
    503: problem('Sign-in or the database is not configured on this server.'),
  },
});
