import { createRoute, z } from '@hono/zod-openapi';
import {
  EditMileageSchema,
  LogMileageSchema,
  MileageEntrySchema,
  MileageQuoteQuerySchema,
  MileageQuoteSchema,
  ProblemSchema,
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

const entry = (description: string) => ({
  description,
  content: { 'application/json': { schema: MileageEntrySchema } },
});

const OFF = 'Mileage is switched off for this organization (feature_off)';

export const quoteMileageRoute = createRoute({
  method: 'get',
  path: '/v1/mileage/quote',
  tags: ['Mileage'],
  summary: 'What a drive would pay, before it is logged',
  description:
    'FR-CAP-03, ADR-0038. The rate in force on the date and miles × rate, rounded half-up to ' +
    'the cent. Nothing is saved.',
  ...secured,
  request: { query: MileageQuoteQuerySchema },
  responses: {
    200: {
      description: 'The rate and the amount.',
      content: { 'application/json': { schema: MileageQuoteSchema } },
    },
    ...common,
    400: problem('The date or miles are missing.'),
    404: problem(`${OFF}.`),
    422: problem(
      'The date or miles are not valid, or no rate is known for the date; field names which.',
    ),
  },
});

export const logMileageRoute = createRoute({
  method: 'post',
  path: '/v1/mileage',
  tags: ['Mileage'],
  summary: 'Log a drive',
  description:
    'FR-CAP-03, NFR-DAT-04, ADR-0038. A Ready expense of the caller’s for miles × the rate in ' +
    'force on the date, with the rate copied onto it. It files to the caller’s trip its date ' +
    'falls in, and joins reports, as any expense does; its purpose is its justification.',
  ...secured,
  request: {
    body: { content: { 'application/json': { schema: LogMileageSchema } }, required: true },
  },
  responses: {
    201: entry('The drive, as an expense.'),
    ...common,
    404: problem(`${OFF}.`),
    422: problem('A value is not valid, or no rate is known for the date; field names which.'),
  },
});

export const getMileageRoute = createRoute({
  method: 'get',
  path: '/v1/mileage/{expenseId}',
  tags: ['Mileage'],
  summary: 'One of the caller’s drives',
  ...secured,
  request: { params: expenseParam },
  responses: {
    200: entry('The drive, as an expense.'),
    ...common,
    404: problem(`No such drive of the caller’s, or ${OFF.toLowerCase()}.`),
  },
});

export const editMileageRoute = createRoute({
  method: 'patch',
  path: '/v1/mileage/{expenseId}',
  tags: ['Mileage'],
  summary: 'Correct a drive before it is submitted',
  description:
    'ADR-0038. Changes the fields sent and records who changed what. A new date or new miles ' +
    'price it again at the rate in force on its date, copied on afresh; a new destination or ' +
    'purpose leaves the rate and amount as they are.',
  ...secured,
  request: {
    params: expenseParam,
    body: { content: { 'application/json': { schema: EditMileageSchema } }, required: true },
  },
  responses: {
    200: entry('The drive as it is now.'),
    ...common,
    404: problem(`No such drive of the caller’s, or ${OFF.toLowerCase()}.`),
    409: problem(
      'It is submitted or later, and an approved drive is corrected by a reversal; or it is a route drive, changed by its stops (route).',
    ),
    422: problem('A value is not valid; field names which.'),
  },
});
