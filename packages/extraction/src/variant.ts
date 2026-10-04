import {
  PROMPT_VERSION,
  SOURCES_PROMPT_VERSION,
  SOURCES_SYSTEM_PROMPT,
  SYSTEM_PROMPT,
} from './prompt.ts';
import {
  ReceiptExtractionSchema,
  ReceiptExtractionWithSourcesSchema,
  SCHEMA_VERSION,
  SOURCES_SCHEMA_VERSION,
} from './schema.ts';

/** How an extractor asks: the instructions, the structure and the versions stored with them. */
export interface ExtractorOptions {
  /**
   * Ask for the line of the document each field was read from: for an organization that has
   * switched on `receipts.field-sources` (GAP-14). Off, the request is receipt-v3's, unchanged.
   */
  readonly fieldSources?: boolean;
}

/** The two requests a reader can send: as every organization's, and with source lines. */
export const EXTRACTION_VARIANTS = {
  plain: {
    promptVersion: PROMPT_VERSION,
    schemaVersion: SCHEMA_VERSION,
    system: SYSTEM_PROMPT,
    schema: ReceiptExtractionSchema,
  },
  sources: {
    promptVersion: SOURCES_PROMPT_VERSION,
    schemaVersion: SOURCES_SCHEMA_VERSION,
    system: SOURCES_SYSTEM_PROMPT,
    schema: ReceiptExtractionWithSourcesSchema,
  },
} as const;

export type ExtractionVariant = (typeof EXTRACTION_VARIANTS)[keyof typeof EXTRACTION_VARIANTS];

export const variantOf = (options: ExtractorOptions = {}): ExtractionVariant =>
  options.fieldSources ? EXTRACTION_VARIANTS.sources : EXTRACTION_VARIANTS.plain;
