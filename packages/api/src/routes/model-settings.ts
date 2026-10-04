import { createRoute, z } from '@hono/zod-openapi';
import { ProblemSchema } from '../schemas.ts';

const problem = (description: string) => ({
  description,
  content: { 'application/problem+json': { schema: ProblemSchema } },
});

const secured = { security: [{ bearerAuth: [] }] };

const ModelRecordSchema = z
  .object({
    readings: z.number().int().openapi({ description: 'Its latest readings of these receipts.' }),
    confident: z.number().int().openapi({
      description: 'Readings that would be Ready on their own, their sums and date included.',
    }),
    unsure: z.number().int(),
    failed: z.number().int(),
    averageLatencyMs: z.number().int().nullable(),
    costMicroUsd: z.number().int().openapi({ description: 'Spend in whole micro-dollars.' }),
  })
  .openapi('AiModelRecord');

const AiModelSchema = z
  .object({
    model: z.string().openapi({ example: 'claude-sonnet-5-5' }),
    label: z.string().openapi({ example: 'Sonnet 5.5' }),
    provider: z.enum(['anthropic', 'openai']),
    tier: z.string().openapi({ example: 'mid' }),
    price: z
      .object({
        input: z.string().openapi({ example: '2.00' }),
        output: z.string().openapi({ example: '10.00' }),
      })
      .openapi({ description: 'List price in US dollars per million tokens.' }),
    enabled: z.boolean().openapi({
      description: 'Switched on for the organization. A model whose provider has no key is off.',
    }),
    primary: z.boolean().openapi({ description: 'The one model chosen to read every receipt.' }),
    reads: z.enum(['primary', 'backup', 'off']).openapi({
      description:
        'What it does with the next receipt: primary reads it first; backup reads only when ' +
        'the models before it could not, in the order listed; off reads nothing, being ' +
        'switched off or stopped by the operator.',
    }),
    keyConfigured: z.boolean().openapi({
      description: 'Whether the organization has a key for its provider.',
    }),
    stopped: z.boolean().openapi({
      description: 'Stopped for every organization by the operator; it reads nothing meanwhile.',
    }),
    record: ModelRecordSchema.openapi({
      description: 'How it has read the organization’s latest receipts: the running comparison.',
    }),
  })
  .openapi('AiModel');

export const AiModelSettingsSchema = z
  .object({
    primary: z.string().nullable().openapi({
      description: 'The model that reads every receipt; null when every model is off.',
    }),
    models: z.array(AiModelSchema).openapi({
      description: 'Every model, in the order back-ups are tried.',
    }),
    saved: z.boolean().openapi({ description: 'False while the defaults apply.' }),
    updatedAt: z.string().datetime().nullable(),
    canChange: z.boolean().openapi({
      description: 'Whether the caller may change them: owners and finance admins.',
    }),
    comparison: z
      .object({
        receipts: z.number().int(),
        compared: z
          .number()
          .int()
          .openapi({ description: 'Receipts two models read side by side.' }),
        agreed: z.number().int().openapi({ description: 'Of those, how many they read alike.' }),
      })
      .openapi({ description: 'Over the latest 100 receipts, as Receipts shows it.' }),
  })
  .openapi('AiModelSettings');

export const SaveAiModelSettingsSchema = z
  .object({
    primary: z.string().nullable().openapi({
      description: 'A model that is on, or null to switch every model off.',
      example: 'claude-sonnet-5-5',
    }),
    models: z
      .array(z.object({ model: z.string(), enabled: z.boolean() }))
      .max(20)
      .openapi({ description: 'Every model once, in the order back-ups are tried.' }),
  })
  .openapi('SaveAiModelSettings');

const featureOff = problem('AI model settings are not switched on for this organization.');

export const getModelSettingsRoute = createRoute({
  method: 'get',
  path: '/v1/settings/ai-models',
  tags: ['Settings'],
  summary: 'Which AI models read receipts',
  description:
    'Each model, on or off, the primary that reads every receipt and the back-ups that read ' +
    'only when it cannot, with how each has read the organization’s receipts (FR-INT-16).',
  ...secured,
  responses: {
    200: {
      description: 'The organization’s models.',
      content: { 'application/json': { schema: AiModelSettingsSchema } },
    },
    401: problem('Sign in required.'),
    403: problem('The caller has no organization yet: call POST /v1/me/organization first.'),
    404: featureOff,
    503: problem('Sign-in or the database is not configured on this server.'),
  },
});

export const saveModelSettingsRoute = createRoute({
  method: 'put',
  path: '/v1/settings/ai-models',
  tags: ['Settings'],
  summary: 'Choose which AI models read receipts',
  description:
    'Switches each model on or off and chooses the primary, for the whole organization, from ' +
    'the next reading on. Only owners and finance admins can. The change is recorded in the ' +
    'audit log.',
  ...secured,
  request: {
    body: {
      content: { 'application/json': { schema: SaveAiModelSettingsSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description: 'The organization’s models as they now are.',
      content: { 'application/json': { schema: AiModelSettingsSchema } },
    },
    400: problem('The request is not valid.'),
    401: problem('Sign in required.'),
    403: problem('Only an owner or finance admin can choose the models.'),
    404: featureOff,
    422: problem(
      'A model is unknown or listed twice, the primary is not on, or a model is switched on ' +
        'without a key for its provider.',
    ),
    503: problem('Sign-in or the database is not configured on this server.'),
  },
});
