import { SUPPORTED_CURRENCIES } from '@expensewise/domain';
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
  })
  .nullable();

export const ReceiptStatusSchema = z.enum(['processing', 'extracted', 'needs_review', 'failed']);

export const ReceiptSummarySchema = z
  .object({
    id: z.string().uuid(),
    status: ReceiptStatusSchema.openapi({
      description:
        'processing while it is read; extracted when both compared models read it with ' +
        'confidence and agree; needs_review otherwise, including when only the fallback model ' +
        'read it; failed when no model could read it.',
    }),
    source: z.enum(['camera', 'upload', 'email', 'card', 'manual', 'mileage']),
    contentType: z.string(),
    byteSize: z.number().int(),
    uploadedBy: z.string(),
    createdAt: z.string().datetime(),
    merchant: z.string().nullable(),
    date: z.string().nullable(),
    total: MoneyFieldSchema,
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
  })
  .openapi('ReceiptReading');

export const ReceiptDetailSchema = ReceiptSummarySchema.extend({
  imageUrl: z
    .string()
    .nullable()
    .openapi({ description: 'A short-lived link to the original file (5 minutes).' }),
  readings: z.array(ReceiptReadingSchema),
  differences: z
    .array(z.string())
    .openapi({ description: 'Filing fields the two models read differently.' }),
}).openapi('ReceiptDetail');

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
