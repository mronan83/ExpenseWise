import { createRoute, z } from '@hono/zod-openapi';
import { InboxSchema, ProblemSchema } from '../schemas.ts';

const problem = (description: string) => ({
  description,
  content: { 'application/problem+json': { schema: ProblemSchema } },
});

export const inboxRoute = createRoute({
  method: 'get',
  path: '/v1/inbox',
  tags: ['Inbox'],
  summary: 'What needs the person: the Needs you inbox',
  description:
    'What needs the person, each with why (FR-EXP-02): a report overdue or in its last week ' +
    'with something left; receipts that need a look or that no model could read, newest ' +
    'first; while they are on, emails from the person’s own address that filed nothing (#59); ' +
    'local expenses needing a justification; and reports ready to close (FR-EXP-12, ' +
    'FR-EXP-14). Missing receipts and returned reports join it as they are built.',
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: 'Up to 100 items, newest first. Empty when nothing needs the person.',
      content: { 'application/json': { schema: InboxSchema } },
    },
    401: problem('Sign in required.'),
    403: problem('The caller has no organization yet: call POST /v1/me/organization first.'),
    503: problem('Sign-in or the database is not configured on this server.'),
  },
});

export const dismissEmailRoute = createRoute({
  method: 'post',
  path: '/v1/inbox/emails/{emailId}/dismiss',
  tags: ['Inbox'],
  summary: 'Dismiss an email that filed nothing from Needs you',
  description:
    'It leaves Needs you for good, and the audit trail records who dismissed it. The email is ' +
    'kept as it arrived. Only the person it came from dismisses it (#59, ADR-0035). Dismissing ' +
    'one already dismissed changes nothing.',
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      emailId: z
        .string()
        .uuid()
        .openapi({ param: { name: 'emailId', in: 'path' } }),
    }),
  },
  responses: {
    204: { description: 'Dismissed.' },
    401: problem('Sign in required.'),
    403: problem(
      'The caller has no organization yet, or the email is someone else’s, or the caller is ' +
        'an auditor, who changes nothing (not_yours).',
    ),
    404: problem(
      'No such email that filed nothing, or emails that filed nothing are switched off there.',
    ),
    503: problem('Sign-in or the database is not configured on this server.'),
  },
});
