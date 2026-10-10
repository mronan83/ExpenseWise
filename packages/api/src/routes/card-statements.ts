import { createRoute, z } from '@hono/zod-openapi';
import {
  CardStatementsSchema,
  FileStatementSchema,
  MatchableExpensesSchema,
  MatchAgainResultSchema,
  MatchToExpenseSchema,
  SetAsideSchema,
  StatementListRequestSchema,
  StatementFileLinkSchema,
  StatementListResultSchema,
  StatementUploadRequestSchema,
  StatementUploadTicketSchema,
} from '../card-statement-schemas.ts';
import { ProblemSchema } from '../schemas.ts';

/*
 * Card statements (FR-CAP-10) and matching their transactions to expenses (FR-INT-24), behind
 * `expenses.card-statements`. Each route answers 404 feature_off while it is off for the
 * organization (ADR-0046). A statement and its transactions are their member's own (ADR-0035).
 */

const problem = (description: string) => ({
  description,
  content: { 'application/problem+json': { schema: ProblemSchema } },
});

const secured = { security: [{ bearerAuth: [] }] };
const tags = ['Card statements'];

const json = <T extends z.ZodType>(schema: T) => ({
  content: { 'application/json': { schema } },
  required: true,
});
const answer = <T extends z.ZodType>(description: string, schema: T) => ({
  description,
  content: { 'application/json': { schema } },
});

const pathId = (name: string) =>
  z
    .string()
    .uuid()
    .openapi({ param: { name, in: 'path' } });
const statementParams = z.object({ statementId: pathId('statementId') });
const transactionParams = z.object({ transactionId: pathId('transactionId') });

const common = {
  401: problem('Sign in required.'),
  403: problem(
    'The caller has no organization yet, or it is another member’s, which only its member ' +
      'changes (not_yours).',
  ),
  404: problem('No such statement or transaction, or the feature is off (feature_off).'),
  503: problem('Sign-in, the database or file storage is not configured on this server.'),
};

const statements = answer(
  'The person’s statements and transactions, after the change.',
  CardStatementsSchema,
);

export const statementUploadRoute = createRoute({
  method: 'post',
  path: '/v1/card-statements/uploads',
  tags,
  summary: 'Get a one-time upload for a statement PDF',
  description: 'Returns a path and token the client uploads the PDF to directly, as for a receipt.',
  ...secured,
  request: { body: json(StatementUploadRequestSchema) },
  responses: {
    201: answer('Upload the PDF here, then file it.', StatementUploadTicketSchema),
    ...common,
  },
});

export const fileStatementRoute = createRoute({
  method: 'post',
  path: '/v1/card-statements',
  tags,
  summary: 'Bring in an uploaded statement PDF',
  description:
    'US-CAP-07 AC1. Records the statement and the event that has it read, in one transaction. ' +
    'It is read by the organization’s primary AI model, or a back-up when the primary can’t, ' +
    'its transactions kept and matched. Safe to retry with the same id.',
  ...secured,
  request: { body: json(FileStatementSchema) },
  responses: {
    200: answer(
      'Already brought in: a retried request, or the same PDF brought in before.',
      CardStatementsSchema,
    ),
    202: answer('Brought in; it is being read.', CardStatementsSchema),
    ...common,
  },
});

export const statementListRoute = createRoute({
  method: 'post',
  path: '/v1/card-statements/lists',
  tags,
  summary: 'Bring in a downloaded transaction list',
  description:
    'US-CAP-07 AC6. Reads a CSV or tab-separated list in the request, with no model: its ' +
    'columns found by their names, payments to the card left out. Its transactions are kept ' +
    'and matched at once. The same list again changes nothing.',
  ...secured,
  request: { body: json(StatementListRequestSchema) },
  responses: {
    201: answer('Brought in and matched.', StatementListResultSchema),
    200: answer('The same list was brought in before; nothing changed.', StatementListResultSchema),
    ...common,
    422: problem(
      'It isn’t a transaction list: empty, no_columns (no date, merchant and amount columns), ' +
        'no_rows (no row read as a transaction) or too_many_rows; or unknown_currency.',
    ),
  },
});

export const listStatementsRoute = createRoute({
  method: 'get',
  path: '/v1/card-statements',
  tags,
  summary: 'The person’s card statements and their transactions',
  ...secured,
  responses: { 200: statements, ...common },
});

export const confirmStatementRoute = createRoute({
  method: 'post',
  path: '/v1/card-statements/{statementId}/confirm',
  tags,
  summary: 'Take a statement that needed a look as read, and match it',
  description: 'US-CAP-07 AC5: once the person has looked at what it says doesn’t add up.',
  ...secured,
  request: { params: statementParams },
  responses: {
    200: statements,
    ...common,
    409: problem('It isn’t waiting for a look (not_waiting).'),
  },
});

export const deleteStatementRoute = createRoute({
  method: 'delete',
  path: '/v1/card-statements/{statementId}',
  tags,
  summary: 'Delete a statement brought in by mistake, with its transactions',
  ...secured,
  request: { params: statementParams },
  responses: { 200: statements, ...common },
});

export const statementFileRoute = createRoute({
  method: 'get',
  path: '/v1/card-statements/{statementId}/file',
  tags,
  summary: 'Open a statement’s PDF',
  description:
    'US-CAP-07 AC15. A link to the person’s own statement PDF as brought in, signed for five ' +
    'minutes, to check its lines against. A downloaded list keeps no file: 404 no_file.',
  ...secured,
  request: { params: statementParams },
  responses: {
    200: answer('A short-lived link to the PDF.', StatementFileLinkSchema),
    ...common,
  },
});

export const matchAgainRoute = createRoute({
  method: 'post',
  path: '/v1/card-statements/match',
  tags,
  summary: 'Match the person’s open transactions again',
  description:
    'FR-INT-24. Matching runs when a statement is read and when a receipt is read; this runs it ' +
    'after expenses typed in by hand.',
  ...secured,
  responses: { 200: answer('How many were matched.', MatchAgainResultSchema), ...common },
});

export const setAsideRoute = createRoute({
  method: 'put',
  path: '/v1/card-transactions/{transactionId}/set-aside',
  tags,
  summary: 'Say why a charge has no expense',
  description:
    'US-CAP-07 AC3. It is no longer a missing receipt. One set aside already takes the new ' +
    'reason. Each change is in the audit trail.',
  ...secured,
  request: { params: transactionParams, body: json(SetAsideSchema) },
  responses: {
    200: statements,
    ...common,
    409: problem('It pays for an expense: let it go first (matched).'),
    422: problem('A reason, or the note other needs, is not valid; field names which.'),
  },
});

export const bringBackRoute = createRoute({
  method: 'delete',
  path: '/v1/card-transactions/{transactionId}/set-aside',
  tags,
  summary: 'Bring a charge set aside back as a missing receipt',
  ...secured,
  request: { params: transactionParams },
  responses: { 200: statements, ...common },
});

export const matchToExpenseRoute = createRoute({
  method: 'put',
  path: '/v1/card-transactions/{transactionId}/expense',
  tags,
  summary: 'Match a charge to an expense the person chose',
  description:
    'FR-INT-24. Any of the person’s expenses not paid by another charge, whatever its amount ' +
    'or currency: a tip added later, or a charge abroad.',
  ...secured,
  request: { params: transactionParams, body: json(MatchToExpenseSchema) },
  responses: {
    200: statements,
    ...common,
    409: problem(
      'set_aside: bring it back first. not_matchable: the expense isn’t the person’s, or has no ' +
        'receipt. An expense another charge already pays for can take this one too (ADR-0051).',
    ),
  },
});

export const unmatchRoute = createRoute({
  method: 'delete',
  path: '/v1/card-transactions/{transactionId}/expense',
  tags,
  summary: 'Let a charge go of its expense',
  ...secured,
  request: { params: transactionParams },
  responses: { 200: statements, ...common },
});

export const matchableRoute = createRoute({
  method: 'get',
  path: '/v1/card-transactions/{transactionId}/expenses',
  tags,
  summary: 'Expenses a charge might be matched to',
  ...secured,
  request: { params: transactionParams },
  responses: { 200: answer('Nearest first.', MatchableExpensesSchema), ...common },
});
