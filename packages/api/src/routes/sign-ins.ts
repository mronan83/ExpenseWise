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

const signInParam = {
  params: z.object({
    signInId: z
      .string()
      .uuid()
      .openapi({ param: { name: 'signInId', in: 'path' } }),
  }),
};

export const letInSignInRoute = createRoute({
  method: 'put',
  path: '/v1/me/sign-ins/{signInId}/let-in',
  tags: ['Identity'],
  summary: 'Let another of the caller’s sign-ins in',
  description:
    'Behind security.second-factor (#90, Q44). Once a person has an authenticator, only a ' +
    'sign-in they let in opens the app; the others still forward receipts. From a sign-in let ' +
    'in, with an authenticator of its own, whose session passed the code (aal2), this lets ' +
    'another of theirs in: it may then add its own authenticator, and once it passes its code ' +
    'it signs in. Until then it waits, for 24 hours, after which letting it in lapses. Audited.',
  ...secured,
  request: signInParam,
  responses: {
    200: {
      description: 'The sign-in, let in: waiting until it passes its own code, or let in already.',
      content: { 'application/json': { schema: SignInSchema } },
    },
    401: common[401],
    403: problem(
      'The session has not passed the code (second_factor_required), or the caller has no organization.',
    ),
    404: problem('The caller has no such sign-in, or the second factor is switched off.'),
    409: problem(
      'It is the sign-in making the request, or that sign-in is not let in with an authenticator.',
    ),
    503: common[503],
  },
});

export const withdrawSignInRoute = createRoute({
  method: 'delete',
  path: '/v1/me/sign-ins/{signInId}/let-in',
  tags: ['Identity'],
  summary: 'Stop letting one of the caller’s other sign-ins in',
  description:
    'Behind security.second-factor (#90). From a sign-in let in, with an authenticator of its ' +
    'own, whose session passed the code (aal2), withdraws letting another of the person’s ' +
    'sign-ins in: it is refused again, and still forwards receipts. Audited.',
  ...secured,
  request: signInParam,
  responses: {
    204: { description: 'The sign-in is not let in.' },
    401: common[401],
    403: problem(
      'The session has not passed the code (second_factor_required), or the caller has no organization.',
    ),
    404: problem('The caller has no such sign-in, or the second factor is switched off.'),
    409: problem(
      'It is the sign-in making the request, or that sign-in is not let in with an authenticator.',
    ),
    503: common[503],
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
