import { isIsoDate, MERGE_FIELDS, SUPPORTED_CURRENCIES } from '@expensewise/domain';
import { CORRECTABLE_FIELDS, READING_CHECKS } from '@expensewise/extraction';
import { z } from '@hono/zod-openapi';
import { ExpenseCategorySchema } from './category-schemas.ts';
import { ORG_FEATURE_KEYS, type OrgFeatureKey } from './features.ts';

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

export const FeatureKeySchema = z
  .enum(ORG_FEATURE_KEYS as [OrgFeatureKey, ...OrgFeatureKey[]])
  .openapi('FeatureKey');

export const FeatureSchema = z
  .object({
    key: FeatureKeySchema,
    name: z.string().openapi({ example: 'Mileage' }),
    description: z.string().openapi({ description: 'What switching it on changes.' }),
    enabled: z.boolean(),
    source: z.enum(['default', 'organization', 'override']).openapi({
      description:
        "Where `enabled` comes from: the default (off), the organization's switch, or the " +
        "server's override, which beats the switch until it is removed.",
    }),
    switchedAt: z
      .string()
      .datetime()
      .nullable()
      .openapi({ description: 'When the organization last switched it, if it has.' }),
  })
  .openapi('Feature');

export const FeatureListSchema = z
  .object({
    features: z.array(FeatureSchema),
    canSwitch: z.boolean().openapi({ description: 'Whether the caller may switch features.' }),
  })
  .openapi('FeatureList');

export const SwitchFeatureSchema = z.object({ enabled: z.boolean() }).openapi('SwitchFeature');

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

const SourceLineSchema = z.string().nullable();

export const FieldSourcesSchema = z
  .object({
    merchant: SourceLineSchema,
    date: SourceLineSchema,
    time: SourceLineSchema,
    address: SourceLineSchema,
    currency: SourceLineSchema,
    total: SourceLineSchema,
    subtotal: SourceLineSchema,
    taxTotal: SourceLineSchema,
    tip: SourceLineSchema,
    fees: SourceLineSchema,
    cardLastFour: SourceLineSchema,
  })
  .nullable()
  .openapi('FieldSources', {
    description:
      'Where each field was read (receipts.field-sources, GAP-14): the line or lines of the ' +
      'receipt behind each field, as the model copied them, or null where it read none. Text ' +
      'only: the models say what the line says, not where on the image it is. Null for a ' +
      'reading made without them; left out altogether while the feature is off.',
  });

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
        fees: MoneyFieldSchema.openapi({
          description: 'Fees and surcharges that are neither tax nor tip, such as a booking fee.',
        }),
        cardLastFour: TextFieldSchema,
        time: TextFieldSchema.openapi({
          description: 'When it was bought, HH:MM local time, if printed (FR-INT-17).',
        }),
        address: TextFieldSchema.openapi({
          description: 'The merchant’s address as printed. Neither decides Ready.',
        }),
      })
      .nullable(),
    problems: z.array(z.string()),
    sources: FieldSourcesSchema.optional(),
    checks: z.array(z.enum(READING_CHECKS)).openapi({
      description:
        'Checks this reading fails (FR-INT-04). sums: the subtotal, taxes and tip don’t make ' +
        'the total, allowing a minor unit per tax or tip line. future_date: dated more than a ' +
        'day after the upload. old_date: dated more than a year before it. summary: a purchase ' +
        'summary, which shows what was ordered, not what was charged (Q10).',
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

const DuplicateAmountSchema = z
  .object({
    amountMinor: z.number().int().openapi({ description: 'Integer minor units, e.g. cents.' }),
    currency: z.string().openapi({ example: 'USD' }),
    decimal: z.string().openapi({ example: '31.42', description: 'The same amount, for display.' }),
  })
  .nullable();

const DuplicateSideSchema = z
  .object({
    receiptId: z.string().uuid(),
    source: z.enum(['camera', 'upload', 'email', 'card', 'manual', 'mileage']),
    contentType: z.string(),
    createdAt: z.string().datetime(),
    expenseId: z.string().uuid().nullable(),
    expenseStatus: z
      .enum(['processing', 'needs_review', 'ready', 'submitted', 'approved', 'settled'])
      .nullable(),
    merchant: z.string().nullable(),
    date: z.string().nullable(),
    amount: DuplicateAmountSchema,
    notes: z.string().nullable(),
    trip: z.object({ id: z.string().uuid(), name: z.string() }).nullable(),
    time: z.string().nullable().openapi({ description: 'When it was bought, HH:MM local time.' }),
    address: z.string().nullable(),
    city: z.string().nullable(),
    country: z.string().nullable().openapi({ description: 'ISO 3166-1 alpha-2.' }),
  })
  .openapi('DuplicateSide', {
    description: 'One receipt of a possible duplicate pair, with the expense it proves.',
  });

const DuplicateKindSchema = z.enum(['exact', 'possible']).openapi({
  description:
    'exact: the same merchant, day, time and total, and no other place. possible: the same ' +
    'purchase perhaps amended, such as a tip added, or matched on the total alone where the ' +
    'receipts don’t both say when and where (FR-INT-18, ADR-0031).',
});

export const PossibleDuplicateSchema = z
  .object({
    kind: DuplicateKindSchema,
    held: z.boolean().openapi({
      description:
        'Whether this receipt is the later copy, which needs a look until the person decides ' +
        'and is left out of totals meanwhile.',
    }),
    self: DuplicateSideSchema,
    other: DuplicateSideSchema,
  })
  .openapi('PossibleDuplicate');

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
  duplicates: z.array(PossibleDuplicateSchema).openapi({
    description:
      'Receipts that look like the same purchase as this one: same member, currency and ' +
      'total, dates a day apart at most, and a similar merchant (FR-INT-18).',
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

export const CorrectReceiptSchema = z
  .object({
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
      .refine((c) => Object.values(c).some((v) => v !== undefined), {
        message: 'Correct at least one field.',
      })
      .openapi({ description: 'The fields the person corrected, usually one.' }),
  })
  .openapi('CorrectReceipt');

export const NeedsYouReasonSchema = z
  .object({
    code: z.enum(['failed', 'duplicate', 'fallback', 'differ', 'checks', 'unsure']).openapi({
      description:
        'failed: no model could read it. duplicate: it looks like the same purchase as an ' +
        'earlier receipt (FR-INT-18). fallback: only the fallback model read it. differ: ' +
        'the compared models read the filing fields differently. checks: its sums or date ' +
        'fail a check, or it is a purchase summary (FR-INT-04). unsure: a model was not ' +
        'confident, or one could not read it.',
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
    duplicateOf: z
      .object({
        kind: DuplicateKindSchema,
        receiptId: z.string().uuid(),
        merchant: z.string().nullable(),
        date: z.string().nullable(),
        amount: DuplicateAmountSchema,
        createdAt: z.string().datetime(),
      })
      .nullable()
      .openapi({ description: 'duplicate: the earlier receipt it looks like.' }),
  })
  .openapi('NeedsYouReason');

const MergeFieldSchema = z.enum(MERGE_FIELDS);

export const ResolveDuplicateSchema = z
  .discriminatedUnion('action', [
    z.object({ action: z.literal('keep_both') }).openapi({
      description: 'Different purchases: both stay, and the pair is never flagged again.',
    }),
    z
      .object({
        action: z.literal('delete'),
        keep: z.string().uuid().openapi({ description: 'The receipt to keep, one of the two.' }),
      })
      .openapi({
        description:
          'The other receipt is deleted with its file, readings and expense. Its audit trail ' +
          'stays, saying what it was.',
      }),
    z
      .object({
        action: z.literal('merge'),
        primary: z.string().uuid().openapi({ description: 'The receipt to keep, one of the two.' }),
        fields: z
          .array(MergeFieldSchema)
          .max(MERGE_FIELDS.length)
          .openapi({
            description:
              'Fields the primary takes from the other even though it has them. It takes every ' +
              'field it lacks anyway. amount brings its currency.',
          }),
      })
      .openapi({
        description:
          'The primary’s expense takes the other’s missing and chosen fields, then the other ' +
          'is deleted as delete deletes it.',
      }),
  ])
  .openapi('ResolveDuplicate');

export const DuplicateResolutionSchema = z
  .object({
    outcome: z.enum(['kept_both', 'deleted', 'merged']),
    kept: z.string().uuid().openapi({
      description: 'The receipt that remains; for kept_both, the one in the path.',
    }),
    deleted: z.string().uuid().nullable().openapi({ description: 'The receipt deleted.' }),
    taken: z.array(MergeFieldSchema).openapi({
      description: 'merged: the fields the primary took from the receipt merged into it.',
    }),
  })
  .openapi('DuplicateResolution');

const ReceiptInboxItemSchema = z
  .object({
    kind: z.literal('receipt'),
    receipt: ReceiptSummarySchema,
    reason: NeedsYouReasonSchema,
  })
  .openapi('ReceiptInboxItem');

const CaptureTimeSchema = z
  .object({
    receipts: z
      .number()
      .int()
      .openapi({ description: 'How many of the receipts shown it is over: those read.' }),
    p95Ms: z
      .number()
      .int()
      .nullable()
      .openapi({
        description:
          'The 95th-percentile time from filing to the first settled reading, in whole ' +
          'milliseconds, by nearest rank: one of the times measured. Null with none read.',
      }),
    sloMs: z.number().int().openapi({ description: 'The goal: under 30 seconds (NFR-PERF-01).' }),
    withinSlo: z.boolean().nullable(),
  })
  .openapi('CaptureTime', {
    description:
      'Capture to Ready over the receipts shown (receipts.capture-time, NFR-PERF-01). A ' +
      'receipt counts once its first reading settles, Ready, needing a look or not read; the ' +
      'time a person then takes to confirm it is not counted. Left out while the feature is off.',
  });

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
    captureToReady: CaptureTimeSchema.optional(),
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
    local: z.boolean().openapi({
      description:
        'On no trip, with a date: a local expense, which needs a justification before its ' +
        'report can close (FR-EXP-14).',
    }),
    justification: z
      .string()
      .nullable()
      .openapi({ description: 'Why a local expense was for business.' }),
    reportId: z.string().uuid().nullable().openapi({
      description: 'The report it is on: its trip’s, or its own when local (FR-EXP-05).',
    }),
    // Only while categories and types are switched on (FR-EXP-11, FR-INT-10).
    category: ExpenseCategorySchema.optional(),
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
      time: z.string().nullable(),
      address: z.string().nullable(),
      city: z.string().nullable(),
      country: z.string().nullable(),
      detailDifferences: z.array(z.enum(['time', 'address', 'city', 'country'])).openapi({
        description:
          'Where its time or place differs from the receipt’s. Shown, never a reason to reject.',
      }),
    })
    .nullable()
    .openapi({ description: 'What its receipt shows (FR-EXP-08).' }),
  time: z
    .string()
    .nullable()
    .openapi({ description: 'When it was bought, HH:MM local time (FR-INT-17).' }),
  timeZone: z.string().nullable().openapi({
    description: 'The IANA time zone of that time: worked out from the place, or set by a person.',
    example: 'America/Chicago',
  }),
  address: z.string().nullable().openapi({ description: 'The merchant’s address as printed.' }),
  city: z.string().nullable(),
  region: z.string().nullable().openapi({ description: 'State, province or region.' }),
  country: z.string().nullable().openapi({ description: 'ISO 3166-1 alpha-2.', example: 'US' }),
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
    time: edited('When it was bought, HH:MM local time; blank clears it.', '18:42'),
    timeZone: edited(
      'An IANA time zone. Blank, it is worked out from the place; left out, it is worked out again when the place changes.',
      'America/Chicago',
    ),
    address: z.string().max(300).optional().openapi({ description: 'The address, as printed.' }),
    city: edited('The city or town.', 'Omaha'),
    region: edited('State, province or region.', 'NE'),
    country: edited('ISO 3166-1 alpha-2.', 'US'),
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

// Mileage (FR-CAP-03, NFR-DAT-04, ADR-0038)

export const MileageRateSchema = z
  .object({
    perUnit: z.string().openapi({
      example: '0.725',
      description: 'Currency units a mile, as a plain decimal: 72.5 cents is "0.725".',
    }),
    currency: z.string().openapi({ example: 'USD' }),
    unit: z.enum(['mi', 'km']),
    effectiveFrom: isoDate().openapi({ description: 'The day the rate took effect.' }),
    source: z.string().openapi({
      example: 'irs-business',
      description: 'Where it came from: irs-business is the IRS standard rate for business use.',
    }),
  })
  .openapi('MileageRate');

export const MileageSchema = z
  .object({
    date: isoDate().openapi({ description: 'The day of the drive.' }),
    destination: z.string().openapi({ example: 'IAH, George Bush Intercontinental' }),
    purpose: z.string().openapi({
      example: 'Drive to the airport for the Acme onsite',
      description: 'Why the drive was for business; also the expense’s justification.',
    }),
    miles: z.string().openapi({ example: '38.4', description: 'A plain decimal.' }),
    unit: z.enum(['mi', 'km']),
    method: z.enum(['manual', 'route', 'gps']).openapi({ description: 'manual: typed in.' }),
    rate: MileageRateSchema.openapi({
      description:
        'The rate in force on its date, copied on when it was logged and again when its date ' +
        'or miles changed, so a later rate never alters it (NFR-DAT-04).',
    }),
  })
  .openapi('Mileage');

export const MileageEntrySchema = ExpenseDetailSchema.extend({
  mileage: MileageSchema,
}).openapi('MileageEntry');

const mileageText = (description: string, example: string) =>
  z.string().max(1000).openapi({ description, example });

export const LogMileageSchema = z
  .object({
    date: z.string().max(40).openapi({
      description: 'YYYY-MM-DD: today at the latest, and a day the rate is known for.',
      example: '2026-09-22',
    }),
    destination: mileageText('Where you drove to. Up to 200 characters.', 'IAH'),
    purpose: mileageText(
      'Why the drive was for business. Up to 500 characters.',
      'Drive to the airport for the Acme onsite',
    ),
    miles: z.string().max(40).openapi({
      description: 'More than 0 and at most 1000, two decimal places at most.',
      example: '38.4',
    }),
  })
  .strict()
  .openapi('LogMileage');

export const EditMileageSchema = LogMileageSchema.partial()
  .strict()
  .refine((m) => Object.values(m).some((v) => v !== undefined), {
    message: 'Change at least one field.',
  })
  .openapi('EditMileage');

export const MileageQuoteQuerySchema = z.object({
  date: z.string().max(40).openapi({ description: 'YYYY-MM-DD.', example: '2026-09-22' }),
  miles: z.string().max(40).openapi({ description: 'A plain decimal.', example: '38.4' }),
});

export const MileageQuoteSchema = z
  .object({
    date: isoDate(),
    miles: z.string().openapi({ example: '38.4' }),
    rate: MileageRateSchema,
    amount: z.object({
      amountMinor: z.number().int().openapi({ example: 2784 }),
      currency: z.string().openapi({ example: 'USD' }),
      decimal: z.string().openapi({ example: '27.84' }),
    }),
  })
  .openapi('MileageQuote');

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
    reportId: z
      .string()
      .uuid()
      .nullable()
      .openapi({ description: 'The report it is on (FR-EXP-05), or null before it joins one.' }),
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

// Reports (FR-EXP-05, FR-EXP-12, FR-EXP-14, ADR-0029)

const TotalSchema = z.object({
  amountMinor: z.number().int(),
  currency: z.string(),
  decimal: z.string(),
});

export const ReportStatusSchema = z
  .enum(['open', 'closed', 'submitted', 'in_approval', 'approved', 'settled'])
  .openapi({
    description:
      'open: trips and local expenses join it. closed: done, by the person or on day 28, and ' +
      'reopenable until submitted. Submitting is the person’s own act (FR-EXP-12).',
  });

export const ReportSummarySchema = z
  .object({
    id: z.string().uuid(),
    title: z.string(),
    status: ReportStatusSchema,
    owner: z.string(),
    currency: z
      .string()
      .openapi({ description: 'What it is reimbursed in: the organization’s home currency.' }),
    openedAt: z.string().datetime(),
    closesAt: z
      .string()
      .datetime()
      .openapi({ description: 'When an open report closes itself: day 28, later if reopened.' }),
    closedAt: z.string().datetime().nullable(),
    tripNames: z.array(z.string()),
    trips: z.number().int(),
    localExpenses: z.number().int(),
    needsAttention: z
      .number()
      .int()
      .openapi({
        description:
          'Trips with an expense still being read or needing review, and local expenses needing ' +
          'review or a justification. It can’t close while any are left.',
      }),
    canClose: z.boolean(),
    warning: z.boolean().openapi({
      description: 'Open, in its last week, and something still needs review.',
    }),
    overdue: z.boolean().openapi({
      description: 'Open past its day 28, with nothing on it ready to close.',
    }),
    totals: z.array(TotalSchema).openapi({
      description:
        'One total per currency, never converted; possible duplicates are left out (until #62).',
    }),
  })
  .openapi('ReportSummary');

export const ReportDetailSchema = ReportSummarySchema.extend({
  tripItems: z.array(
    TripSummarySchema.extend({
      unsettled: z
        .number()
        .int()
        .openapi({ description: 'Its expenses still being read or needing review.' }),
      ready: z.boolean(),
    }),
  ),
  localItems: z.array(
    z.object({
      id: z.string().uuid(),
      status: ExpenseStatusSchema,
      merchant: z.string().nullable(),
      date: z.string().nullable(),
      amount: ExpenseAmountSchema,
      receiptId: z.string().uuid().nullable(),
      justification: z.string().nullable(),
      held: z.boolean().openapi({ description: 'Held as a possible duplicate (FR-INT-18).' }),
      ready: z.boolean(),
    }),
  ),
}).openapi('ReportDetail');

export const ReportListSchema = z
  .object({ reports: z.array(ReportSummarySchema) })
  .openapi('ReportList');

export const MoveToReportSchema = z
  .union([
    z.object({ reportId: z.string().uuid() }).strict(),
    z.object({ newReport: z.literal(true) }).strict(),
  ])
  .openapi('MoveToReport', {
    description: 'An open report of the same person, or a new one.',
  });

export const ReportMoveResultSchema = z
  .object({
    reportId: z.string().uuid().openapi({ description: 'The report it is on now.' }),
    dropped: z
      .string()
      .uuid()
      .nullable()
      .openapi({ description: 'The report it left, when that left it holding nothing.' }),
  })
  .openapi('ReportMoveResult');

export const JustifyExpenseSchema = z
  .object({
    justification: z.string().max(2000).openapi({
      description: 'Why it was for business, up to 500 characters; blank removes it.',
      example: 'Lunch with the Acme team about the Q4 rollout',
    }),
  })
  .strict()
  .openapi('JustifyExpense');

export const JustificationSchema = z
  .object({ justification: z.string().nullable() })
  .openapi('Justification');

const ReportInboxItemSchema = z
  .object({
    kind: z.literal('report'),
    report: ReportSummarySchema,
    reason: z.object({
      code: z.enum(['overdue', 'closing_soon', 'ready_to_close']).openapi({
        description:
          'overdue: past day 28 and nothing ready. closing_soon: in its last week, something ' +
          'still needing review, so reimbursement may wait. ready_to_close: nothing left to do.',
      }),
    }),
  })
  .openapi('ReportInboxItem');

const ExpenseInboxItemSchema = z
  .object({
    kind: z.literal('expense'),
    expense: z.object({
      id: z.string().uuid(),
      merchant: z.string().nullable(),
      date: z.string().nullable(),
      amount: ExpenseAmountSchema,
      receiptId: z.string().uuid().nullable(),
    }),
    reason: z.object({
      code: z.enum(['justification']).openapi({
        description: 'justification: a local expense says nothing yet of why (FR-EXP-14).',
      }),
    }),
  })
  .openapi('ExpenseInboxItem');

export const InboxItemSchema = z
  .discriminatedUnion('kind', [
    ReceiptInboxItemSchema,
    ReportInboxItemSchema,
    ExpenseInboxItemSchema,
  ])
  .openapi('InboxItem');

export const InboxSchema = z.object({ items: z.array(InboxItemSchema) }).openapi('Inbox');

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
    reports: z.array(ReportSummarySchema).openapi({
      description: 'Reports to finish: the open and closed ones, newest first (Q15).',
    }),
    recentTrips: z
      .array(TripSummarySchema)
      .openapi({ description: 'The last trips to end before the day, latest first.' }),
  })
  .openapi('Home');

/**
 * A Bird webhook: the Standard Webhooks envelope. Only an arriving mailbox message is read;
 * any other event is acknowledged whatever its data holds, since Bird's other events use
 * fields of the same names differently (email.received's message_id may be null).
 */
export const BirdWebhookSchema = z
  .object({
    type: z.string().openapi({ example: 'email_mailbox.message_received' }),
    timestamp: z.string().optional(),
    data: z.looseObject({}).openapi({
      description:
        'For email_mailbox.message_received, message_id (rem_…) and thread_id (thr_…) are ' +
        'read; the email itself is fetched later. Nothing else is read.',
    }),
  })
  .openapi('BirdWebhook');

/** The ids email-in reads from an arriving mailbox message, which go into Bird's URL. */
export const BirdMessageReceivedSchema = z.object({
  message_id: z.string().regex(/^rem_[0-9a-z]{1,64}$/),
  thread_id: z.string().regex(/^thr_[0-9a-z]{1,64}$/),
});

export const WebhookReceiptSchema = z
  .object({
    status: z.enum(['accepted', 'ignored']).openapi({
      description: 'accepted: the email will be read. ignored: an event email-in does not use.',
    }),
  })
  .openapi('WebhookReceipt');
