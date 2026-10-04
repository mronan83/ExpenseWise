import { createRoute } from '@hono/zod-openapi';
import {
  ProblemSchema,
  ReimbursementCurrencySchema,
  SetReimbursementCurrencySchema,
} from '../schemas.ts';

const problem = (description: string) => ({
  description,
  content: { 'application/problem+json': { schema: ProblemSchema } },
});

const secured = { security: [{ bearerAuth: [] }] };

const common = {
  401: problem('Sign in required.'),
  403: problem('The caller has no organization yet: call POST /v1/me/organization first.'),
  404: problem('Currency conversion is not switched on (`feature_off`).'),
  503: problem('Sign-in or the database is not configured on this server.'),
};

export const getReimbursementCurrencyRoute = createRoute({
  method: 'get',
  path: '/v1/me/reimbursement-currency',
  tags: ['Reports'],
  summary: 'The currency the caller is reimbursed in',
  description:
    'Their reports convert every amount to it, at the purchase date’s reference rate ' +
    '(FR-EXP-13, Q23, Q25). Until they choose, it is the organization’s home currency.',
  ...secured,
  responses: {
    200: {
      description: 'Their reimbursement currency, and the currencies to choose from.',
      content: { 'application/json': { schema: ReimbursementCurrencySchema } },
    },
    ...common,
  },
});

export const setReimbursementCurrencyRoute = createRoute({
  method: 'put',
  path: '/v1/me/reimbursement-currency',
  tags: ['Reports'],
  summary: 'Choose the currency the caller is reimbursed in',
  description:
    'Their open and closed reports move to it and are converted again in the background; a ' +
    'submitted report keeps its currency. Null goes back to the organization’s home currency.',
  ...secured,
  request: {
    body: { content: { 'application/json': { schema: SetReimbursementCurrencySchema } } },
  },
  responses: {
    200: {
      description: 'Their reimbursement currency now.',
      content: { 'application/json': { schema: ReimbursementCurrencySchema } },
    },
    400: problem('Not a currency the app supports.'),
    ...common,
  },
});
