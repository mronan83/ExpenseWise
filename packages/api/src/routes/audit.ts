import { createRoute, z } from '@hono/zod-openapi';
import { ProblemSchema } from '../schemas.ts';

// The audit trail (FR-GOV-06, F-20). Its schemas live here with its routes.

const problem = (description: string) => ({
  description,
  content: { 'application/problem+json': { schema: ProblemSchema } },
});

const secured = { security: [{ bearerAuth: [] }] };

const common = {
  401: problem('Sign in required.'),
  403: problem(
    'The caller has no organization yet (no_organization), or is not an owner, finance admin ' +
      'or auditor (forbidden_role).',
  ),
  404: problem('The audit trail is switched off for this organization (feature_off).'),
  503: problem('Sign-in or the database is not configured on this server.'),
};

export const AuditQuerySchema = z.object({
  entityType: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,63}$/, 'A record type such as receipt or expense.')
    .optional()
    .openapi({ description: 'Only events about records of this type.', example: 'receipt' }),
  entityId: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .openapi({ description: 'Only events about this record.' }),
  actorId: z.string().min(1).max(200).optional().openapi({
    description: 'Only changes made by this sign-in’s user id, or by this workflow.',
  }),
  cursor: z
    .string()
    .regex(/^[1-9]\d{0,14}$/, 'The nextCursor of the page before.')
    .optional()
    .openapi({ description: 'The `nextCursor` of the page before, for the page after it.' }),
  limit: z
    .string()
    .regex(/^\d{1,3}$/, 'A number from 1 to 100.')
    .optional()
    .openapi({ description: 'Events on the page: 50 unless asked, 100 at most.', example: '50' }),
});

const AuditActorSchema = z
  .object({
    type: z.enum(['user', 'system']).openapi({
      description: 'user: a person, by the sign-in they used. system: one of the app’s workflows.',
    }),
    id: z.string().nullable().openapi({
      description: 'The sign-in’s user id, or the workflow’s name, such as receipt-workflow.',
    }),
    name: z
      .string()
      .nullable()
      .openapi({ description: 'The member, when the sign-in is still theirs.' }),
    email: z.string().nullable().openapi({ description: 'The email of the sign-in they used.' }),
  })
  .openapi('AuditActor');

export const AuditEventSchema = z
  .object({
    sequence: z
      .number()
      .int()
      .openapi({ description: 'Its place in the organization’s chain, from 1, with no gaps.' }),
    occurredAt: z.string().datetime(),
    actor: AuditActorSchema,
    entityType: z.string().openapi({ example: 'receipt' }),
    entityId: z.string(),
    action: z.string().openapi({ example: 'receipt.captured' }),
    payload: z.record(z.string(), z.unknown()).openapi({
      description: 'What changed, as stored and hashed. It never holds a key or a token.',
    }),
    hash: z.string().openapi({ description: 'SHA-256 of this event and the hash before it.' }),
    prevHash: z.string(),
  })
  .openapi('AuditEvent');

export const AuditPageSchema = z
  .object({
    events: z.array(AuditEventSchema).openapi({ description: 'Newest first.' }),
    nextCursor: z
      .string()
      .nullable()
      .openapi({ description: 'Pass as `cursor` for older events; null on the last page.' }),
  })
  .openapi('AuditPage');

export const AuditVerificationSchema = z
  .object({
    intact: z.boolean().openapi({ description: 'Every event recomputes to its stored hash.' }),
    checked: z.number().int().openapi({
      description: 'Events recomputed: all of them, or those up to the first that breaks.',
    }),
    total: z.number().int().openapi({ description: 'Events in the chain.' }),
    brokenAt: z
      .object({
        sequence: z.number().int(),
        occurredAt: z.string().datetime(),
        entityType: z.string(),
        entityId: z.string(),
        action: z.string(),
      })
      .nullable()
      .openapi({ description: 'The first event that doesn’t verify; null while intact.' }),
    checkedAt: z.string().datetime(),
  })
  .openapi('AuditVerification');

export const listAuditEventsRoute = createRoute({
  method: 'get',
  path: '/v1/audit/events',
  tags: ['Audit'],
  summary: 'The organization’s audit trail, newest first, a page at a time',
  description:
    'FR-GOV-06. Every change to any record, with who made it and what changed, as stored. ' +
    'Narrow it to one record, a type of record, or who made the change. Owners, finance ' +
    'admins and auditors only.',
  ...secured,
  request: { query: AuditQuerySchema },
  responses: {
    200: {
      description: 'A page of events.',
      content: { 'application/json': { schema: AuditPageSchema } },
    },
    400: problem('A filter, the cursor or the page size is not valid.'),
    ...common,
  },
});

export const verifyAuditChainRoute = createRoute({
  method: 'get',
  path: '/v1/audit/verification',
  tags: ['Audit'],
  summary: 'Recompute the organization’s hash chain, and say whether it holds',
  description:
    'FR-GOV-05, FR-GOV-06. Recomputes every event’s hash from its stored content and the hash ' +
    'before it, and says how many were checked and the first that breaks. Owners, finance ' +
    'admins and auditors only.',
  ...secured,
  responses: {
    200: {
      description: 'What recomputing the chain found.',
      content: { 'application/json': { schema: AuditVerificationSchema } },
    },
    ...common,
  },
});
