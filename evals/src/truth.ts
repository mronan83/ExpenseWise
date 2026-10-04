import type { DocumentMediaType, DocumentType } from '@expensewise/extraction';

export const SOURCES = [
  'cord',
  'synthetic-folio',
  'synthetic-eticket',
  'synthetic-receipt',
] as const;
export type Source = (typeof SOURCES)[number];

/**
 * The known answer for one eval document. Amounts are decimal strings in `currency`.
 * A field is present only when the document prints it, so it is scored only then.
 */
export interface GroundTruth {
  readonly id: string;
  readonly source: Source;
  /** Path relative to the data cache directory. */
  readonly file: string;
  readonly mediaType: DocumentMediaType;
  readonly documentType: DocumentType;
  readonly currency: string;
  readonly total: string;
  readonly merchant?: string;
  readonly date?: string;
  readonly subtotal?: string;
  readonly taxTotal?: string;
  readonly tip?: string;
  readonly cardLastFour?: string;
  /** When it was bought, HH:MM on a 24-hour clock (FR-INT-17). */
  readonly time?: string;
  /** The merchant's city and ISO 3166-1 alpha-2 country, when the document prints them. */
  readonly city?: string;
  readonly country?: string;
}

export interface Manifest {
  readonly createdAt: string;
  readonly items: readonly GroundTruth[];
}
