import { createRoute, z } from '@hono/zod-openapi';
import {
  EditExpenseSchema,
  ExpenseDetailSchema,
  ExpenseListSchema,
  ExpenseSearchSchema,
  ProblemSchema,
  SetExpenseTripSchema,
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
