import { createRoute, z } from '@hono/zod-openapi';
import { CompanyPaysSchema, SetCompanyPaysSchema } from '../category-schemas.ts';
import { ExpenseDetailSchema, ProblemSchema, SetPaidBySchema } from '../schemas.ts';
import { SECOND_FACTOR_REFUSAL } from '../second-factor.ts';

/*
 * Paid by the company (F-62, FR-EXP-17, FR-EXP-18, ADR-0045). Both routes answer 404
 * feature_off while `expenses.company-paid` is off for the organization.
 */

const problem = (description: string) => ({
  description,
  content: { 'application/problem+json': { schema: ProblemSchema } },
});

const secured = { security: [{ bearerAuth: [] }] };

const common = {
  401: problem('Sign in required.'),
  503: problem('Sign-in or the database is not configured on this server.'),
};

const pathId = (name: string) =>
  z
    .string()
    .uuid()
    .openapi({ param: { name, in: 'path' } });

export const setPaidByRoute = createRoute({
  method: 'put',
  path: '/v1/expenses/{expenseId}/paid-by',
  tags: ['Expenses'],
  summary: 'Say who paid an expense: you, or the company directly',
  description:
    'FR-EXP-17, Q46. {"paidBy": "company"} or {"paidBy": "claimant"} sets it by hand, and the ' +
    'organization’s policy for its type leaves it so from then on; {"byPolicy": true} hands it ' +
    'back to the policy, which applies at once. An expense the company paid stays on its trip ' +
    'and in the trip’s cost, and is never claimed. Only the expense’s own member sets it ' +
    '(ADR-0035), and only before it is submitted. A closed report it is on opens again. ' +
    'Recorded in the audit log.',
  ...secured,
  request: {
    params: z.object({ expenseId: pathId('expenseId') }),
    body: { content: { 'application/json': { schema: SetPaidBySchema } }, required: true },
  },
  responses: {
    200: {
      description: 'The expense as it is now.',
      content: { 'application/json': { schema: ExpenseDetailSchema } },
    },
    ...common,
    400: problem('The request is not valid.'),
    403: problem(
      'The caller has no organization yet, or the expense is another member’s (not_yours).',
    ),
    404: problem('No such expense in this organization, or the feature is off (feature_off).'),
    409: problem(
      'It is submitted or later, so who paid it stays as it went in (locked); or it is a drive, ' +
        'paid at miles × its rate to whoever drove, never by the company (mileage).',
    ),
  },
});

export const setCompanyPaysRoute = createRoute({
  method: 'put',
  path: '/v1/settings/expense-types/{typeId}/company-pays',
  tags: ['Categories'],
  summary: 'Say whether the company pays a type directly',
  description:
    'FR-EXP-18, Q46, Q48. The organization’s policy, by type: an expense of a type the company ' +
    'pays, such as Airfare an employer books, is paid by the company unless a person set it ' +
    'by hand. In the same transaction every expense of the type not set by hand and not yet ' +
    'submitted follows the change; a submitted, approved or settled one never changes, nor a ' +
    'drive. One audit event names the change and every expense that switched. Needs ' +
    '`expenses.categories` on too.',
  ...secured,
  request: {
    params: z.object({ typeId: pathId('typeId') }),
    body: { content: { 'application/json': { schema: SetCompanyPaysSchema } }, required: true },
  },
  responses: {
    200: {
      description: 'The type as it is now, and how many expenses followed the change.',
      content: { 'application/json': { schema: CompanyPaysSchema } },
    },
    ...common,
    400: problem('The request is not valid.'),
    403: problem(
      'The caller has no organization yet, or isn’t an owner or finance admin.' +
        SECOND_FACTOR_REFUSAL,
    ),
    404: problem('No such type in this organization, or a feature is off (feature_off).'),
  },
});
