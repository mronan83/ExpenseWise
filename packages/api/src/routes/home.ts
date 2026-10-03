import { createRoute } from '@hono/zod-openapi';
import { HomeQuerySchema, HomeSchema, ProblemSchema } from '../schemas.ts';

const problem = (description: string) => ({
  description,
  content: { 'application/problem+json': { schema: ProblemSchema } },
});

export const homeRoute = createRoute({
  method: 'get',
  path: '/v1/home',
  tags: ['Home'],
  summary: 'Home: what needs the person, then their trip, month and recent trips',
  description:
    'Everything Home shows, read at once so its sections agree, and only the person’s own ' +
    'records (FR-INS-01). Needs you comes first; it is the inbox (FR-EXP-02).',
  security: [{ bearerAuth: [] }],
  request: { query: HomeQuerySchema },
  responses: {
    200: {
      description: 'Home for the day asked for.',
      content: { 'application/json': { schema: HomeSchema } },
    },
    400: problem('The day is not a date that exists.'),
    401: problem('Sign in required.'),
    403: problem('The caller has no organization yet: call POST /v1/me/organization first.'),
    503: problem('Sign-in or the database is not configured on this server.'),
  },
});
