import { SUPPORTED_CURRENCIES } from '@expensewise/domain';
import { z } from '@hono/zod-openapi';

/** RFC 9457 problem details. Every error response uses this shape. */
export const ProblemSchema = z
  .object({
    type: z.string().openapi({ example: 'https://expensewise.dev/problems/not-found' }),
    title: z.string().openapi({ example: 'Not found' }),
    status: z.number().int().openapi({ example: 404 }),
    detail: z.string().optional(),
    instance: z.string().optional(),
    code: z.string().optional().openapi({ description: 'Stable machine-readable error code.' }),
  })
  .openapi('Problem');

/** Money crosses the API as integer minor units, never as a float. */
export const MoneySchema = z
  .object({
    amountMinor: z.number().int().openapi({ example: 48936, description: 'Integer minor units.' }),
    currency: z.enum(SUPPORTED_CURRENCIES as [string, ...string[]]).openapi({ example: 'USD' }),
  })
  .openapi('Money');

export const HealthSchema = z
  .object({
    status: z.literal('ok'),
    version: z.string().openapi({ example: '3f9c2ab', description: 'Deployed commit, or "dev".' }),
  })
  .openapi('Health');

export const IdentitySchema = z
  .object({
    userId: z.string().openapi({ example: '6f1d2c3e-8a4b-4f5e-9c7d-0a1b2c3d4e5f' }),
    email: z.string().nullable().openapi({ example: 'alex@example.com' }),
    assuranceLevel: z.enum(['aal1', 'aal2']).openapi({
      description: 'aal2 means this session passed multi-factor authentication.',
    }),
    sessionId: z.string().nullable(),
  })
  .openapi('Identity');

const ReadinessCheckSchema = z
  .object({
    status: z.enum(['pass', 'fail', 'skip']),
    detail: z.string().openapi({ example: 'connected as expensewise_app' }),
  })
  .openapi('ReadinessCheck');

export const ReadinessSchema = z
  .object({
    ready: z.boolean().openapi({ description: 'True when no check failed.' }),
    checks: z.object({
      database: ReadinessCheckSchema,
      role: ReadinessCheckSchema,
      tls: ReadinessCheckSchema,
      tenantIsolation: ReadinessCheckSchema,
    }),
  })
  .openapi('Readiness');

export type Readiness = z.infer<typeof ReadinessSchema>;

export const OrganizationSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().openapi({ example: "alex's organization" }),
    homeCurrency: z.string().openapi({ example: 'USD' }),
  })
  .openapi('Organization');

export const WorkspaceSchema = z
  .object({
    organization: OrganizationSchema,
    member: z.object({
      id: z.string().uuid(),
      role: z.enum(['member', 'approver', 'finance_admin', 'owner', 'auditor']),
    }),
  })
  .openapi('Workspace');

export const AiProviderSchema = z.enum(['anthropic', 'openai']).openapi('AiProvider');

export const AiProviderKeyStatusSchema = z
  .object({
    provider: AiProviderSchema,
    configured: z.boolean(),
    keyHint: z
      .string()
      .nullable()
      .openapi({ example: 'gAAA', description: 'The last four characters of the stored key.' }),
    authScheme: z.enum(['api_key', 'bearer']).nullable().openapi({
      description: 'How the provider accepted the key: as an API key header or a bearer token.',
    }),
    verifiedAt: z.string().datetime().nullable(),
    updatedAt: z.string().datetime().nullable(),
  })
  .openapi('AiProviderKeyStatus');

export const AiProviderKeyListSchema = z
  .object({ providers: z.array(AiProviderKeyStatusSchema) })
  .openapi('AiProviderKeyList');

export const SetAiProviderKeySchema = z
  .object({
    apiKey: z.string().trim().min(8).max(1000).openapi({
      description:
        'The key from the provider. It is checked with the provider, then stored encrypted and never returned.',
    }),
  })
  .openapi('SetAiProviderKey');

export const AiProviderKeyTestSchema = z
  .object({
    valid: z.boolean(),
    status: AiProviderKeyStatusSchema,
    reason: z
      .enum(['rejected', 'unreachable', 'unreadable'])
      .optional()
      .openapi({ description: 'Why the key could not be used, when valid is false.' }),
  })
  .openapi('AiProviderKeyTest');

export const SignInSchema = z
  .object({
    id: z.string().uuid(),
    email: z.string().openapi({ example: 'alex@example.com' }),
    linkedAt: z.string().datetime(),
    current: z
      .boolean()
      .openapi({ description: 'Whether this is the sign-in making the request.' }),
  })
  .openapi('SignIn');

export const SignInListSchema = z.object({ signIns: z.array(SignInSchema) }).openapi('SignInList');

export const LinkSignInSchema = z
  .object({
    accessToken: z
      .string()
      .min(20)
      .max(8000)
      .openapi({
        description:
          'An access token for the other sign-in, from signing in with it moments ago. With the ' +
          "request's own token it proves the caller controls both. Used once, never stored.",
      }),
  })
  .openapi('LinkSignIn');
