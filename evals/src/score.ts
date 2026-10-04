import { assertCurrency, fromDecimal } from '@expensewise/domain';
import {
  isAutoReady,
  normalizeExtraction,
  sameMerchant,
  type ConfidenceLevel,
  type ExtractionRun,
  type NormalizedExtraction,
} from '@expensewise/extraction';
import type { GroundTruth } from './truth.ts';

export const FIELDS = [
  'documentType',
  'merchant',
  'date',
  'currency',
  'total',
  'subtotal',
  'taxTotal',
  'tip',
  'cardLastFour',
  'time',
  'city',
  'country',
] as const;
export type FieldName = (typeof FIELDS)[number];

export interface FieldScore {
  readonly field: FieldName;
  readonly correct: boolean;
  /** The model's confidence, or null when it returned nothing for the field. */
  readonly confidence: ConfidenceLevel | null;
}

export interface DocumentScore {
  readonly fields: readonly FieldScore[];
  readonly allCorrect: boolean;
  /** The pipeline would file it as Ready with no human look. */
  readonly autoReady: boolean;
  /** Filed as Ready while a scored field is wrong: the failure that matters most. */
  readonly silentError: boolean;
}

export { sameMerchant };

type Run = Pick<ExtractionRun, 'outcome' | 'extraction'>;

/**
 * When an eval receipt counts as captured: on the day it is dated, as most receipts are.
 * Eval receipts are often old, and judging them against today would fail each on its date.
 */
const capturedAt = (truth: GroundTruth, n: NormalizedExtraction) =>
  new Date(`${truth.date ?? n.date?.value ?? '2026-01-01'}T12:00:00Z`);

/** Scores every field the document prints. Fields the truth lacks are not scored. */
export function scoreDocument(truth: GroundTruth, run: Run): DocumentScore {
  const n: NormalizedExtraction | null =
    run.outcome === 'extracted' && run.extraction
      ? normalizeExtraction(run.extraction, { fallbackCurrency: assertCurrency(truth.currency) })
      : null;

  const money = (expected: string | undefined, actual: NormalizedExtraction['total']) =>
    expected === undefined
      ? undefined
      : actual !== null &&
        actual.value.amountMinor === fromDecimal(expected, truth.currency).amountMinor;

  const checks: [FieldName, boolean | undefined, ConfidenceLevel | null][] = n
    ? [
        ['documentType', n.documentType === truth.documentType, 'high'],
        [
          'merchant',
          truth.merchant === undefined
            ? undefined
            : n.merchant !== null && sameMerchant(truth.merchant, n.merchant.value),
          n.merchant?.confidence ?? null,
        ],
        [
          'date',
          truth.date === undefined ? undefined : n.date?.value === truth.date,
          n.date?.confidence ?? null,
        ],
        ['currency', n.currency?.value === truth.currency, n.currency?.confidence ?? null],
        ['total', money(truth.total, n.total), n.total?.confidence ?? null],
        ['subtotal', money(truth.subtotal, n.subtotal), n.subtotal?.confidence ?? null],
        ['taxTotal', money(truth.taxTotal, n.taxTotal), n.taxTotal?.confidence ?? null],
        ['tip', money(truth.tip, n.tip), n.tip?.confidence ?? null],
        [
          'cardLastFour',
          truth.cardLastFour === undefined
            ? undefined
            : n.cardLastFour?.value === truth.cardLastFour,
          n.cardLastFour?.confidence ?? null,
        ],
        [
          'time',
          truth.time === undefined ? undefined : n.time?.value === truth.time,
          n.time?.confidence ?? null,
        ],
        [
          'city',
          truth.city === undefined
            ? undefined
            : n.place?.value.city?.trim().toLowerCase() === truth.city.toLowerCase(),
          n.place?.confidence ?? null,
        ],
        [
          'country',
          truth.country === undefined ? undefined : n.place?.value.country === truth.country,
          n.place?.confidence ?? null,
        ],
      ]
    : FIELDS.map((f) => [f, isScored(truth, f) ? false : undefined, null]);

  const fields = checks
    .filter((c): c is [FieldName, boolean, ConfidenceLevel | null] => c[1] !== undefined)
    .map(([field, correct, confidence]) => ({ field, correct, confidence }));
  const allCorrect = fields.every((f) => f.correct);
  const autoReady = n !== null && isAutoReady(n, capturedAt(truth, n));
  return { fields, allCorrect, autoReady, silentError: autoReady && !allCorrect };
}

function isScored(truth: GroundTruth, field: FieldName): boolean {
  return field === 'documentType' || field === 'currency' || truth[field] !== undefined;
}
