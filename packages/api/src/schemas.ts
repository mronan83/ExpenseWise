import { isIsoDate, SUPPORTED_CURRENCIES } from '@expensewise/domain';
import { CORRECTABLE_FIELDS, READING_CHECKS } from '@expensewise/extraction';
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

export const IdentitySchema = z
  .object({
    userId: z.string().openapi({ example: '6f1d2c3e-8a4b-4f5e-9c7d-0a1b2c3d4e5f' }),
    email: z.string().nullable().openapi({ example: 'alex@example.com' }),
    assuranceLevel: z.enum(['aal1', 'aal2']).openapi({
      description: 'aal2 means this session passed multi-factor authentication.',
    }),
    sessionId: z.string().nullable(),
  })
  .openapi('Identity');

const ReadinessCheckSchema = z
  .object({
    status: z.enum(['pass', 'fail', 'skip']),
    detail: z.string().openapi({ example: 'connected as expensewise_app' }),
  })
  .openapi('ReadinessCheck');

export const ReadinessSchema = z
  .object({
    ready: z.boolean().openapi({ description: 'True when no check failed.' }),
    checks: z.object({
      database: ReadinessCheckSchema,
      role: ReadinessCheckSchema,
      tls: ReadinessCheckSchema,
      tenantIsolation: ReadinessCheckSchema,
    }),
  })
  .openapi('Readiness');

export type Readiness = z.infer<typeof ReadinessSchema>;

export const OrganizationSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().openapi({ example: "alex's organization" }),
    homeCurrency: z.string().openapi({ example: 'USD' }),
  })
  .openapi('Organization');

export const WorkspaceSchema = z
  .object({
    organization: OrganizationSchema,
    member: z.object({
      id: z.string().uuid(),
      role: z.enum(['member', 'approver', 'finance_admin', 'owner', 'auditor']),
    }),
  })
  .openapi('Workspace');

export const AiProviderSchema = z.enum(['anthropic', 'openai']).openapi('AiProvider');

export const AiProviderKeyStatusSchema = z
  .object({
    provider: AiProviderSchema,
    configured: z.boolean(),
    keyHint: z
      .string()
      .nullable()
      .openapi({ example: 'gAAA', description: 'The last four characters of the stored key.' }),
    authScheme: z.enum(['api_key', 'bearer']).nullable().openapi({
      description: 'How the provider accepted the key: as an API key header or a bearer token.',
    }),
    verifiedAt: z.string().datetime().nullable(),
    updatedAt: z.string().datetime().nullable(),
  })
  .openapi('AiProviderKeyStatus');

export const AiProviderKeyListSchema = z
  .object({ providers: z.array(AiProviderKeyStatusSchema) })
  .openapi('AiProviderKeyList');

export const SetAiProviderKeySchema = z
  .object({
    apiKey: z.string().trim().min(8).max(1000).openapi({
      description:
        'The key from the provider. It is checked with the provider, then stored encrypted and never returned.',
    }),
  })
  .openapi('SetAiProviderKey');

export const AiProviderKeyTestSchema = z
  .object({
    valid: z.boolean(),
    status: AiProviderKeyStatusSchema,
    reason: z
      .enum(['rejected', 'refused', 'unreachable', 'unreadable'])
      .optional()
      .openapi({ description: 'Why the key could not be used, when valid is false.' }),
    detail: z
      .string()
      .optional()
      .openapi({ description: 'What the provider answered, when it answered. Never the key.' }),
  })
  .openapi('AiProviderKeyTest');

export const SignInSchema = z
  .object({
    id: z.string().uuid(),
    email: z.string().openapi({ example: 'alex@example.com' }),
    linkedAt: z.string().datetime(),
    current: z
      .boolean()
      .openapi({ description: 'Whether this is the sign-in making the request.' }),
  })
  .openapi('SignIn');

export const SignInListSchema = z.object({ signIns: z.array(SignInSchema) }).openapi('SignInList');

export const LinkSignInSchema = z
  .object({
    accessToken: z
      .string()
      .min(20)
      .max(8000)
      .openapi({
        description:
          'An access token for the other sign-in, from signing in with it moments ago. With the ' +
          "request's own token it proves the caller controls both. Used once, never stored.",
      }),
  })
  .openapi('LinkSignIn');

const ConfidenceSchema = z.enum(['high', 'medium', 'low']);
const TextFieldSchema = z.object({ value: z.string(), confidence: ConfidenceSchema }).nullable();
const MoneyFieldSchema = z
  .object({
    amountMinor: z.number().int().openapi({ description: 'Integer minor units, e.g. cents.' }),
    currency: z.string().openapi({ example: 'USD' }),
    decimal: z.string().openapi({ example: '6.50', description: 'The same amount, for display.' }),
    confidence: ConfidenceSchema,
    assumed: z.boolean().openapi({
      description:
        'True for a tax or tip the receipt does not print, taken as zero rather than read. ' +
        'Never set when the line is printed but unreadable, or when the printed figures leave ' +
        'an amount unaccounted for.',
    }),
  })
  .nullable();

export const ReceiptStatusSchema = z.enum(['processing', 'extracted', 'needs_review', 'failed']);

export const ReceiptSummarySchema = z
  .object({
    id: z.string().uuid(),
    status: ReceiptStatusSchema.openapi({
      description:
        'processing while it is read; extracted (shown as Ready) when both compared models ' +
        'read it with confidence and agree, or when a member confirmed or corrected a reading ' +
        '(ADR-0021); needs_review otherwise, including when only the fallback model read it; ' +
        'failed when no model could read it.',
    }),
    source: z.enum(['camera', 'upload', 'email', 'card', 'manual', 'mileage']),
    contentType: z.string(),
    byteSize: z.number().int(),
    uploadedBy: z.string(),
    createdAt: z.string().datetime(),
    merchant: z.string().nullable(),
    date: z.string().nullable(),
    total: MoneyFieldSchema,
    expenseId: z
      .string()
      .uuid()
      .nullable()
      .openapi({ description: 'The expense this receipt proves (FR-EXP-08).' }),
  })
  .openapi('ReceiptSummary');

const ReadingRoleSchema = z.enum(['compared', 'fallback']).openapi({
  description:
    'compared: one of the models the tier decision weighs. fallback: read only because no ' +
    'compared model could (ADR-0020).',
});

export const ReceiptReadingSchema = z
  .object({
    model: z.string().openapi({ example: 'claude-haiku-4-5' }),
    label: z.string().openapi({ example: 'Haiku 4.5' }),
    role: ReadingRoleSchema,
    state: z.enum(['pending', 'missing', 'confident', 'unsure', 'failed']),
    error: z.string().nullable(),
    latencyMs: z.number().int().nullable(),
    costMicroUsd: z.number().int().nullable(),
    inputTokens: z.number().int().nullable(),
    outputTokens: z.number().int().nullable(),
    fields: z
      .object({
        documentType: z.string(),
        merchant: TextFieldSchema,
        date: TextFieldSchema,
        currency: TextFieldSchema,
        total: MoneyFieldSchema,
        subtotal: MoneyFieldSchema,
        taxTotal: MoneyFieldSchema,
        tip: MoneyFieldSchema,
        cardLastFour: TextFieldSchema,
      })
      .nullable(),
    problems: z.array(z.string()),
    checks: z.array(z.enum(READING_CHECKS)).openapi({
      description:
        'Checks this reading fails (FR-INT-04). sums: the subtotal, taxes and tip don’t make ' +
        'the total, allowing a minor unit per tax or tip line. future_date: dated more than a ' +
        'day after the upload. old_date: dated more than a year before it.',
    }),
  })
  .openapi('ReceiptReading');

const CorrectableFieldSchema = z.enum(CORRECTABLE_FIELDS);

export const ReceiptConfirmationSchema = z
  .object({
    by: z.string().openapi({ description: 'The member who confirmed it.' }),
    at: z.string().datetime(),
    model: z.string().openapi({ description: 'Whose reading was confirmed or corrected.' }),
    label: z.string().openapi({ example: 'GPT-5.6 Luna' }),
    values: z
      .object({
        merchant: z.string(),
        date: z.string(),
        currency: z.string(),
        total: MoneyFieldSchema,
        taxTotal: MoneyFieldSchema,
        tip: MoneyFieldSchema,
      })
      .openapi({ description: 'What the receipt is filed with.' }),
    corrections: z.array(
      z.object({
        field: CorrectableFieldSchema,
        read: z
          .string()
          .nullable()
          .openapi({ description: 'What the model read; null when it read nothing.' }),
        corrected: z.string(),
      }),
    ),
  })
  .openapi('ReceiptConfirmation');

export const ReceiptDetailSchema = ReceiptSummarySchema.extend({
  imageUrl: z
    .string()
    .nullable()
    .openapi({ description: 'A short-lived link to the original file (5 minutes).' }),
  readings: z.array(ReceiptReadingSchema),
  differences: z
    .array(z.string())
    .openapi({ description: 'Filing fields the two models read differently.' }),
  confirmation: ReceiptConfirmationSchema.nullable().openapi({
    description:
      'Set when a member confirmed this reading; the merchant, date and total above are then ' +
      'the confirmed values.',
  }),
}).openapi('ReceiptDetail');

const correction = (description: string, example: string) =>
  z.string().max(200).optional().openapi({ description, example });

export const ConfirmReceiptSchema = z
  .object({
    model: z.string().openapi({
      description: 'The reading to confirm, by model, from the receipt’s latest readings.',
      example: 'gpt-5.6-luna',
    }),
    corrections: z
      .object({
        merchant: correction('The merchant, as it should be filed.', 'Blue Bottle Coffee'),
        date: correction('The transaction date, YYYY-MM-DD.', '2026-09-24'),
        currency: correction('An ISO 4217 code. Amounts keep their printed value.', 'USD'),
        total: correction('A plain decimal in the receipt’s currency.', '65.00'),
        taxTotal: correction('A plain decimal in the receipt’s currency.', '5.20'),
        tip: correction('A plain decimal in the receipt’s currency.', '0.00'),
      })
      .strict()
      .optional()
      .openapi({ description: 'Only the fields the person changed. Omit to confirm as read.' }),
  })
  .openapi('ConfirmReceipt');

export const NeedsYouReasonSchema = z
  .object({
    code: z.enum(['failed', 'fallback', 'differ', 'checks', 'unsure']).openapi({
      description:
        'failed: no model could read it. fallback: only the fallback model read it. differ: ' +
        'the compared models read the filing fields differently. checks: its sums or date ' +
        'fail a check (FR-INT-04). unsure: a model was not confident, or one could not read it.',
    }),
    fields: z
      .array(z.string())
      .openapi({ description: 'differ: the filing fields read differently.' }),
    checks: z
      .array(z.enum(READING_CHECKS))
      .openapi({ description: 'checks: the checks the readings fail.' }),
    error: z.string().nullable().openapi({
      description: 'failed: why the first compared model could not read it, such as no_key.',
    }),
    by: z
      .string()
      .nullable()
      .openapi({ description: 'fallback: the model that read it.', example: 'GPT-5.6 Luna' }),
  })
  .openapi('NeedsYouReason');

export const InboxItemSchema = z
  .object({
    kind: z.literal('receipt'),
    receipt: ReceiptSummarySchema,
    reason: NeedsYouReasonSchema,
  })
  .openapi('InboxItem');

export const InboxSchema = z.object({ items: z.array(InboxItemSchema) }).openapi('Inbox');

export const ReceiptListSchema = z
  .object({
    receipts: z.array(ReceiptSummarySchema),
    comparison: z.object({
      receipts: z.number().int(),
      compared: z.number().int().openapi({ description: 'Receipts both models read.' }),
      agreed: z.number().int().openapi({ description: 'Of those, how many they read alike.' }),
      models: z.array(
        z.object({
          model: z.string(),
          label: z.string(),
          role: ReadingRoleSchema,
          readings: z.number().int(),
          confident: z.number().int(),
          failed: z.number().int(),
          averageLatencyMs: z.number().int().nullable(),
          costMicroUsd: z.number().int(),
        }),
      ),
    }),
    readingAvailable: z.boolean().openapi({
      description: 'Whether this server can hand receipts to the workflow runner for reading.',
    }),
  })
  .openapi('ReceiptList');

const ReceiptFileSchema = {
  contentType: z.enum(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf']),
  byteSize: z
    .number()
    .int()
    .min(1)
    .max(10 * 1024 * 1024)
    .openapi({ description: 'At most 10 MB (ADR-0014).' }),
  sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .openapi({ description: 'SHA-256 of the file, lowercase hex.' }),
};

export const ReceiptUploadRequestSchema = z
  .object(ReceiptFileSchema)
  .openapi('ReceiptUploadRequest');

export const ReceiptUploadTicketSchema = z
  .object({
    receiptId: z.string().uuid(),
    bucket: z.string(),
    path: z.string(),
    token: z.string().openapi({ description: 'Uploads one file to this path, once.' }),
  })
  .openapi('ReceiptUploadTicket');

export const FileReceiptSchema = z
  .object({
    id: z.string().uuid().openapi({ description: 'The receiptId from the upload ticket.' }),
    source: z.enum(['camera', 'upload']),
    ...ReceiptFileSchema,
  })
  .openapi('FileReceipt');

// Expenses (FR-EXP-01, FR-EXP-08, FR-EXP-09, ADR-0022)

export const ExpenseStatusSchema = z
  .enum(['processing', 'needs_review', 'ready', 'submitted', 'approved', 'settled'])
  .openapi({
    description:
      'processing while its receipt is read; ready when its receipt is Ready and merchant, ' +
      'date, currency and amount are filled in; needs_review otherwise. Submitted, approved ' +
      'and settled follow its report; approved is locked (FR-EXP-03).',
  });

const ExpenseAmountSchema = z
  .object({
    amountMinor: z.number().int().openapi({ description: 'Integer minor units, e.g. cents.' }),
    currency: z.string().openapi({ example: 'USD' }),
    decimal: z.string().openapi({ example: '6.50', description: 'The same amount, for display.' }),
  })
  .nullable();

const ExpenseFieldSchema = z.enum(['merchant', 'date', 'currency', 'amount']);

export const ExpenseSummarySchema = z
  .object({
    id: z.string().uuid(),
    status: ExpenseStatusSchema,
    source: z.enum(['camera', 'upload', 'email', 'card', 'manual', 'mileage']),
    owner: z.string().openapi({ description: 'The member whose expense it is.' }),
    merchant: z.string().nullable(),
    date: z.string().nullable(),
    amount: ExpenseAmountSchema,
    receiptId: z.string().uuid().nullable().openapi({ description: 'Its receipt, the proof.' }),
    trip: z
      .object({ id: z.string().uuid(), name: z.string() })
      .nullable()
      .openapi({ description: 'The trip it is filed to (FR-EXP-04), or null for none.' }),
    tripFiledBy: z.enum(['date', 'person']).openapi({
      description:
        'date: it files to the trip its date falls in, and moves when the dates do. person: a ' +
        'person chose its trip, or chose none, and filing by date leaves it there (ADR-0023).',
    }),
    matchesReceipt: z
      .boolean()
      .nullable()
      .openapi({
        description:
          'Whether merchant, date, currency and amount match what its receipt shows. Null without ' +
          'a receipt.',
      }),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .openapi('ExpenseSummary');

export const ExpenseDetailSchema = ExpenseSummarySchema.extend({
  editable: z
    .boolean()
    .openapi({ description: 'Whether it can be edited now: while it needs review or is Ready.' }),
  editedAt: z
    .string()
    .datetime()
    .nullable()
    .openapi({ description: 'When a person last edited it. A reading never overwrites an edit.' }),
  proof: z
    .object({
      receiptId: z.string().uuid(),
      status: ReceiptStatusSchema,
      confirmedBy: z
        .string()
        .nullable()
        .openapi({ description: 'Who confirmed the receipt’s reading, if anyone.' }),
      merchant: z.string().nullable(),
      date: z.string().nullable(),
      amount: ExpenseAmountSchema,
      differences: z
        .array(ExpenseFieldSchema)
        .openapi({ description: 'Where the expense differs from its receipt.' }),
    })
    .nullable()
    .openapi({ description: 'What its receipt shows (FR-EXP-08).' }),
}).openapi('ExpenseDetail');

export const ExpenseListSchema = z
  .object({ expenses: z.array(ExpenseSummarySchema) })
  .openapi('ExpenseList');

const edited = (description: string, example: string) =>
  z.string().max(200).optional().openapi({ description, example });

export const EditExpenseSchema = z
  .object({
    merchant: edited('The merchant.', 'Blue Bottle Coffee'),
    date: edited('The transaction date, YYYY-MM-DD.', '2026-09-24'),
    currency: edited('An ISO 4217 code. The amount keeps its written value.', 'USD'),
    amount: edited('A plain decimal in the expense’s currency.', '6.50'),
  })
  .strict()
  .refine((e) => Object.values(e).some((v) => v !== undefined), {
    message: 'Change at least one field.',
  })
  .openapi('EditExpense');

/** A calendar date, YYYY-MM-DD, that exists. */
const isoDate = () =>
  z
    .string()
    .refine(isIsoDate, 'Enter a date that exists, as YYYY-MM-DD.')
    .openapi({ format: 'date', example: '2026-09-22' });

export const ExpenseSearchSchema = z.object({
  q: z
    .string()
    .max(200)
    .optional()
    .openapi({ description: 'Part of the merchant’s name, in any case.', example: 'uber' }),
  from: isoDate().optional().openapi({ description: 'Dated on or after this day.' }),
  to: isoDate().optional().openapi({ description: 'Dated on or before this day.' }),
  amount: z
    .string()
    .regex(/^\d{1,15}(\.\d{1,3})?$/, 'Enter an amount such as 18.92.')
    .optional()
    .openapi({
      description:
        'The amount, as a plain decimal. It matches in every currency it can be written in: ' +
        '18.92 finds 18.92 dollars or euros and 18.920 dinars, never yen.',
      example: '18.92',
    }),
  tripId: z.string().uuid().optional().openapi({ description: 'On this trip.' }),
  onTrip: z
    .enum(['yes', 'no'])
    .optional()
    .openapi({ description: 'yes: on some trip. no: on none, such as everyday spend.' }),
});

export const SetExpenseTripSchema = z
  .union([
    z
      .object({
        tripId: z
          .string()
          .uuid()
          .nullable()
          .openapi({ description: 'The trip to put it on, or null for no trip.' }),
      })
      .strict(),
    z
      .object({
        byDate: z
          .literal(true)
          .openapi({ description: 'File it to the trip its date falls in again.' }),
      })
      .strict(),
  ])
  .openapi('SetExpenseTrip');

// Trips (FR-EXP-04, FR-INS-02, ADR-0023)

const TripTotalSchema = z.object({
  amountMinor: z.number().int(),
  currency: z.string(),
  decimal: z.string().openapi({ example: '1257.60' }),
});

export const TripSummarySchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().openapi({ example: 'Houston · Acme onsite' }),
    purpose: z.string().nullable().openapi({ example: 'Client onsite' }),
    primaryCity: z.string().nullable().openapi({ example: 'Houston' }),
    startDate: isoDate(),
    endDate: isoDate().openapi({ description: 'The last day, included.' }),
    days: z.number().int().openapi({ description: 'Days it covers, both ends included.' }),
    owner: z.string().openapi({ description: 'The member whose trip it is.' }),
    expenseCount: z.number().int(),
    readyCount: z
      .number()
      .int()
      .openapi({ description: 'Expenses that are Ready, or further along: submitted or later.' }),
    needsReviewCount: z.number().int(),
    totals: z.array(TripTotalSchema).openapi({
      description:
        'What its expenses add up to, one total per currency, never converted. Expenses with ' +
        'no amount yet count in none.',
    }),
    createdAt: z.string().datetime(),
  })
  .openapi('TripSummary');

export const TripDetailSchema = TripSummarySchema.extend({
  expenses: z
    .array(ExpenseSummarySchema)
    .openapi({ description: 'In date order; those with no date yet last.' }),
}).openapi('TripDetail');

export const TripListSchema = z.object({ trips: z.array(TripSummarySchema) }).openapi('TripList');

export const TripSearchSchema = z.object({
  q: z.string().max(200).optional().openapi({
    description: 'Part of the name, purpose or city, or of a merchant on the trip.',
    example: 'houston',
  }),
  from: isoDate().optional().openapi({ description: 'Trips that end on or after this day.' }),
  to: isoDate().optional().openapi({ description: 'Trips that start on or before this day.' }),
});

const tripText = (description: string, example: string) =>
  z.string().max(1000).openapi({ description, example });

export const CreateTripSchema = z
  .object({
    name: tripText('Up to 120 characters.', 'Houston · Acme onsite'),
    purpose: tripText('Why you went. Up to 500 characters.', 'Client onsite').nullable().optional(),
    primaryCity: tripText('Where. Up to 120 characters.', 'Houston').nullable().optional(),
    startDate: z.string().max(40).openapi({ description: 'YYYY-MM-DD.', example: '2026-09-22' }),
    endDate: z.string().max(40).openapi({
      description: 'YYYY-MM-DD, the last day, included. A trip is at most 366 days.',
      example: '2026-09-25',
    }),
  })
  .strict()
  .openapi('CreateTrip');

export const EditTripSchema = CreateTripSchema.partial()
  .strict()
  .refine((t) => Object.values(t).some((v) => v !== undefined), {
    message: 'Change at least one field.',
  })
  .openapi('EditTrip');

// Home (FR-INS-01, FR-EXP-02)

export const HomeQuerySchema = z.object({
  day: isoDate()
    .optional()
    .openapi({
      param: { name: 'day', in: 'query' },
      description:
        'Today on the person’s own calendar, from their device. Decides which trip is under ' +
        'way and which month is this one. Defaults to today in UTC.',
    }),
});

export const HomeSchema = z
  .object({
    day: isoDate().openapi({ description: 'The day Home was built for.' }),
    needsYou: z.object({
      count: z.number().int().openapi({ description: 'Everything that needs the person.' }),
      items: z.array(InboxItemSchema).openapi({ description: 'The newest few of them.' }),
    }),
    trip: z
      .object({
        when: z.enum(['now', 'next']).openapi({
          description: 'now: its dates include the day. next: it starts within 14 days.',
        }),
        day: z.number().int().openapi({ description: 'now: which day of the trip it is.' }),
        startsIn: z.number().int().openapi({ description: 'next: days until it starts.' }),
        trip: TripSummarySchema,
      })
      .nullable(),
    month: z.object({
      from: isoDate().openapi({ description: 'The first day of the month the day is in.' }),
      expenses: z.number().int().openapi({ description: 'Dated this month.' }),
      ready: z
        .number()
        .int()
        .openapi({ description: 'Of those, how many are Ready or further along.' }),
      spent: z
        .array(TripTotalSchema)
        .openapi({ description: 'One total per currency, never converted.' }),
      trips: z.number().int().openapi({ description: 'Trips that overlap the month.' }),
      notOnTrip: z.object({
        expenses: z.number().int(),
        spent: z.array(TripTotalSchema),
      }),
    }),
    reading: z.number().int().openapi({ description: 'Receipts still being read.' }),
    recentTrips: z
      .array(TripSummarySchema)
      .openapi({ description: 'The last trips to end before the day, latest first.' }),
  })
  .openapi('Home');
