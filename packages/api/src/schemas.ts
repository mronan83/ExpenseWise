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
