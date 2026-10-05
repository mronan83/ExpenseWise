import { createRoute, z } from '@hono/zod-openapi';
import {
  AiProviderKeyListSchema,
  AiProviderKeyStatusSchema,
  AiProviderKeyTestSchema,
  AiProviderSchema,
  FeatureKeySchema,
  FeatureListSchema,
  FeatureSchema,
  ProblemSchema,
  SetAiProviderKeySchema,
  SwitchFeatureSchema,
  WorkspaceSchema,
} from '../schemas.ts';
import { SECOND_FACTOR_REFUSAL } from '../second-factor.ts';

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

/** A change to the keys: an admin action (FR-GOV-04). */
const adminOnly = {
  403: problem(
    'Only an owner or finance admin can manage AI provider keys.' + SECOND_FACTOR_REFUSAL,
  ),
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
    ...adminOnly,
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
    ...adminOnly,
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
    ...adminOnly,
    404: problem('No key is stored for this provider.'),
    503: problem('Sign-in or the database is not configured on this server.'),
  },
});

export const listFeaturesRoute = createRoute({
  method: 'get',
  path: '/v1/features',
  tags: ['Settings'],
  summary: "The organization's features",
  description:
    'Every feature that ships switched off, and whether it is on for the caller’s ' +
    'organization. Screens hide a feature that is off.',
  ...secured,
  responses: {
    200: {
      description: 'One entry per feature.',
      content: { 'application/json': { schema: FeatureListSchema } },
    },
    401: problem('Sign in required.'),
    403: problem('The caller has no organization yet: call POST /v1/me/organization first.'),
    503: problem('Sign-in or the database is not configured on this server.'),
  },
});

export const switchFeatureRoute = createRoute({
  method: 'put',
  path: '/v1/settings/features/{key}',
  tags: ['Settings'],
  summary: 'Switch a feature on or off',
  description:
    'For the whole organization, at once and without a release. Only the owner can switch a ' +
    'feature. The change is recorded in the audit log.',
  ...secured,
  request: {
    params: z.object({
      key: FeatureKeySchema.openapi({ param: { name: 'key', in: 'path' } }),
    }),
    body: { content: { 'application/json': { schema: SwitchFeatureSchema } }, required: true },
  },
  responses: {
    200: {
      description: 'The feature as it now is.',
      content: { 'application/json': { schema: FeatureSchema } },
    },
    400: problem('The request is not valid.'),
    401: problem('Sign in required.'),
    403: problem(
      'Only the owner can switch features.' +
        SECOND_FACTOR_REFUSAL +
        ' Switching the second factor itself on always needs it, so no one is locked out.',
    ),
    409: problem(
      'The server overrides this feature, so a switch here would have no effect ' +
        '(feature_overridden); or switching the second factor on would refuse the email ' +
        'used, as one not let in (second_factor_would_refuse_you).',
    ),
    503: problem('Sign-in or the database is not configured on this server.'),
  },
});
