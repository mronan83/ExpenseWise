import {
  DUPLICATE_WINDOW_MAX_MINUTES,
  MEMBER_ROLES,
  ORGANIZATION_SIZES,
  SUPPORTED_CURRENCIES,
} from '@expensewise/domain';
import { createRoute, z } from '@hono/zod-openapi';
import { ProblemSchema } from '../schemas.ts';

const problem = (description: string) => ({
  description,
  content: { 'application/problem+json': { schema: ProblemSchema } },
});

const secured = { security: [{ bearerAuth: [] }] };

export const OrganizationDetailsSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().openapi({ example: 'Acme Field Services' }),
    homeCurrency: z.enum(SUPPORTED_CURRENCIES as [string, ...string[]]).openapi({
      example: 'USD',
      description:
        'ISO 4217. Reports opened from now on are in it; reports already opened keep theirs, ' +
        'and no amount is converted.',
    }),
    country: z.string().nullable().openapi({ example: 'US', description: 'ISO 3166-1 alpha-2.' }),
    locale: z.string().nullable().openapi({ example: 'en-US', description: 'A BCP 47 tag.' }),
    timeZone: z
      .string()
      .nullable()
      .openapi({
        example: 'America/Chicago',
        description:
          'An IANA time zone. With organization settings on, it says when the organization’s ' +
          'day ends: when trips and local expenses join a report, and which day is day 28.',
      }),
    address: z.string().nullable().openapi({ example: '1520 Harney St\nOmaha, NE 68102' }),
    industry: z.string().nullable().openapi({ example: 'Professional services' }),
    size: z
      .enum(ORGANIZATION_SIZES)
      .nullable()
      .openapi({ description: 'How many people it has, in bands.' }),
  })
  .openapi('OrganizationDetails');

const RoleSchema = z.enum(MEMBER_ROLES).openapi({ description: 'The caller’s role.' });

export const OrganizationSettingsSchema = z
  .object({
    organization: OrganizationDetailsSchema,
    role: RoleSchema,
    canEdit: z.boolean().openapi({ description: 'Only the owner changes the details.' }),
  })
  .openapi('OrganizationSettings');

const detail = (description: string, example: string, max: number) =>
  z.string().max(max).optional().openapi({ description, example });

export const EditOrganizationSchema = z
  .object({
    name: detail('The organization’s name. It can’t be blank.', 'Acme Field Services', 200),
    homeCurrency: detail('An ISO 4217 code ExpenseWise supports. It can’t be blank.', 'EUR', 3),
    country: detail('ISO 3166-1 alpha-2; blank clears it.', 'US', 2),
    locale: detail('A BCP 47 language tag; blank clears it.', 'en-US', 35),
    timeZone: detail('An IANA time zone; blank clears it.', 'America/Chicago', 64),
    address: detail('The postal address, lines and all; blank clears it.', 'Omaha, NE', 300),
    industry: detail('What it does; blank clears it.', 'Professional services', 100),
    size: detail(`One of ${ORGANIZATION_SIZES.join(', ')}; blank clears it.`, '2_10', 16),
  })
  .strict()
  .refine((e) => Object.values(e).some((v) => v !== undefined), {
    message: 'Change at least one field.',
  })
  .openapi('EditOrganization');

export const DuplicateWindowSchema = z
  .object({
    minutes: z
      .number()
      .int()
      .openapi({
        example: 30,
        description:
          'How many minutes apart two receipts at one place can be and still be one purchase. ' +
          '0 is the same minute only.',
      }),
    defaultMinutes: z.number().int().openapi({ example: 30 }),
    maxMinutes: z.number().int().openapi({ example: DUPLICATE_WINDOW_MAX_MINUTES }),
    canEdit: z.boolean().openapi({ description: 'Only the owner sets it, for everyone.' }),
  })
  .openapi('DuplicateWindow');

export const SetDuplicateWindowSchema = z
  .object({
    minutes: z.number().int().min(0).max(DUPLICATE_WINDOW_MAX_MINUTES).openapi({ example: 45 }),
  })
  .openapi('SetDuplicateWindow');

const common = {
  401: problem('Sign in required.'),
  403: problem('The caller has no organization yet, or is not its owner.'),
  404: problem('This feature is not switched on for the organization (feature_off).'),
  503: problem('Sign-in or the database is not configured on this server.'),
};

export const getOrganizationRoute = createRoute({
  method: 'get',
  path: '/v1/settings/organization',
  tags: ['Settings'],
  summary: "The organization's details",
  description:
    'Its name, home currency, country, locale, time zone, address, industry and size, and the ' +
    'caller’s role. Every member can read them. Behind `settings.organization`.',
  ...secured,
  responses: {
    200: {
      description: 'The details.',
      content: { 'application/json': { schema: OrganizationSettingsSchema } },
    },
    ...common,
  },
});

export const editOrganizationRoute = createRoute({
  method: 'patch',
  path: '/v1/settings/organization',
  tags: ['Settings'],
  summary: "Change the organization's details",
  description:
    'Only the owner. Each field given is checked and set; a blank clears one that may be ' +
    'empty. The change is recorded in the audit log, from and to. Behind `settings.organization`.',
  ...secured,
  request: {
    body: { content: { 'application/json': { schema: EditOrganizationSchema } }, required: true },
  },
  responses: {
    200: {
      description: 'The details as they now are.',
      content: { 'application/json': { schema: OrganizationSettingsSchema } },
    },
    400: problem('The request is not valid.'),
    ...common,
    422: problem('A value is not valid; `field` names it.'),
  },
});

export const getDuplicateWindowRoute = createRoute({
  method: 'get',
  path: '/v1/settings/duplicate-window',
  tags: ['Settings'],
  summary: 'The duplicate time window',
  description:
    'How far apart in time two receipts at one place can be and still be one purchase, for ' +
    'everyone in the organization. Every member can read it. Behind `settings.duplicate-window`.',
  ...secured,
  responses: {
    200: {
      description: 'The window.',
      content: { 'application/json': { schema: DuplicateWindowSchema } },
    },
    ...common,
  },
});

export const setDuplicateWindowRoute = createRoute({
  method: 'put',
  path: '/v1/settings/duplicate-window',
  tags: ['Settings'],
  summary: 'Set the duplicate time window',
  description:
    'Only the owner, for everyone: 0 to 120 minutes. It judges receipts read from now on; pairs ' +
    'already flagged or kept stay as they are. Each change is recorded in the audit log. ' +
    'Behind `settings.duplicate-window`.',
  ...secured,
  request: {
    body: { content: { 'application/json': { schema: SetDuplicateWindowSchema } }, required: true },
  },
  responses: {
    200: {
      description: 'The window as it now is.',
      content: { 'application/json': { schema: DuplicateWindowSchema } },
    },
    400: problem('The request is not valid: a whole number of minutes, 0 to 120.'),
    ...common,
  },
});
