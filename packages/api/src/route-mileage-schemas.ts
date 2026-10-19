import {
  PLACE_NAME_MAX,
  RECENT_PLACES,
  ROUTE_ADDRESS_MAX,
  ROUTE_MAX_STOPS,
  ROUTE_NAME_MAX,
  ROUTE_REASON_MAX,
  SUGGEST_MIN_CHARS,
  SUGGEST_SHOWN,
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
      .openapi({
        description: 'Where it was found, once measured; or where it was picked, from the start.',
      }),
    pinned: z.boolean().openapi({
      description:
        'Picked from the suggestions: measured from its place, its address never searched (Q53).',
    }),
    pick: z
      .string()
      .nullable()
      .openapi({
        description:
          'For a pinned stop: send it back with the stop, as in PickedStop, to keep the place it ' +
          'was picked at. Sealed by the server; null for a stop typed.',
      }),
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
    name: z.string().nullable().openapi({
      example: 'Acme visit and the airport',
      description:
        'The name its person gave it, which its expense is listed by; null when it goes by its start and end, such as “Office → Eppley Airfield” (FR-CAP-15).',
    }),
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

export const PickedStopSchema = z
  .object({
    address: z.string().max(1000).openapi({
      example: 'Eppley Airfield, 4501 Abbott Drive, Omaha, NE, USA',
      description: 'The address the suggestion gave, as shown on the stop.',
    }),
    pick: z
      .string()
      .max(2000)
      .openapi({
        description:
          'The pick of a place suggested, driven to before, or already on the drive: the stop is ' +
          'measured from exactly there, and its address is never searched (Q53).',
      }),
  })
  .strict()
  .openapi('PickedStop');

const stops = z
  .array(z.union([z.string().max(1000), PickedStopSchema]))
  .min(1)
  .max(ROUTE_MAX_STOPS * 2)
  .openapi({
    description: `The stops in order, start first and end last: 2 to ${ROUTE_MAX_STOPS}, each an address of up to ${ROUTE_ADDRESS_MAX} characters, sent as typed to be measured, or a place picked from the suggestions, measured from where it is.`,
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
    name: z
      .string()
      .max(400)
      .nullable()
      .optional()
      .openapi({
        example: 'Acme visit and the airport',
        description: `What it is called, up to ${ROUTE_NAME_MAX} characters; empty or null, it goes by its start and end. Never sent anywhere.`,
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

const point = {
  longitude: z.string().openapi({ example: '-95.894069', description: 'Degrees, to six places.' }),
  latitude: z.string().openapi({ example: '41.303166', description: 'Degrees, to six places.' }),
};

export const SuggestPlacesSchema = z
  .object({
    text: z
      .string()
      .max(1000)
      .openapi({
        example: 'eppley',
        description: `What is typed in the stop: from ${SUGGEST_MIN_CHARS} characters, it is sent to OpenRouteService as typed, and nothing else of the drive (Q32).`,
      }),
    near: z
      .object({
        longitude: z.number().min(-180).max(180),
        latitude: z.number().min(-90).max(90),
      })
      .nullable()
      .optional()
      .openapi({
        description:
          'A place picked earlier in the drive, to rank places near it first; never the ' +
          'device’s own location (Q54).',
      }),
  })
  .strict()
  .openapi('SuggestPlaces');

export const PlaceSuggestionSchema = z
  .object({
    name: z.string().openapi({ example: 'Eppley Airfield' }),
    detail: z.string().openapi({
      example: '4501 Abbott Drive, Omaha, NE, USA',
      description: 'Where it is, under its name.',
    }),
    address: z.string().openapi({
      example: 'Eppley Airfield, 4501 Abbott Drive, Omaha, NE, USA',
      description: 'The stop’s address once picked.',
    }),
    label: z.string().openapi({
      example: 'Eppley Airfield, Omaha, NE, USA',
      description: 'OpenRouteService’s own name for it: the place the stop is measured from.',
    }),
    ...point,
    pick: z.string().openapi({ description: 'Send it with the stop, as in PickedStop.' }),
  })
  .openapi('PlaceSuggestion');

export const PlaceSuggestionListSchema = z
  .object({
    places: z.array(PlaceSuggestionSchema).openapi({
      description: `Best first, at most ${SUGGEST_SHOWN}; none for fewer than ${SUGGEST_MIN_CHARS} characters.`,
    }),
    problem: z
      .enum([
        'no_key',
        'unreadable_key',
        'rejected',
        'limited',
        'unreachable',
        'refused',
        'unavailable',
      ])
      .nullable()
      .openapi({
        description:
          'Why there are none to show, when OpenRouteService wasn’t asked or gave no answer: ' +
          'the stop is then typed, and measured as typed.',
      }),
    attribution: z.string().openapi({
      example: 'Places © openrouteservice.org by HeiGIT · Map data © OpenStreetMap contributors',
      description: 'To show with the places.',
    }),
  })
  .openapi('PlaceSuggestionList');

export const RecentPlaceSchema = z
  .object({
    address: z.string().openapi({ example: 'Eppley Airfield, Omaha, NE' }),
    label: z.string().openapi({ example: 'Eppley Airfield, Omaha, NE, USA' }),
    ...point,
    lastDriven: z.string().openapi({ example: '2026-10-09', description: 'YYYY-MM-DD.' }),
    pick: z.string().nullable().openapi({
      description: 'Send it with the stop, as in PickedStop; null while picks can’t be sealed.',
    }),
  })
  .openapi('RecentPlace');

export const RecentPlaceListSchema = z
  .object({
    places: z.array(RecentPlaceSchema).openapi({
      description: `The caller’s own drives’ places, newest first, once each, at most ${RECENT_PLACES}.`,
    }),
  })
  .openapi('RecentPlaceList');

export const SavedRouteSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().openapi({ example: 'Office → Acme HQ' }),
    roundTrip: z.boolean(),
    stops: z
      .array(
        z.object({
          address: z.string().openapi({ example: '1520 Harney St, Omaha, NE' }),
          place: z
            .object({ label: z.string(), longitude: z.string(), latitude: z.string() })
            .nullable()
            .openapi({
              description: 'Where it was picked, for a stop picked from the suggestions.',
            }),
          pick: z.string().nullable().openapi({
            description: 'Send it with the stop, as in PickedStop, to log a drive from it pinned.',
          }),
        }),
      )
      .openapi({ description: 'In order: the start first.' }),
  })
  .openapi('SavedRoute');

export const SavedRouteListSchema = z
  .object({ routes: z.array(SavedRouteSchema) })
  .openapi('SavedRouteList');

export const SaveRouteSchema = z
  .object({
    name: z
      .string()
      .max(400)
      .openapi({
        description: `Up to ${ROUTE_NAME_MAX} characters, once per person. Never sent anywhere.`,
        example: 'Office → Acme HQ',
      }),
    stops,
    roundTrip: z.boolean().optional().openapi({ description: 'Back to the start after the end.' }),
  })
  .strict()
  .openapi('SaveRoute');

export const ChangeRouteSchema = SaveRouteSchema.partial()
  .strict()
  .refine((m) => Object.values(m).some((v) => v !== undefined), {
    message: 'Change at least one field.',
  })
  .openapi('ChangeRoute');
