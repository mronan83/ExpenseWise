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
