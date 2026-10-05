import { INVITE_LABEL_MAX, MEMBER_ROLES } from '@expensewise/domain';
import { z } from '@hono/zod-openapi';

/** Settings › People and invite links (FR-PLT-07, ADR-0035). */

export const MemberRoleSchema = z.enum(MEMBER_ROLES).openapi('MemberRole', {
  description:
    'member and approver see and change their own records; finance_admin and owner see ' +
    'everyone’s and change their own; auditor reads everyone’s and changes nothing. Owners ' +
    'and finance admins take admin actions; only owners manage people.',
});

export const PersonRefSchema = z
  .object({ id: z.string().uuid(), name: z.string().openapi({ example: 'casey' }) })
  .openapi('PersonRef');

export const PersonApproverSchema = z
  .object({
    chosen: PersonRefSchema.nullable().openapi({
      description: 'The approver an owner chose for their reports; null for Automatic.',
    }),
    goesTo: PersonRefSchema.nullable().openapi({
      description:
        'Who a report they submit now goes to: the one chosen while they can approve it, ' +
        'otherwise the longest-standing approver, then finance admin, then owner; in a ' +
        'one-person organization, its owner. Null when no one else can approve it.',
    }),
    passedOver: z.boolean().openapi({
      description:
        'The approver chosen can’t approve it now (their role changed, or they were removed), ' +
        'so goesTo is found as Automatic finds it.',
    }),
    choices: z.array(PersonRefSchema).openapi({
      description: 'Whom an owner may choose: everyone else here whose role may approve.',
    }),
  })
  .openapi('PersonApprover');

export const PersonSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().openapi({ example: 'sam' }),
    email: z.string().openapi({ example: 'sam@example.com' }),
    role: MemberRoleSchema,
    joinedAt: z.string().datetime(),
    removedAt: z
      .string()
      .datetime()
      .nullable()
      .openapi({ description: 'When an owner removed them; their records stay.' }),
    you: z.boolean().openapi({ description: 'Whether this is the caller.' }),
    approver: PersonApproverSchema.optional().openapi({
      description:
        'While approval is on, who approves their reports (#86). Absent for someone removed, ' +
        'and for everyone while approval is off.',
    }),
  })
  .openapi('Person');

export const InviteSchema = z
  .object({
    id: z.string().uuid(),
    role: MemberRoleSchema,
    label: z.string().nullable().openapi({ description: 'Who it is for, as the owner noted.' }),
    createdBy: z.string(),
    createdAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    expired: z.boolean(),
  })
  .openapi('Invite');

export const PeopleSchema = z
  .object({ people: z.array(PersonSchema), invites: z.array(InviteSchema) })
  .openapi('People');

export const CreateInviteSchema = z
  .object({
    role: MemberRoleSchema,
    label: z.string().trim().max(INVITE_LABEL_MAX).optional(),
  })
  .openapi('CreateInvite');

export const CreatedInviteSchema = z
  .object({
    invite: InviteSchema,
    token: z.string().openapi({
      description: 'The link’s secret. Shown this once: only its hash is kept.',
    }),
    path: z.string().openapi({ example: '/invite/3q2-7wEXAMPLEexampleEXAMPLEexampleEXAMPLE01' }),
  })
  .openapi('CreatedInvite');

export const ChangeRoleSchema = z.object({ role: MemberRoleSchema }).openapi('ChangeRole');

export const ChooseApproverSchema = z
  .object({
    approverId: z
      .string()
      .uuid()
      .nullable()
      .openapi({
        description:
          'Who approves their reports: someone else here whose role may approve. Null for ' +
          'Automatic, the routing as built.',
      }),
  })
  .openapi('ChooseApprover');

export const InviteTokenSchema = z
  .object({
    token: z
      .string()
      .regex(/^[A-Za-z0-9_-]{43}$/)
      .openapi({ description: 'The secret from the invite link. Sent in the body, never a URL.' }),
  })
  .openapi('InviteToken');

export const InvitePreviewSchema = z
  .object({
    organization: z.object({ id: z.string().uuid(), name: z.string() }),
    role: MemberRoleSchema,
    expiresAt: z.string().datetime(),
    state: z.enum(['pending', 'accepted', 'revoked', 'expired']),
    standing: z.enum(['none', 'empty', 'not_empty', 'this']).openapi({
      description:
        'Where the caller stands: in no organization; alone in an empty one of their own, ' +
        'which joining leaves behind; in one with work or other people, which stops them ' +
        'joining; or already in this one.',
    }),
  })
  .openapi('InvitePreview');

export const InviteAcceptedSchema = z
  .object({
    organization: z.object({ id: z.string().uuid(), name: z.string() }),
    member: z.object({ id: z.string().uuid(), role: MemberRoleSchema }),
  })
  .openapi('InviteAccepted');
