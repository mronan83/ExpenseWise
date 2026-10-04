import {
  PLACE_NAME_MAX,
  ROUTE_ADDRESS_MAX,
  ROUTE_MAX_STOPS,
  ROUTE_REASON_MAX,
} from '@expensewise/domain';
import { z } from '@hono/zod-openapi';
import { MileageEntrySchema } from './schemas.ts';

/*
 * Route-based mileage (FR-CAP-04, ADR-0039), behind `expenses.route-mileage`: a drive by its
 * stops, measured by OpenRouteService with the organization's own key, saved places, and the
 * miles claimed with a reason when they differ from those measured (Q31 to Q33).
 */

export const RouteStopSchema = z
  .object({
    address: z.string().openapi({
      example: '12 Elm St, Omaha, NE',
      description: 'As typed: what is sent to be measured (Q32).',
    }),
    place: z
      .object({
        label: z.string().openapi({ example: '12 Elm Street, Omaha, NE, USA' }),
        longitude: z.string().openapi({ example: '-95.934502' }),
        latitude: z.string().openapi({ example: '41.256537' }),
      })
      .nullable()
      .openapi({ description: 'Where it was found, once measured.' }),
    legMetres: z.number().int().nullable().openapi({
      description: 'The leg to it from the stop before, in whole metres; null for the start.',
    }),
  })
  .openapi('RouteStop');

export const RouteSchema = z
  .object({
    status: z.enum(['measuring', 'measured', 'failed']).openapi({
      description:
        'measuring: asked for, not done yet. measured: the distance below. failed: not measured, ' +
        'for the reason in problem; fix a stop and measure it again, or claim miles by hand.',
    }),
    problem: z.string().nullable().openapi({ description: 'Why it was not measured.' }),
    roundTrip: z.boolean().openapi({ description: 'It returns to the start after the end.' }),
    stops: z.array(RouteStopSchema).openapi({ description: 'In order: the start first.' }),
    returnMetres: z.number().int().nullable().openapi({
      description: 'The way back from the end to the start, on a round trip.',
    }),
    measured: z
      .object({
        metres: z.number().int().openapi({ example: 61800 }),
        miles: z.string().openapi({
          example: '38.4',
          description: 'The metres in hundredths of a mile, rounded half up.',
        }),
        provider: z.enum(['openrouteservice']),
        profile: z.string().openapi({ example: 'driving-car' }),
        measuredAt: z.string().datetime(),
      })
      .nullable()
      .openapi({ description: 'How it was measured, copied onto the claim (NFR-DAT-04).' }),
    claimedMiles: z.string().nullable().openapi({
      example: '41',
      description: 'The miles claimed and paid; null until measured or entered by hand.',
    }),
    reason: z.string().nullable().openapi({
      description: 'Why the miles claimed differ from those measured, or were entered by hand.',
    }),
    attribution: z.string().openapi({
      example: 'Route © openrouteservice.org by HeiGIT · Map data © OpenStreetMap contributors',
      description: 'To show wherever the measured route is.',
    }),
  })
  .openapi('Route');

export const RouteDriveSchema = MileageEntrySchema.extend({ route: RouteSchema }).openapi(
  'RouteDrive',
);

const stops = z
  .array(z.string().max(1000))
  .min(1)
  .max(ROUTE_MAX_STOPS * 2)
  .openapi({
    description: `The addresses in order, start first and end last: 2 to ${ROUTE_MAX_STOPS}, each up to ${ROUTE_ADDRESS_MAX} characters, each sent as typed to be measured.`,
    example: ['12 Elm St, Omaha, NE', 'Acme HQ, 1520 Harney St, Omaha', 'Eppley Airfield'],
  });

export const LogRouteDriveSchema = z
  .object({
    date: z.string().max(40).openapi({
      description: 'YYYY-MM-DD: today at the latest, and a day the rate is known for.',
      example: '2026-09-29',
    }),
    purpose: z.string().max(1000).openapi({
      description: 'Why the drive was for business. Up to 500 characters. Never sent anywhere.',
      example: 'Client visit at Acme',
    }),
    stops,
    roundTrip: z.boolean().optional().openapi({ description: 'Back to the start after the end.' }),
  })
  .strict()
  .openapi('LogRouteDrive');

export const ChangeRouteDriveSchema = LogRouteDriveSchema.partial()
  .strict()
  .refine((m) => Object.values(m).some((v) => v !== undefined), {
    message: 'Change at least one field.',
  })
  .openapi('ChangeRouteDrive');

export const ClaimRouteMilesSchema = z
  .object({
    miles: z.string().max(40).openapi({
      example: '41',
      description: 'More than 0 and at most 1000, two decimal places at most.',
    }),
    reason: z
      .string()
      .max(2000)
      .nullable()
      .optional()
      .openapi({
        description: `Why, up to ${ROUTE_REASON_MAX} characters: needed unless these are the miles measured.`,
        example: 'Road closed at the bridge',
      }),
  })
  .strict()
  .openapi('ClaimRouteMiles');

export const SavedPlaceSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().openapi({ example: 'Home' }),
    address: z.string().openapi({ example: '12 Elm St, Omaha, NE' }),
  })
  .openapi('SavedPlace');

export const SavedPlaceListSchema = z
  .object({ places: z.array(SavedPlaceSchema) })
  .openapi('SavedPlaceList');

export const SavePlaceSchema = z
  .object({
    name: z
      .string()
      .max(200)
      .openapi({
        description: `Up to ${PLACE_NAME_MAX} characters, once per person. Never sent anywhere.`,
        example: 'Home',
      }),
    address: z
      .string()
      .max(1000)
      .openapi({
        description: `Up to ${ROUTE_ADDRESS_MAX} characters.`,
        example: '12 Elm St, Omaha, NE',
      }),
  })
  .strict()
  .openapi('SavePlace');

export const ChangePlaceSchema = SavePlaceSchema.partial()
  .strict()
  .refine((m) => Object.values(m).some((v) => v !== undefined), {
    message: 'Change at least one field.',
  })
  .openapi('ChangePlace');

export const RouteKeyStatusSchema = z
  .object({
    provider: z.enum(['openrouteservice']),
    configured: z.boolean(),
    keyHint: z.string().nullable().openapi({ description: 'Its last four characters.' }),
    verifiedAt: z
      .string()
      .datetime()
      .nullable()
      .openapi({ description: 'When OpenRouteService accepted it, as it was saved.' }),
    updatedAt: z.string().datetime().nullable(),
  })
  .openapi('RouteKeyStatus');

export const SetRouteKeySchema = z
  .object({
    apiKey: z.string().min(1).max(2000).openapi({
      description:
        'Your OpenRouteService key. It is checked with one short route, then stored encrypted and never returned.',
    }),
  })
  .strict()
  .openapi('SetRouteKey');
