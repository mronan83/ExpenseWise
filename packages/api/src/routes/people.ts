import { createRoute, z } from '@hono/zod-openapi';
import {
  ChangeRoleSchema,
  CreatedInviteSchema,
  CreateInviteSchema,
  InviteAcceptedSchema,
  InvitePreviewSchema,
  InviteTokenSchema,
  PeopleSchema,
  PersonSchema,
} from '../people-schemas.ts';
import { ProblemSchema } from '../schemas.ts';

const problem = (description: string) => ({
  description,
  content: { 'application/problem+json': { schema: ProblemSchema } },
});

const secured = { security: [{ bearerAuth: [] }] };

const ownerOnly = {
  401: problem('Sign in required.'),
  403: problem('Only an owner manages people, or the caller has no organization yet.'),
  404: problem('Inviting people is not switched on (feature_off), or no such person or invite.'),
  503: problem('Sign-in or the database is not configured on this server.'),
};

const json = <T>(description: string, schema: T) => ({
  description,
  content: { 'application/json': { schema } },
});

const memberParam = z.object({
  memberId: z
    .string()
    .uuid()
    .openapi({ param: { name: 'memberId', in: 'path' } }),
});

export const listPeopleRoute = createRoute({
  method: 'get',
  path: '/v1/settings/people',
  tags: ['Settings'],
  summary: 'The people in the organization, and its invite links',
  description:
    'Everyone in the organization with their role, people removed too (their records stay), ' +
    'and invite links not yet used or revoked. Owners only, behind team.invites.',
  ...secured,
  responses: { 200: json('People and invites.', PeopleSchema), ...ownerOnly },
});

export const createInviteRoute = createRoute({
  method: 'post',
  path: '/v1/settings/people/invites',
  tags: ['Settings'],
  summary: 'Make an invite link',
  description:
    'A link that lets one signed-in person join with the role given, for 7 days. No email is ' +
    'sent: the owner passes the link on. Its secret is returned this once; only its hash is ' +
    'kept. Sign-ups are off, so the person’s account is made in Supabase first.',
  ...secured,
  request: {
    body: { content: { 'application/json': { schema: CreateInviteSchema } }, required: true },
  },
  responses: { 201: json('The invite and its link.', CreatedInviteSchema), ...ownerOnly },
});

export const revokeInviteRoute = createRoute({
  method: 'delete',
  path: '/v1/settings/people/invites/{inviteId}',
  tags: ['Settings'],
  summary: 'Revoke an invite link',
  ...secured,
  request: {
    params: z.object({
      inviteId: z
        .string()
        .uuid()
        .openapi({ param: { name: 'inviteId', in: 'path' } }),
    }),
  },
  responses: {
    204: { description: 'The link no longer works.' },
    ...ownerOnly,
    409: problem('The invite was already used.'),
  },
});

export const changeRoleRoute = createRoute({
  method: 'patch',
  path: '/v1/settings/people/{memberId}',
  tags: ['Settings'],
  summary: 'Give someone another role',
  ...secured,
  request: {
    params: memberParam,
    body: { content: { 'application/json': { schema: ChangeRoleSchema } }, required: true },
  },
  responses: {
    200: json('The person, with their new role.', PersonSchema),
    ...ownerOnly,
    409: problem('They are the last owner: the organization always has one.'),
  },
});

export const removePersonRoute = createRoute({
  method: 'delete',
  path: '/v1/settings/people/{memberId}',
  tags: ['Settings'],
  summary: 'Remove someone from the organization',
  description:
    'They can no longer sign in here. Their receipts, expenses, trips, reports and history ' +
    'stay. Never the last owner, and never the caller.',
  ...secured,
  request: { params: memberParam },
  responses: {
    204: { description: 'They are removed.' },
    ...ownerOnly,
    409: problem('They are the last owner, or the caller.'),
  },
});

const tokenBody = {
  body: { content: { 'application/json': { schema: InviteTokenSchema } }, required: true },
};

const holder = {
  401: problem('Sign in required.'),
  404: problem('No invite has this link, or inviting people is switched off there.'),
  503: problem('Sign-in or the database is not configured on this server.'),
};

export const lookUpInviteRoute = createRoute({
  method: 'post',
  path: '/v1/invites/look-up',
  tags: ['Identity'],
  summary: 'What an invite link offers the signed-in person',
  description:
    'The organization and role a link offers, whether it still works, and where the caller ' +
    'stands. Reads only.',
  ...secured,
  request: tokenBody,
  responses: { 200: json('The invite.', InvitePreviewSchema), ...holder },
});

export const acceptInviteRoute = createRoute({
  method: 'post',
  path: '/v1/invites/accept',
  tags: ['Identity'],
  summary: 'Join an organization by its invite link',
  description:
    'The signed-in person joins with the link’s role, once. An empty one-person organization ' +
    'their first sign-in made is left behind; one with work or other people in it stops them ' +
    'joining, and nothing changes.',
  ...secured,
  request: tokenBody,
  responses: {
    200: json('They are a member now.', InviteAcceptedSchema),
    ...holder,
    409: problem('Already a member here, or their own organization has work in it.'),
    410: problem('The link expired, was revoked or was already used.'),
    422: problem('The account has no email address.'),
  },
});
