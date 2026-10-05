import { createRoute } from '@hono/zod-openapi';
import {
  MileageRateDayParamSchema,
  MileageRatesSchema,
  SetMileageRateSchema,
} from '../mileage-rate-schemas.ts';
import { ProblemSchema } from '../schemas.ts';
import { SECOND_FACTOR_REFUSAL } from '../second-factor.ts';

const problem = (description: string) => ({
  description,
  content: { 'application/problem+json': { schema: ProblemSchema } },
});

const secured = { security: [{ bearerAuth: [] }] };

const common = {
  401: problem('Sign in required.'),
  503: problem('Sign-in or the database is not configured on this server.'),
};

const rates = (description: string) => ({
  description,
  content: { 'application/json': { schema: MileageRatesSchema } },
});

const OFF = 'Mileage is switched off for this organization (feature_off).';

export const getMileageRatesRoute = createRoute({
  method: 'get',
  path: '/v1/mileage-rates',
  tags: ['Mileage'],
  summary: 'The rate a mile drives are paid at, and its changes',
  description:
    'Q28, NFR-DAT-04. The rate in force today and where it comes from, the IRS business rate ' +
    'or the organization’s own, and each day the organization changed it from. Every member ' +
    'reads it.',
  ...secured,
  responses: {
    200: rates('The rate in force today, and the changes, the latest day first.'),
    ...common,
    403: problem('The caller has no organization yet: call POST /v1/me/organization first.'),
    404: problem(OFF),
  },
});

export const setMileageRateRoute = createRoute({
  method: 'put',
  path: '/v1/settings/mileage-rates/{effectiveFrom}',
  tags: ['Mileage'],
  summary: 'Set the rate a mile from a day, or go back to the IRS rate',
  description:
    'Q28, NFR-DAT-04. Owners and finance admins only. From the day given, drives are paid at ' +
    'the organization’s own rate a mile in its home currency, or with perMile null at the IRS ' +
    'business rate again. Setting a day again replaces its change. Drives already logged keep ' +
    'the rate they were paid at; each change is in the audit trail.',
  ...secured,
  request: {
    params: MileageRateDayParamSchema,
    body: { content: { 'application/json': { schema: SetMileageRateSchema } }, required: true },
  },
  responses: {
    200: rates('The rate in force today, and the changes, with this one.'),
    ...common,
    400: problem('The body is not valid.'),
    403: problem(
      'The caller has no organization yet, or is not an owner or finance admin (forbidden_role).' +
        SECOND_FACTOR_REFUSAL,
    ),
    404: problem(OFF),
    422: problem('The day or the rate is not valid; field names which.'),
  },
});
