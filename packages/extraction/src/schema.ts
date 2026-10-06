import { z } from 'zod';

/**
 * What the model returns for one receipt (ADR-0006). Amounts stay decimal strings here;
 * they become integer minor units only through the domain helpers in normalize.ts.
 * Each field carries the model's confidence, which drives Ready vs Needs review.
 */
export const Confidence = z
  .enum(['high', 'medium', 'low'])
  .describe('high: printed clearly and unambiguous. medium: readable but inferred. low: a guess.');

const DECIMAL =
  'Decimal amount with "." as the decimal separator, no thousands separators and no currency ' +
  'symbol, for example "1234.56". Convert local formats: Indonesian "60.000" is "60000".';

const amount = z.string().describe(DECIMAL);

/**
 * A line's amount as printed, which a credit makes negative (#92). Its own description, so the
 * other amounts' stay as they were.
 */
const lineAmount = z
  .string()
  .describe(
    `${DECIMAL} The line's amount as printed: for a quantity, the line's amount, not the ` +
      'price of one. A discount, credit, refund or reversal is negative, for example "-68.00".',
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

/**
 * Every kind of document a reading can say it is. A rail ticket is offered only where journeys
 * are asked for (`receipts.journeys`), so every other organization's request stays as it was.
 */
export const JOURNEY_DOCUMENT_TYPES = [
  'receipt',
  'hotel_folio',
  'airline_ticket',
  'ride_receipt',
  'rail_ticket',
  'invoice',
  'purchase_summary',
  'other',
] as const;

/** The documents whose journey is read: where it went from and to (FR-INT-20, Q39). */
export const JOURNEY_DOCUMENTS: readonly DocumentType[] = [
  'ride_receipt',
  'airline_ticket',
  'rail_ticket',
];

/** The document whose stay is read: its check-in and check-out (FR-INT-21). */
export const STAY_DOCUMENTS: readonly DocumentType[] = ['hotel_folio'];

/**
 * Changes whenever ReceiptExtractionSchema changes, and is stored with every reading. receipt-v5
 * asks for every line each time it is printed, a credit as a negative line, and a folio's total
 * as what was charged (#92); a reading made before keeps receipt-v3.
 */
export const SCHEMA_VERSION = 'receipt-v5';

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
  total: Amount.nullable().describe(
    'The amount actually charged, including taxes, fees and tip, after any credits. For a hotel ' +
      'folio, the payment to the card where one is printed, never the balance left after it, ' +
      'which is often 0.00.',
  ),
  subtotal: Amount.nullable().describe('The amount before taxes, fees and tip, when printed.'),
  taxes: z
    .array(z.object({ label: z.string(), value: amount, confidence: Confidence }))
    .describe(
      'Each tax line, such as sales tax, VAT or a city tax, each time it is printed: a tax ' +
        'charged for each night is a line for each night. Never merge them, and never add a ' +
        'total the document prints of them, such as "Total taxes", as another line. A credit of ' +
        'a tax is negative. Exclude tips and fees.',
    ),
  fees: Fees.describe(
    'Each fee or surcharge the total includes that is neither a tax nor a tip, such as a ' +
      'booking, service, delivery or airport fee, each time it is printed.',
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
  lineItems: z
    .array(
      z.object({
        description: z.string().describe('As printed.'),
        quantity: z.string().nullable(),
        amount: lineAmount,
      }),
    )
    .describe(
      'Every item line the document charges or credits, in the order printed, each time it is ' +
        "printed: a hotel folio's room charge for each night is a line of its own. A credit, " +
        'refund, reversal, adjustment or discount is a line of its own with a negative amount, ' +
        'never netted into the charge it reverses. Not taxes, fees, the tip, a total of other ' +
        'lines, or a payment.',
    ),
});

const JourneyEnd = (where: string) =>
  z
    .object({
      value: z.string().describe(`${where}, exactly as printed.`),
      confidence: Confidence,
    })
    .nullable()
    .describe('Null if the document does not print it.');

const journeyEnds = {
  from: JourneyEnd(
    "Where it started: a ride's pickup address, a flight's origin airport code or city, a " +
      "train's departure station",
  ),
  to: JourneyEnd(
    "Where it ended: a ride's drop-off address, a flight's destination airport code or city, " +
      "a train's arrival station",
  ),
};

const Departs = z
  .object({
    value: z
      .string()
      .describe(
        'The date its first leg departs as YYYY-MM-DD: the day of travel, never the day it ' +
          'was bought or the receipt was issued.',
      ),
    confidence: Confidence,
  })
  .nullable()
  .describe('Null if the document does not print when it departs.');

const JOURNEY_DESCRIPTION =
  'For a ride receipt, an airline ticket or a rail ticket: where the journey went. Null for ' +
  'any other document, or when it prints neither end.';

const Journey = z
  .object({ ...journeyEnds, departs: Departs })
  .nullable()
  .describe(JOURNEY_DESCRIPTION);

/** A journey as any reading has it: one read before `journeys-v2` has no departs. */
const JourneyRead = z
  .object({ ...journeyEnds, departs: Departs.optional() })
  .nullable()
  .describe(JOURNEY_DESCRIPTION);

const StayDate = (which: string) =>
  z
    .object({
      value: z.string().describe(`The ${which} date as YYYY-MM-DD.`),
      confidence: Confidence,
    })
    .nullable()
    .describe('Null if the folio does not print it.');

const Stay = z
  .object({ checkIn: StayDate('check-in (arrival)'), checkOut: StayDate('check-out (departure)') })
  .nullable()
  .describe('For a hotel folio: the stay it bills. Null for any other document.');

/**
 * What an organization that has switched on Journeys and stays is also asked (FR-INT-20,
 * FR-INT-21, Q39): a rail ticket as a kind of document, where a journey went, and a stay's
 * dates. Added to whichever schema it is asked with; every other organization's is unchanged.
 */
export const JOURNEYS_SHAPE = {
  documentType: z.enum(JOURNEY_DOCUMENT_TYPES),
  journey: Journey,
  stay: Stay,
};
export const JOURNEYS_VERSION = 'journeys-v2';

/**
 * Any reading, as asked with any of the additions: a rail ticket among the documents, and a
 * journey and a stay present only where they were asked for.
 */
const ReadingSchema = ReceiptExtractionSchema.extend({
  documentType: z.enum(JOURNEY_DOCUMENT_TYPES),
  journey: JourneyRead.optional(),
  stay: Stay.optional(),
});

export type ReceiptExtraction = z.infer<typeof ReadingSchema>;

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
 * of receipt-v5, and the line each was read from, as receipt-v4 was receipt-v3's. receipt-v5
 * stays what every other organization's readings are asked for, with nothing added.
 */
export const ReceiptExtractionWithSourcesSchema = ReceiptExtractionSchema.extend({
  sources: FieldSourcesSchema,
});
export const SOURCES_SCHEMA_VERSION = 'receipt-v6';

/** The line each field of a stored reading was read from; null for a reading without them. */
export function sourcesOf(output: unknown): FieldSources | null {
  const sources = (output as { sources?: unknown } | null)?.sources;
  const parsed = FieldSourcesSchema.safeParse(sources);
  return parsed.success ? parsed.data : null;
}

/**
 * A stored reading, as the models' output is parsed back. Readings made before fees were read
 * (receipt-v1) have none, and those made before time and place were read (receipt-v2) have
 * neither, which they parse as. A reading not asked for journeys and stays has neither key,
 * and keeps none: absent is not asked, null is asked and not read.
 */
export const StoredReadingSchema = ReadingSchema.extend({
  fees: Fees.default([]),
  time: Time.default(null),
  address: Address.default(null),
});
export type ConfidenceLevel = z.infer<typeof Confidence>;
export type DocumentType = (typeof JOURNEY_DOCUMENT_TYPES)[number];
