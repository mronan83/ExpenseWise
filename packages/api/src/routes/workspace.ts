import { createRoute, z } from '@hono/zod-openapi';
import {
  AiProviderKeyListSchema,
  AiProviderKeyStatusSchema,
  AiProviderKeyTestSchema,
  AiProviderSchema,
  ProblemSchema,
  SetAiProviderKeySchema,
  WorkspaceSchema,
} from '../schemas.ts';

const problem = (description: string) => ({
  description,
  content: { 'application/problem+json': { schema: ProblemSchema } },
});

const secured = {
  security: [{ bearerAuth: [] }],
};

export const ensureWorkspaceRoute = createRoute({
  method: 'post',
  path: '/v1/me/organization',
  tags: ['Identity'],
  summary: "The caller's organization, created on first sign-in",
  description:
    'Returns the organization the signed-in user belongs to. On first sign-in it creates a ' +
    'one-person organization with the user as owner. Safe to call on every sign-in.',
  ...secured,
  responses: {
    200: {
      description: 'The existing organization.',
      content: { 'application/json': { schema: WorkspaceSchema } },
    },
    201: {
      description: 'A new organization was created.',
      content: { 'application/json': { schema: WorkspaceSchema } },
    },
    401: problem('Sign in required.'),
    422: problem('The account has no email address.'),
    503: problem('Sign-in or the database is not configured on this server.'),
  },
});

const providerParam = z.object({
  provider: AiProviderSchema.openapi({ param: { name: 'provider', in: 'path' } }),
});

const managerOnly = {
  403: problem('Only an owner or finance admin can manage AI provider keys.'),
};

export const listAiKeysRoute = createRoute({
  method: 'get',
  path: '/v1/settings/ai-providers',
  tags: ['Settings'],
  summary: 'AI provider keys',
  description:
    "Which AI providers have a key, the key's last four characters and when it last worked. " +
    'Keys themselves are never returned.',
  ...secured,
  responses: {
    200: {
      description: 'One entry per supported provider.',
      content: { 'application/json': { schema: AiProviderKeyListSchema } },
    },
    401: problem('Sign in required.'),
    ...managerOnly,
    503: problem('Sign-in, the database or encryption is not configured on this server.'),
  },
});

export const setAiKeyRoute = createRoute({
  method: 'put',
  path: '/v1/settings/ai-providers/{provider}',
  tags: ['Settings'],
  summary: 'Set the key for an AI provider',
  description:
    'Checks the key with the provider (listing models, which costs nothing), then stores it ' +
    'encrypted, replacing any earlier key. The change is recorded in the audit log.',
  ...secured,
  request: {
    params: providerParam,
    body: { content: { 'application/json': { schema: SetAiProviderKeySchema } }, required: true },
  },
  responses: {
    200: {
      description: 'The key works and is stored.',
      content: { 'application/json': { schema: AiProviderKeyStatusSchema } },
    },
    400: problem('The request is not valid.'),
    401: problem('Sign in required.'),
    ...managerOnly,
    422: problem('The provider rejected the key.'),
    502: problem('The provider could not be reached; nothing was stored.'),
    503: problem('Sign-in, the database or encryption is not configured on this server.'),
  },
});

export const testAiKeyRoute = createRoute({
  method: 'post',
  path: '/v1/settings/ai-providers/{provider}/test',
  tags: ['Settings'],
  summary: 'Check that a stored key still works',
  ...secured,
  request: { params: providerParam },
  responses: {
    200: {
      description: 'The result of a free call to the provider with the stored key.',
      content: { 'application/json': { schema: AiProviderKeyTestSchema } },
    },
    401: problem('Sign in required.'),
    ...managerOnly,
    404: problem('No key is stored for this provider.'),
    503: problem('Sign-in, the database or encryption is not configured on this server.'),
  },
});

export const deleteAiKeyRoute = createRoute({
  method: 'delete',
  path: '/v1/settings/ai-providers/{provider}',
  tags: ['Settings'],
  summary: 'Remove the key for an AI provider',
  ...secured,
  request: { params: providerParam },
  responses: {
    204: { description: 'The key is removed.' },
    401: problem('Sign in required.'),
    ...managerOnly,
    404: problem('No key is stored for this provider.'),
    503: problem('Sign-in or the database is not configured on this server.'),
  },
});
