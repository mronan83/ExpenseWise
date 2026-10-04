import { z } from 'zod';

/**
 * What the model returns for one receipt (ADR-0006). Amounts stay decimal strings here;
 * they become integer minor units only through the domain helpers in normalize.ts.
 * Each field carries the model's confidence, which drives Ready vs Needs review.
 */
export const Confidence = z
  .enum(['high', 'medium', 'low'])
  .describe('high: printed clearly and unambiguous. medium: readable but inferred. low: a guess.');

const amount = z
  .string()
  .describe(
    'Decimal amount with "." as the decimal separator, no thousands separators and no currency ' +
      'symbol, for example "1234.56". Convert local formats: Indonesian "60.000" is "60000".',
  );

const Amount = z.object({ value: amount, confidence: Confidence });

const Fees = z.array(z.object({ label: z.string(), value: amount, confidence: Confidence }));

export const DOCUMENT_TYPES = [
  'receipt',
  'hotel_folio',
  'airline_ticket',
  'ride_receipt',
  'invoice',
  'purchase_summary',
  'other',
] as const;

/** Changes whenever ReceiptExtractionSchema changes, and is stored with every reading. */
export const SCHEMA_VERSION = 'receipt-v3';

const Time = z
  .object({
    value: z
      .string()
      .describe(
        'Time of the purchase as printed, on a 24-hour clock as HH:MM, for example "18:42". ' +
          'Local time where it was bought; never convert it.',
      ),
    confidence: Confidence,
  })
  .nullable()
  .describe('When it was bought, if the document prints a time. Null if it prints none.');

const Address = z
  .object({
    printed: z.string().describe("The merchant's address as printed, lines joined with commas."),
    city: z.string().nullable().describe('The city or town, as printed.'),
    region: z
      .string()
      .nullable()
      .describe('The state, province or region, as printed, for example "CA" or "Ontario".'),
    country: z
      .string()
      .nullable()
      .describe(
        'ISO 3166-1 alpha-2 country code such as US or DE. Infer it from the address, the ' +
          'phone number or the currency if it is not printed.',
      ),
    confidence: Confidence,
  })
  .nullable()
  .describe(
    "Where it was bought: the merchant's address, if the document prints one. Null if not.",
  );

export const ReceiptExtractionSchema = z.object({
  documentType: z.enum(DOCUMENT_TYPES),
  merchant: z
    .object({
      name: z.string().describe('The business that was paid, as printed, without the address.'),
      confidence: Confidence,
    })
    .nullable(),
  date: z
    .object({
      value: z
        .string()
        .describe(
          'Transaction date as YYYY-MM-DD. For a hotel folio, the departure date. ' +
            'For an airline ticket, the issue date.',
        ),
      confidence: Confidence,
    })
    .nullable(),
  currency: z
    .object({
      code: z
        .string()
        .describe(
          'ISO 4217 code such as USD. Infer it from symbols and the country if not printed.',
        ),
      confidence: Confidence,
    })
    .nullable(),
  total: Amount.nullable().describe('The amount actually charged, including taxes, fees and tip.'),
  subtotal: Amount.nullable().describe('The amount before taxes, fees and tip, when printed.'),
  taxes: z
    .array(z.object({ label: z.string(), value: amount, confidence: Confidence }))
    .describe('Each tax line, such as sales tax, VAT or a city tax. Exclude tips and fees.'),
  fees: Fees.describe(
    'Each fee or surcharge the total includes that is neither a tax nor a tip, such as a ' +
      'booking, service, delivery or airport fee.',
  ),
  tip: Amount.nullable(),
  cardLastFour: z
    .object({
      value: z.string().describe('Exactly four digits.'),
      confidence: Confidence,
    })
    .nullable(),
  time: Time,
  address: Address,
  lineItems: z.array(
    z.object({
      description: z.string(),
      quantity: z.string().nullable(),
      amount,
    }),
  ),
});

export type ReceiptExtraction = z.infer<typeof ReceiptExtractionSchema>;

const SourceLine = z
  .string()
  .nullable()
  .describe(
    'The line or lines of the document this was read from, copied exactly as printed, lines ' +
      'joined with " / ". Null when it was not read.',
  );

/**
 * Where each field was read: the line of the document behind it, as printed (GAP-14). Text
 * only: the models say what the line says, not where on the image it is.
 */
export const FieldSourcesSchema = z.object({
  merchant: SourceLine,
  date: SourceLine,
  time: SourceLine,
  address: SourceLine,
  currency: SourceLine,
  total: SourceLine,
  subtotal: SourceLine,
  taxes: SourceLine,
  tip: SourceLine,
  fees: SourceLine,
  cardLastFour: SourceLine,
});
export type FieldSources = z.infer<typeof FieldSourcesSchema>;

/**
 * The schema for an organization that has switched on where each field was read: every field
 * of receipt-v3, and the line each was read from. receipt-v3 stays what every other
 * organization's readings are asked for, unchanged.
 */
export const ReceiptExtractionWithSourcesSchema = ReceiptExtractionSchema.extend({
  sources: FieldSourcesSchema,
});
export const SOURCES_SCHEMA_VERSION = 'receipt-v4';

/** The line each field of a stored reading was read from; null for a reading without them. */
export function sourcesOf(output: unknown): FieldSources | null {
  const sources = (output as { sources?: unknown } | null)?.sources;
  const parsed = FieldSourcesSchema.safeParse(sources);
  return parsed.success ? parsed.data : null;
}

/**
 * A stored reading, as the models' output is parsed back. Readings made before fees were read
 * (receipt-v1) have none, and those made before time and place were read (receipt-v2) have
 * neither, which they parse as.
 */
export const StoredReadingSchema = ReceiptExtractionSchema.extend({
  fees: Fees.default([]),
  time: Time.default(null),
  address: Address.default(null),
});
export type ConfidenceLevel = z.infer<typeof Confidence>;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];
