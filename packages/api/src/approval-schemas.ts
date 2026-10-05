import { APPROVAL_NOTE_MAX } from '@expensewise/domain';
import { z } from '@hono/zod-openapi';
import { ExpenseAmountSchema, ReceiptCheckSchema, ReportStatusSchema } from './schemas.ts';

/*
 * Single-step approval (FR-GOV-02, FR-GOV-03, FR-GOV-10 to FR-GOV-13, FR-EXP-10, #24,
 * ADR-0043). Behind the `reports.approval` feature.
 */

const NamedMemberSchema = z
  .object({ memberId: z.string().uuid(), name: z.string() })
  .openapi('NamedMember');

const ReviewedExpenseSchema = z
  .object({
    id: z.string().uuid(),
    merchant: z.string().nullable(),
    date: z.string().nullable(),
    amount: ExpenseAmountSchema,
    receiptId: z.string().uuid().nullable(),
    trip: z.string().nullable().openapi({ description: 'The trip it is on, by name.' }),
    receipt: z
      .object({
        merchant: z.string().nullable(),
        date: z.string().nullable(),
        amount: ExpenseAmountSchema,
      })
      .nullable()
      .openapi({ description: 'What its receipt shows; null without one.' }),
    check: ReceiptCheckSchema,
    claimReason: z
      .string()
      .nullable()
      .openapi({ description: 'Why it claims less than its receipt, in the person’s words.' }),
    excludedLines: z.number().int().openapi({
      description: 'Lines of its receipt left out of the claim, each with its reason.',
    }),
    rejection: z
      .object({
        reason: z.string(),
        automatic: z.boolean().openapi({
          description: 'Rejected by the review on its own, because it differs from its receipt.',
        }),
      })
      .nullable()
      .openapi({ description: 'Why its report’s latest return rejected it, while it is back.' }),
  })
  .openapi('ReviewedExpense');

const ApprovalStepSchema = z
  .object({
    sequence: z.number().int(),
    approver: z.string().openapi({ description: 'Who it went to, or who decided it.' }),
    decision: z.enum(['pending', 'approved', 'returned']),
    comment: z.string().nullable(),
    decidedAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
  })
  .openapi('ApprovalStep');

export const ApprovalSchema = z
  .object({
    reportId: z.string().uuid(),
    status: ReportStatusSchema,
    member: z.string().openapi({ description: 'Whose report it is.' }),
    mine: z.boolean().openapi({ description: 'Whether it is the caller’s own.' }),
    approver: NamedMemberSchema.nullable().openapi({
      description:
        'Who it is with while it waits for approval, and once decided who decided it; before ' +
        'it is submitted, who it would go to now. Null when no one else in the team can ' +
        'approve it.',
    }),
    selfAttests: z.boolean().openapi({
      description: 'A one-person organization’s owner approves their own, and says so (FR-GOV-03).',
    }),
    steps: z.array(ApprovalStepSchema).openapi({ description: 'Each round, oldest first.' }),
    returned: z
      .object({ comment: z.string(), by: z.string(), at: z.string().datetime() })
      .nullable()
      .openapi({ description: 'Its latest return, while it is back with its member.' }),
    expenses: z.array(ReviewedExpenseSchema).openapi({
      description: 'Every expense on it, its trips’ and its local ones, in date order.',
    }),
    can: z.object({ submit: z.boolean(), approve: z.boolean(), return: z.boolean() }).openapi({
      description: 'What the caller may do with it now.',
    }),
    why: z
      .object({
        code: z.enum([
          'not_closed',
          'differs',
          'no_approver',
          'self_approval',
          'not_an_approver',
          'not_your_approval',
          'rejected',
          'second_factor_required',
        ]),
        detail: z.string(),
      })
      .nullable()
      .openapi({ description: 'Why the next step can’t be taken by the caller, if it can’t.' }),
    secondFactor: z.enum(['needed', 'passed', 'not_needed']).openapi({
      description:
        'For deciding it: approving someone else’s spend needs the second factor in this ' +
        'session (FR-GOV-04); a one-person organization’s self-attestation does not.',
    }),
  })
  .openapi('Approval');

const note = (description: string, example: string) =>
  z.string().max(2000).openapi({ description, example });

export const ReturnReportSchema = z
  .object({
    comment: note(
      `Why it goes back, for its member to read: up to ${APPROVAL_NOTE_MAX} characters.`,
      'The hotel’s dates don’t match the trip; fix them and send it again',
    ),
    rejections: z
      .array(
        z
          .object({
            expenseId: z.string().uuid(),
            reason: note(
              `Why this one is rejected, up to ${APPROVAL_NOTE_MAX} characters.`,
              'A lunch alone isn’t a business meal',
            ),
          })
          .strict(),
      )
      .max(500)
      .default([])
      .openapi({
        description:
          'Expenses the approver rejects, each with why. Any that differ from their receipts ' +
          'are rejected too, on their own (FR-GOV-10).',
      }),
  })
  .strict()
  .openapi('ReturnReport');

export const ClaimReasonBodySchema = z
  .object({
    reason: note(
      `Why it claims less than its receipt, up to ${APPROVAL_NOTE_MAX} characters; blank removes it.`,
      'The minibar was personal',
    ),
  })
  .strict()
  .openapi('ClaimReasonBody');

export const ClaimReasonSchema = z.object({ reason: z.string().nullable() }).openapi('ClaimReason');
