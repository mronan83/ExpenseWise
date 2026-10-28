import { createRoute, z } from '@hono/zod-openapi';
import {
  EditExpenseSchema,
  ExpenseDetailSchema,
  ExpenseListSchema,
  ExpenseSearchSchema,
  ProblemSchema,
  RefundCandidatesSchema,
  SetExpenseTripSchema,
  SetRefundOfSchema,
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

const expenseParam = z.object({
  expenseId: z
    .string()
    .uuid()
    .openapi({ param: { name: 'expenseId', in: 'path' } }),
});

export const listExpensesRoute = createRoute({
  method: 'get',
  path: '/v1/expenses',
  tags: ['Expenses'],
  summary: 'The organization’s expenses, newest first, or those that match a search',
  description:
    'FR-INS-02. Every search term given must match: part of the merchant, a date range, an ' +
    'amount, a trip.',
  ...secured,
  request: { query: ExpenseSearchSchema },
  responses: {
    200: {
      description: 'The newest 100 expenses that match.',
      content: { 'application/json': { schema: ExpenseListSchema } },
    },
    ...common,
    400: problem('A search term is not valid.'),
  },
});

export const getExpenseRoute = createRoute({
  method: 'get',
  path: '/v1/expenses/{expenseId}',
  tags: ['Expenses'],
  summary: 'One expense, with what its receipt shows',
  ...secured,
  request: { params: expenseParam },
  responses: {
    200: {
      description: 'The expense.',
      content: { 'application/json': { schema: ExpenseDetailSchema } },
    },
    ...common,
    404: problem('No such expense in this organization.'),
  },
});

export const editExpenseRoute = createRoute({
  method: 'patch',
  path: '/v1/expenses/{expenseId}',
  tags: ['Expenses'],
  summary: 'Edit an expense',
  description:
    'FR-EXP-09, ADR-0022. Changes the fields sent and records who changed what. A reading of ' +
    'the receipt never overwrites an edit; where the expense now differs from its receipt, ' +
    'proof.differences says so.',
  ...secured,
  request: {
    params: expenseParam,
    body: { content: { 'application/json': { schema: EditExpenseSchema } }, required: true },
  },
  responses: {
    200: {
      description: 'The expense as it is now.',
      content: { 'application/json': { schema: ExpenseDetailSchema } },
    },
    ...common,
    404: problem('No such expense in this organization.'),
    409: problem(
      'It can’t be edited now: its receipt is being read, or it is submitted or later; or it is a drive, edited as mileage.',
    ),
    422: problem(
      'A value is not valid; field names which. With approval on, an amount above its ' +
        'receipt’s total is refused too (over_receipt).',
    ),
  },
});

export const setExpenseTripRoute = createRoute({
  method: 'put',
  path: '/v1/expenses/{expenseId}/trip',
  tags: ['Expenses'],
  summary: 'Choose an expense’s trip',
  description:
    'ADR-0023. Puts the expense on one of its owner’s trips, or on none ({"tripId": null}); ' +
    'filing by date leaves it there from then on. {"byDate": true} files it by date again.',
  ...secured,
  request: {
    params: expenseParam,
    body: { content: { 'application/json': { schema: SetExpenseTripSchema } }, required: true },
  },
  responses: {
    200: {
      description: 'The expense as it is now.',
      content: { 'application/json': { schema: ExpenseDetailSchema } },
    },
    ...common,
    404: problem('No such expense in this organization.'),
    409: problem(
      'It is submitted or later, so it stays with its report; or the trip is on a report ' +
        'submitted or later, which takes no more expenses (trip_submitted).',
    ),
    422: problem('No such trip, or the trip is another member’s.'),
  },
});

export const listRefundCandidatesRoute = createRoute({
  method: 'get',
  path: '/v1/expenses/{expenseId}/refund-candidates',
  tags: ['Expenses'],
  summary: 'The purchases a refund can be paired with',
  description:
    'FR-EXP-21, R-REFUND-DAYS. For a refund, an expense below zero: its owner’s purchases in ' +
    'its currency, dated on or up to 180 days before it, with enough left of them to give ' +
    'back, the likeliest first. Empty for an expense that isn’t a refund.',
  ...secured,
  request: { params: expenseParam },
  responses: {
    200: {
      description: 'The purchases it fits.',
      content: { 'application/json': { schema: RefundCandidatesSchema } },
    },
    ...common,
    404: problem('No such expense in this organization.'),
  },
});

export const setRefundOfRoute = createRoute({
  method: 'put',
  path: '/v1/expenses/{expenseId}/refund-of',
  tags: ['Expenses'],
  summary: 'Pair a refund with the purchase it refunds',
  description:
    'FR-EXP-21, ADR-0054. A refund counts only once it is paired: then it goes where its ' +
    'purchase goes, so the two net down on one claim, or on its owner’s open report when the ' +
    'purchase was claimed already. {"purchaseId": null} unpairs it, and it counts in no claim ' +
    'again.',
  ...secured,
  request: {
    params: expenseParam,
    body: { content: { 'application/json': { schema: SetRefundOfSchema } }, required: true },
  },
  responses: {
    200: {
      description: 'The refund as it is now.',
      content: { 'application/json': { schema: ExpenseDetailSchema } },
    },
    ...common,
    404: problem('No such expense, or no such purchase of the same person’s.'),
    409: problem('It is being read, or submitted or later, so its pairing can’t change.'),
    422: problem(
      'It isn’t a refund, or the purchase can’t take it: another currency, dated after it or ' +
        'more than 180 days before, or it would give back more than is left of the purchase.',
    ),
  },
});
