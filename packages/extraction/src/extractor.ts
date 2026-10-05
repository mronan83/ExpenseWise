import type { ModelId, TokenUsage } from './models.ts';
import type { ReceiptExtraction } from './schema.ts';

export const SUPPORTED_MEDIA_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'application/pdf',
] as const;

export type DocumentMediaType = (typeof SUPPORTED_MEDIA_TYPES)[number];

export interface ExtractionInput {
  readonly bytes: Uint8Array;
  readonly mediaType: DocumentMediaType;
}

/**
 * One extraction attempt and everything needed to audit it later (ADR-0006): the model,
 * prompt version, latency, tokens and cost travel with the output.
 */
export interface ExtractionRun {
  readonly outcome: 'extracted' | 'refused' | 'truncated' | 'invalid';
  readonly extraction: ReceiptExtraction | null;
  readonly model: ModelId;
  readonly promptVersion: string;
  /** The structure asked for; receipt-v5 when not given (ADR-0006). */
  readonly schemaVersion?: string;
  readonly latencyMs: number;
  readonly usage: TokenUsage;
  readonly costNanoUsd: bigint;
}

/** The pipeline's only view of extraction, so the model or provider can change behind it. */
export interface Extractor {
  readonly model: ModelId;
  extract(input: ExtractionInput): Promise<ExtractionRun>;
}
