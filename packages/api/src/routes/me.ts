import { createRoute } from '@hono/zod-openapi';
import { IdentitySchema, ProblemSchema } from '../schemas.ts';

export const meRoute = createRoute({
  method: 'get',
  path: '/v1/me',
  tags: ['Identity'],
  summary: 'The signed-in user',
  description:
    'Returns the identity proven by the access token. Organization memberships join this ' +
    'response in Phase 1.',
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: 'The caller is signed in.',
      content: { 'application/json': { schema: IdentitySchema } },
    },
    401: {
      description: 'No token, or the token is invalid or expired.',
      content: { 'application/problem+json': { schema: ProblemSchema } },
    },
    503: {
      description: 'Sign-in is not configured on this server.',
      content: { 'application/problem+json': { schema: ProblemSchema } },
    },
  },
});
