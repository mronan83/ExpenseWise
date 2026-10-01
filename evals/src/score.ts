import { assertCurrency, fromDecimal } from '@expensewise/domain';
import {
  normalizeExtraction,
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
] as const;
export type FieldName = (typeof FIELDS)[number];

/** Fields that must be read with high confidence for an expense to skip review. */
const READY_FIELDS = ['merchant', 'date', 'currency', 'total'] as const;

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

/** Store and brand names match loosely: case, punctuation and "&" vs "and" don't count. */
export function sameMerchant(expected: string, actual: string): boolean {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/&/g, ' and ')
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\b(the|inc|llc|ltd)\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  const a = norm(expected);
  const b = norm(actual);
  if (!a || !b) return false;
  if (a === b || a.includes(b) || b.includes(a)) return true;
  return levenshtein(a, b) * 100 <= Math.max(a.length, b.length) * 15;
}

function levenshtein(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        (previous[j] ?? 0) + 1,
        (current[j - 1] ?? 0) + 1,
        (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}

type Run = Pick<ExtractionRun, 'outcome' | 'extraction'>;

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
      ]
    : FIELDS.map((f) => [f, isScored(truth, f) ? false : undefined, null]);

  const fields = checks
    .filter((c): c is [FieldName, boolean, ConfidenceLevel | null] => c[1] !== undefined)
    .map(([field, correct, confidence]) => ({ field, correct, confidence }));
  const allCorrect = fields.every((f) => f.correct);
  const autoReady =
    n !== null && n.problems.length === 0 && READY_FIELDS.every((f) => n[f]?.confidence === 'high');
  return { fields, allCorrect, autoReady, silentError: autoReady && !allCorrect };
}

function isScored(truth: GroundTruth, field: FieldName): boolean {
  return field === 'documentType' || field === 'currency' || truth[field] !== undefined;
}
