import { isIsoDate, OWN_RATE_PLACES } from '@expensewise/domain';
import { z } from '@hono/zod-openapi';
import { MileageRateSchema } from './schemas.ts';

/*
 * The rate a mile an organization pays drives at (Q28, #77): the IRS business rate by default,
 * or its own from a day an owner or finance admin chooses. Behind `expenses.mileage`.
 */

const day = (description: string) =>
  z
    .string()
    .refine(isIsoDate, 'Enter a date that exists, as YYYY-MM-DD.')
    .openapi({ format: 'date', example: '2026-11-01', description });

export const MileageRateChangeSchema = z
  .object({
    effectiveFrom: day('The first travel date it applies to.'),
    source: z.enum(['organization', 'irs-business']).openapi({
      description: 'organization: its own rate a mile. irs-business: the IRS rate again.',
    }),
    perMile: z.string().nullable().openapi({
      example: '0.65',
      description: 'Its own rate a mile, as a plain decimal; null for the IRS rate.',
    }),
    currency: z.string().nullable().openapi({
      example: 'USD',
      description: 'The home currency it was set in; null for the IRS rate.',
    }),
    setBy: z.string().openapi({ description: 'Who set it last.' }),
    setAt: z.string().datetime({ offset: true }),
  })
  .openapi('MileageRateChange');

export const MileageRatesSchema = z
  .object({
    today: day('The day the rate in force is for: today in UTC.'),
    inForce: z
      .object({
        rate: MileageRateSchema.nullable().openapi({
          description: 'What a drive dated today is paid at, and where that rate comes from.',
        }),
        problem: z.string().nullable().openapi({
          description: 'Why there is none: the IRS rate for today isn’t known yet.',
        }),
      })
      .openapi({ description: 'The rate in force today.' }),
    changes: z.array(MileageRateChangeSchema).openapi({
      description: 'Each day the organization changed the rate from, the latest first.',
    }),
    homeCurrency: z.string().openapi({
      example: 'USD',
      description: 'What a rate of the organization’s own is set in.',
    }),
    irsThrough: day('The last day ExpenseWise knows the IRS rate for.'),
    canChange: z.boolean().openapi({
      description: 'Whether the caller may change it: owners and finance admins.',
    }),
  })
  .openapi('MileageRates');

export const SetMileageRateSchema = z
  .object({
    perMile: z
      .string()
      .max(40)
      .nullable()
      .openapi({
        example: '0.65',
        description:
          `The organization’s own rate a mile in its home currency: more than 0, ` +
          `${OWN_RATE_PLACES} decimal places at most. null goes back to the IRS business rate.`,
      }),
  })
  .strict()
  .openapi('SetMileageRate');

export const MileageRateDayParamSchema = z.object({
  effectiveFrom: z
    .string()
    .max(40)
    .openapi({
      param: { name: 'effectiveFrom', in: 'path' },
      example: '2026-11-01',
      description: 'YYYY-MM-DD: the first travel date the change applies to.',
    }),
});
