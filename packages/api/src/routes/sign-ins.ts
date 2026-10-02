import { createRoute, z } from '@hono/zod-openapi';
import { LinkSignInSchema, ProblemSchema, SignInListSchema, SignInSchema } from '../schemas.ts';

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

export const listSignInsRoute = createRoute({
  method: 'get',
  path: '/v1/me/sign-ins',
  tags: ['Identity'],
  summary: 'The ways the caller signs in',
  description:
    'Every sign-in (email) that reaches the same person in this organization. Each one sees ' +
    'the same receipts, expenses and settings.',
  ...secured,
  responses: {
    200: {
      description: "The caller's sign-ins, oldest first.",
      content: { 'application/json': { schema: SignInListSchema } },
    },
    ...common,
  },
});

export const linkSignInRoute = createRoute({
  method: 'post',
  path: '/v1/me/sign-ins',
  tags: ['Identity'],
  summary: 'Add another sign-in for the same person',
  description:
    'Links a second sign-in, such as a work email, to the caller. The body carries an access ' +
    'token for that sign-in, so the caller proves control of both. If the other sign-in had ' +
    'created its own organization and left it empty, it moves; otherwise nothing changes.',
  ...secured,
  request: {
    body: { content: { 'application/json': { schema: LinkSignInSchema } }, required: true },
  },
  responses: {
    200: {
      description: 'The sign-in was already linked to the caller.',
      content: { 'application/json': { schema: SignInSchema } },
    },
    201: {
      description: 'The sign-in now reaches the caller.',
      content: { 'application/json': { schema: SignInSchema } },
    },
    ...common,
    409: problem(
      'The other sign-in belongs to someone else here, or has its own organization with work in it.',
    ),
    422: problem(
      'The token is not a valid, recent sign-in with an email address, or it is the caller.',
    ),
  },
});

export const unlinkSignInRoute = createRoute({
  method: 'delete',
  path: '/v1/me/sign-ins/{signInId}',
  tags: ['Identity'],
  summary: 'Remove one of the caller’s sign-ins',
  ...secured,
  request: {
    params: z.object({
      signInId: z
        .string()
        .uuid()
        .openapi({ param: { name: 'signInId', in: 'path' } }),
    }),
  },
  responses: {
    204: { description: 'The sign-in no longer reaches this organization.' },
    ...common,
    404: problem('The caller has no such sign-in.'),
    409: problem('The sign-in making the request cannot remove itself.'),
  },
});
