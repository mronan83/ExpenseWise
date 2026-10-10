import { SET_ASIDE_NOTE_MAX, SET_ASIDE_REASONS } from '@expensewise/domain';
import { STATEMENT_ROWS_MAX } from '@expensewise/extraction';
import { z } from '@hono/zod-openapi';

/*
 * Card statements brought in, and their transactions matched to expenses (FR-CAP-10, FR-INT-24,
 * ADR-0046). Money is integer minor units plus a currency, with a decimal for display.
 */

const isoDate = () => z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const AmountSchema = z
  .object({
    amountMinor: z.number().int().openapi({ description: 'Integer minor units, e.g. cents.' }),
    currency: z.string().openapi({ example: 'USD' }),
    decimal: z
      .string()
      .openapi({ example: '402.20', description: 'The same amount, for display.' }),
  })
  .openapi('CardAmount');

/** At most 10 MB, as a receipt's file (ADR-0014). */
export const STATEMENT_MAX_BYTES = 10 * 1024 * 1024;
/** A downloaded list is text; 1 MB holds far more than STATEMENT_ROWS_MAX rows. */
export const LIST_MAX_CHARACTERS = 1024 * 1024;

const StatementFileSchema = {
  byteSize: z
    .number()
    .int()
    .min(1)
    .max(STATEMENT_MAX_BYTES)
    .openapi({ description: 'At most 10 MB.' }),
  sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .openapi({ description: 'SHA-256 of the PDF, lowercase hex.' }),
};

export const StatementUploadRequestSchema = z
  .object(StatementFileSchema)
  .openapi('StatementUploadRequest', { description: 'A statement’s PDF, before it is uploaded.' });

export const StatementUploadTicketSchema = z
  .object({
    statementId: z.string().uuid(),
    bucket: z.string(),
    path: z.string(),
    token: z.string().openapi({ description: 'Uploads one file to this path, once.' }),
  })
  .openapi('StatementUploadTicket');

export const FileStatementSchema = z
  .object({
    id: z.string().uuid().openapi({ description: 'The statementId from the upload ticket.' }),
    ...StatementFileSchema,
  })
  .openapi('FileStatement');

export const StatementListRequestSchema = z
  .object({
    text: z
      .string()
      .min(1)
      .max(LIST_MAX_CHARACTERS)
      .openapi({
        description:
          'The downloaded list as text: CSV or tab-separated, with a header row naming its ' +
          `columns. At most ${STATEMENT_ROWS_MAX} rows.`,
      }),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .optional()
      .openapi({
        description: 'The card’s currency; the organization’s home currency if not given.',
      }),
  })
  .openapi('StatementListRequest');

export const StatementStatusSchema = z.enum(['reading', 'read', 'needs_look', 'failed']).openapi({
  description:
    'reading: its PDF is being read. read: its transactions are kept and matched. needs_look: ' +
    'its lines don’t make its printed totals, or a line couldn’t be read, so nothing is matched ' +
    'until the person confirms it (US-CAP-07 AC5). failed: nothing could be read; problem says why.',
});

export const CardStatementSchema = z
  .object({
    id: z.string().uuid(),
    source: z.enum(['upload', 'email', 'list']).openapi({
      description:
        'upload: a PDF brought in here. email: a PDF forwarded. list: a downloaded list.',
    }),
    status: StatementStatusSchema,
    problem: z
      .string()
      .nullable()
      .openapi({ description: 'needs_look and failed: why, in plain words.' }),
    cardLastFour: z.string().nullable(),
    periodStart: isoDate().nullable(),
    periodEnd: isoDate().nullable(),
    charges: AmountSchema.nullable().openapi({ description: 'Its own printed total of charges.' }),
    credits: AmountSchema.nullable().openapi({ description: 'Its own printed total of credits.' }),
    added: z
      .number()
      .int()
      .openapi({ description: 'Transactions it brought in that no earlier statement had.' }),
    createdAt: z.string().datetime(),
  })
  .openapi('CardStatement');

export const SetAsideReasonSchema = z.enum(SET_ASIDE_REASONS).openapi({
  description:
    'Why a charge has no expense: personal, no receipt was given, not an expense (such as a ' +
    'fee the company pays), or other, which needs a note.',
});

const MatchedExpenseSchema = z
  .object({
    id: z.string().uuid(),
    merchant: z.string().nullable(),
    date: isoDate().nullable(),
    amount: AmountSchema.nullable(),
  })
  .openapi('MatchedExpense');

export const CardTransactionSchema = z
  .object({
    id: z.string().uuid(),
    statementId: z.string().uuid(),
    transactionDate: isoDate(),
    postedOn: isoDate().nullable(),
    merchant: z.string().openapi({ description: 'As the statement prints it.' }),
    amount: AmountSchema.openapi({
      description: 'In the card’s currency, as charged. A credit or refund is negative.',
    }),
    cardLastFour: z.string().nullable(),
    state: z.enum(['missing', 'matched', 'set_aside', 'credit', 'waiting']).openapi({
      description:
        'missing: a charge with no expense yet, a missing receipt. matched: it pays for an ' +
        'expense. set_aside: the person said why it has none. credit: a credit or refund, never ' +
        'a missing receipt. waiting: its statement needs a look first.',
    }),
    expense: MatchedExpenseSchema.nullable(),
    matchedBy: z.enum(['auto', 'person']).nullable().openapi({
      description: 'auto: by its amount, day and merchant. person: chosen by the person.',
    }),
    setAside: z
      .object({
        reason: SetAsideReasonSchema,
        note: z.string().nullable(),
        at: z.string().datetime(),
      })
      .nullable(),
  })
  .openapi('CardTransaction');

export const CardStatementsSchema = z
  .object({
    statements: z.array(CardStatementSchema).openapi({ description: 'Newest first.' }),
    transactions: z
      .array(CardTransactionSchema)
      .openapi({ description: 'Every transaction they brought in, latest first.' }),
    missing: z.number().int().openapi({ description: 'How many are missing receipts.' }),
  })
  .openapi('CardStatements');

export const StatementListResultSchema = z
  .object({
    statementId: z.string().uuid(),
    added: z.number().int().openapi({ description: 'Transactions no earlier statement had.' }),
    matched: z.number().int().openapi({ description: 'Of all open ones, how many were matched.' }),
    skipped: z.number().int().openapi({
      description: 'Rows that weren’t transactions, such as a payment, or didn’t read.',
    }),
  })
  .openapi('StatementListResult');

export const SetAsideSchema = z
  .object({
    reason: SetAsideReasonSchema,
    note: z
      .string()
      .max(SET_ASIDE_NOTE_MAX)
      .nullable()
      .optional()
      .openapi({ description: `Needed for other; at most ${SET_ASIDE_NOTE_MAX} characters.` }),
  })
  .openapi('SetAside');

export const MatchToExpenseSchema = z
  .object({ expenseId: z.string().uuid() })
  .openapi('MatchToExpense', {
    description: 'Any of the person’s expenses not paid by another charge, whatever its amount.',
  });

const MatchableExpenseSchema = MatchedExpenseSchema.extend({
  charged: AmountSchema.nullable().openapi({
    description:
      'What the charges already matched to it come to; null with none. One expense can be paid by several charges, such as a ride and its tip (ADR-0051).',
  }),
}).openapi('MatchableExpense');

export const MatchableExpensesSchema = z
  .object({
    expenses: z.array(MatchableExpenseSchema).openapi({
      description:
        'The person’s expenses with their receipts within a week of the charge, nearest first, with what any charges already matched to each come to.',
    }),
  })
  .openapi('MatchableExpenses');

export const MatchAgainResultSchema = z
  .object({ matched: z.number().int() })
  .openapi('MatchAgainResult');

/** A statement waiting for the person's look, as Needs you shows it (US-CAP-07 AC14). */
export const CardStatementInboxItemSchema = z
  .object({
    kind: z.literal('card_statement'),
    statement: z.object({
      id: z.string().uuid(),
      periodStart: isoDate().nullable(),
      periodEnd: isoDate().nullable(),
      cardLastFour: z.string().nullable(),
      problem: z.string().nullable().openapi({ description: 'What it says doesn’t add up.' }),
    }),
    reason: z.object({
      code: z.literal('statement_needs_look').openapi({
        description:
          'Its lines don’t make the totals it prints: nothing on it is matched until the person looks.',
      }),
    }),
  })
  .openapi('CardStatementInboxItem', {
    description: 'A card statement waiting for the person’s look, while card statements are on.',
  });

/** A short-lived link to a statement's own PDF (US-CAP-07 AC15). */
export const StatementFileLinkSchema = z
  .object({
    url: z.string().url().openapi({ description: 'A signed link to the PDF as brought in.' }),
    expiresInSeconds: z.number().int(),
  })
  .openapi('StatementFileLink');

/** A missing receipt, as Needs you shows it (US-CAP-07 AC3). */
export const CardInboxItemSchema = z
  .object({
    kind: z.literal('card'),
    transaction: z.object({
      id: z.string().uuid(),
      date: isoDate(),
      merchant: z.string(),
      amount: AmountSchema,
      cardLastFour: z.string().nullable(),
    }),
    reason: z.object({
      code: z.literal('missing_receipt').openapi({
        description: 'A card charge with no expense: add its receipt, match it, or say why not.',
      }),
    }),
  })
  .openapi('CardInboxItem', {
    description: 'A charge on the person’s card with no expense, while card statements are on.',
  });

/** On an expense's page: a card charge that paid for it (US-CAP-07 AC2, AC7, AC12). */
export const ExpenseCardChargeSchema = z
  .object({
    id: z.string().uuid(),
    date: isoDate(),
    merchant: z.string(),
    amount: AmountSchema.openapi({
      description: 'What the card was charged, in its currency, beside any conversion (AC7).',
    }),
    cardLastFour: z.string().nullable(),
    matchedBy: z.enum(['auto', 'person']),
  })
  .openapi('ExpenseCardCharge');
