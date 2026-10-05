import {
  EXCLUSION_NOTE_MAX,
  EXCLUSION_REASONS,
  LINE_KINDS,
  SPLIT_PARTS_MAX,
} from '@expensewise/domain';
import { z } from '@hono/zod-openapi';

/*
 * A receipt's itemized lines on its expense, excluding a line, and splitting an expense into
 * parts (FR-INT-22, FR-EXP-15, FR-EXP-16, ADR-0041).
 */

const AmountSchema = z
  .object({
    amountMinor: z.number().int().openapi({ description: 'Integer minor units, e.g. cents.' }),
    currency: z.string().openapi({ example: 'USD' }),
    decimal: z.string().openapi({ example: '21.24', description: 'The same amount, for display.' }),
  })
  .openapi('ItemizedAmount');

const ChosenSchema = z.object({ id: z.string().uuid(), name: z.string() }).nullable();

export const ExclusionReasonSchema = z.enum(EXCLUSION_REASONS).openapi({
  description:
    'Why a line is left out of the claim (Q38): personal, paid by someone else, not ' +
    'reimbursable, or other, which needs a note.',
});

export const ItemizedLineSchema = z
  .object({
    position: z.number().int().openapi({ description: 'Its number on the receipt, from 1.' }),
    kind: z.enum(LINE_KINDS).openapi({
      description:
        'item: something bought, or a discount or a credit, refund or reversal as a negative ' +
        'amount, as printed. tax, fee and tip are spread across the items in proportion (Q37).',
    }),
    description: z.string(),
    quantity: z.string().nullable(),
    amount: AmountSchema.openapi({ description: 'As read.' }),
    share: AmountSchema.nullable().openapi({
      description:
        'An item’s share of the tax, tip and fees, in proportion to its amount, the largest ' +
        'share taking any cent left over. Null for tax, tip and fee lines, and while the lines ' +
        'don’t add up.',
    }),
    claimed: AmountSchema.nullable().openapi({
      description: 'The item and its share: what leaving it out takes off the claim.',
    }),
    excluded: z
      .object({
        reason: ExclusionReasonSchema,
        note: z.string().nullable(),
        at: z.string().datetime(),
      })
      .nullable()
      .openapi({ description: 'Why it is left out of the claim; null while it is claimed.' }),
    part: z
      .object({ categoryId: z.string().uuid(), typeId: z.string().uuid() })
      .nullable()
      .openapi({
        description:
          'The category and type it was given in a split by line; null: the expense’s own.',
      }),
  })
  .openapi('ItemizedLine');

/** Present while `expenses.itemized` is on; null for a receipt that prints no lines. */
export const ItemizedSchema = z
  .object({
    currency: z.string(),
    total: AmountSchema.nullable().openapi({ description: 'The receipt’s total, as read.' }),
    subtotal: AmountSchema.nullable(),
    lines: z.array(ItemizedLineSchema),
    addsUp: z.boolean().openapi({
      description:
        'The items come to the subtotal, and with tax, tip and fees to the total, within a cent ' +
        'a line (ADR-0041).',
    }),
    problem: z
      .object({
        code: z.enum(['subtotal', 'total', 'no_total', 'not_positive']),
        message: z.string(),
      })
      .nullable()
      .openapi({ description: 'Why they don’t add up, said plainly; null when they do.' }),
    claim: z
      .object({
        receipt: AmountSchema,
        excluded: AmountSchema,
        claimed: AmountSchema,
      })
      .nullable()
      .openapi({
        description:
          'The receipt’s total, what its excluded lines take off with their shares, and what is ' +
          'claimed. Null while the lines don’t add up.',
      }),
    byLine: z
      .object({
        usable: z.boolean(),
        code: z.enum(['lines_dont_add_up', 'other_currency', 'amount_changed']).nullable(),
        message: z.string().nullable(),
      })
      .openapi({
        description:
          'Whether lines can be excluded and split by line now: they add up, are in the ' +
          'expense’s currency and make up its claim. If not, why. Splitting by amount still works.',
      }),
  })
  .nullable()
  .openapi('Itemized');

export const ExpensePartSchema = z
  .object({
    position: z.number().int(),
    own: z.boolean().openapi({
      description: 'The lines left with the expense’s own category and type, in a split by line.',
    }),
    category: ChosenSchema,
    type: ChosenSchema,
    amount: AmountSchema,
    lines: z
      .array(z.number().int())
      .openapi({ description: 'The positions of the lines it is made of; none by amount.' }),
  })
  .openapi('ExpensePart');

/** Present while `expenses.split` and `expenses.categories` are on; null when not split. */
export const ExpenseSplitSchema = z
  .object({
    basis: z.enum(['lines', 'amounts']),
    parts: z.array(ExpensePartSchema),
  })
  .nullable()
  .openapi('ExpenseSplit');

export const ExcludeLineSchema = z
  .object({
    reason: ExclusionReasonSchema,
    note: z
      .string()
      .max(EXCLUSION_NOTE_MAX)
      .nullable()
      .optional()
      .openapi({ description: 'Optional, except for other.' }),
  })
  .openapi('ExcludeLine');

const choice = {
  categoryId: z.string().uuid(),
  typeId: z.string().uuid(),
};

export const SplitExpenseSchema = z
  .discriminatedUnion('basis', [
    z.object({
      basis: z.literal('lines'),
      lines: z
        .array(z.object({ position: z.number().int().min(1), ...choice }))
        .min(1)
        .max(100)
        .openapi({
          description:
            'Lines given a category and type of their own; the lines not named keep the ' +
            'expense’s own.',
        }),
    }),
    z.object({
      basis: z.literal('amounts'),
      parts: z
        .array(
          z.object({
            ...choice,
            amount: z.string().max(30).openapi({ example: '52.81' }),
          }),
        )
        .min(1)
        .max(SPLIT_PARTS_MAX + 1)
        .openapi({ description: 'At least two parts, adding up to the claim exactly.' }),
    }),
  ])
  .openapi('SplitExpense');

export const CategoryTotalSchema = z
  .object({
    category: ChosenSchema,
    type: ChosenSchema,
    totals: z.array(AmountSchema).openapi({ description: 'As spent, a sum per currency.' }),
    reimbursed: AmountSchema.nullable()
      .optional()
      .openapi({
        description:
          'While currency conversion is on: what it comes to in the report’s currency so far, ' +
          'each part taking its share of its expense’s conversion.',
      }),
    converting: z.number().int().optional().openapi({
      description: 'How many of its amounts are not in `reimbursed` yet.',
    }),
  })
  .openapi('CategoryTotal');

export const ReportCategoriesSchema = z
  .object({
    reportId: z.string().uuid(),
    currency: z.string().openapi({ description: 'The report’s reimbursement currency.' }),
    rows: z.array(CategoryTotalSchema),
  })
  .openapi('ReportCategories');
