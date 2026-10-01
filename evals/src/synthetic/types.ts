import type { GroundTruth } from '../truth.ts';

/** A generated document before rendering: its known answers and its HTML. */
export interface SyntheticDocument {
  readonly truth: Omit<GroundTruth, 'id' | 'file' | 'mediaType' | 'source'>;
  readonly html: string;
  /** PDFs keep a text layer; photos are rendered as tilted, softened PNGs. */
  readonly format: 'pdf' | 'photo';
}

export const CARD_BRANDS = ['VISA', 'MASTERCARD', 'AMEX', 'DISCOVER'] as const;
