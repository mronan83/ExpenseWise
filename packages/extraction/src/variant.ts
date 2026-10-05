import type { z } from 'zod';
import {
  JOURNEYS_INSTRUCTIONS,
  PROMPT_VERSION,
  SOURCES_PROMPT_VERSION,
  SOURCES_SYSTEM_PROMPT,
  SYSTEM_PROMPT,
} from './prompt.ts';
import {
  JOURNEYS_SHAPE,
  JOURNEYS_VERSION,
  ReceiptExtractionSchema,
  ReceiptExtractionWithSourcesSchema,
  SCHEMA_VERSION,
  SOURCES_SCHEMA_VERSION,
} from './schema.ts';

/** How an extractor asks: which additions to the instructions and the structure it sends. */
export interface ExtractorOptions {
  /**
   * Ask for the line of the document each field was read from: for an organization that has
   * switched on `receipts.field-sources` (GAP-14). Off, the request is receipt-v5's, with
   * nothing added.
   */
  readonly fieldSources?: boolean;
  /**
   * Ask where a journey went and when a stay was: for an organization that has switched on
   * `receipts.journeys` (FR-INT-20, FR-INT-21). Off, nothing of it is asked.
   */
  readonly journeys?: boolean;
}

/** One request a reader can send: the instructions, the structure, and their versions. */
export interface ExtractionVariant {
  readonly promptVersion: string;
  readonly schemaVersion: string;
  readonly system: string;
  readonly schema: z.ZodObject;
}

/**
 * The requests as they were before additions composed: every organization's, and with source
 * lines, which keeps its own versions from when it was the only variant. Both changed for every
 * organization with #92 (`extract-v5` and `receipt-v5`, and with source lines `extract-v6` and
 * `receipt-v6`, as `extract-v4` was `extract-v3` with them); a reading keeps the versions it was
 * made with.
 */
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
} as const satisfies Record<string, ExtractionVariant>;

/** An addition to a request: more instructions, more structure, and its version. */
interface Addition {
  readonly instructions: string;
  readonly shape: z.ZodRawShape;
  readonly version: string;
}

const JOURNEYS: Addition = {
  instructions: JOURNEYS_INSTRUCTIONS,
  shape: JOURNEYS_SHAPE,
  version: JOURNEYS_VERSION,
};

/**
 * A request with an addition: its instructions after the others, its structure after the
 * others' (a field it redefines keeps its place), and its version joined on with "+", as in
 * `receipt-v5+journeys-v1`.
 */
const withAddition = (variant: ExtractionVariant, addition: Addition): ExtractionVariant => ({
  promptVersion: `${variant.promptVersion}+${addition.version}`,
  schemaVersion: `${variant.schemaVersion}+${addition.version}`,
  system: `${variant.system}\n${addition.instructions}`,
  schema: variant.schema.extend(addition.shape),
});

const composed = new Map<string, ExtractionVariant>();

/**
 * The request for these options, made once each: source lines and journeys are independent,
 * so each organization is asked for exactly what it has switched on. With both off it is the
 * request every reading has always sent.
 */
export function variantOf(options: ExtractorOptions = {}): ExtractionVariant {
  const base = options.fieldSources ? EXTRACTION_VARIANTS.sources : EXTRACTION_VARIANTS.plain;
  if (!options.journeys) return base;
  const key = `${base.schemaVersion}+journeys`;
  let variant = composed.get(key);
  if (!variant) {
    variant = withAddition(base, JOURNEYS);
    composed.set(key, variant);
  }
  return variant;
}
