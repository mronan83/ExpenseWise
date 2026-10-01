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

export const DOCUMENT_TYPES = [
  'receipt',
  'hotel_folio',
  'airline_ticket',
  'ride_receipt',
  'invoice',
  'other',
] as const;

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
  total: Amount.nullable().describe('The amount actually charged, including taxes and tip.'),
  subtotal: Amount.nullable().describe('The amount before taxes and tip, when printed.'),
  taxes: z
    .array(z.object({ label: z.string(), value: amount, confidence: Confidence }))
    .describe('Each tax or government fee line. Exclude tips and service charges.'),
  tip: Amount.nullable(),
  cardLastFour: z
    .object({
      value: z.string().describe('Exactly four digits.'),
      confidence: Confidence,
    })
    .nullable(),
  lineItems: z.array(
    z.object({
      description: z.string(),
      quantity: z.string().nullable(),
      amount,
    }),
  ),
});

export type ReceiptExtraction = z.infer<typeof ReceiptExtractionSchema>;
export type ConfidenceLevel = z.infer<typeof Confidence>;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];
