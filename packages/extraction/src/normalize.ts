import {
  assertCurrency,
  DomainError,
  fromDecimal,
  isIsoDate,
  sum,
  type CurrencyCode,
  type Money,
} from '@expensewise/domain';
import type { ConfidenceLevel, DocumentType, ReceiptExtraction } from './schema.ts';

export interface Field<T> {
  readonly value: T;
  readonly confidence: ConfidenceLevel;
}

/** An extraction in domain terms: money as integer minor units, dates as ISO dates. */
export interface NormalizedExtraction {
  readonly documentType: DocumentType;
  readonly merchant: Field<string> | null;
  readonly date: Field<string> | null;
  readonly currency: Field<CurrencyCode> | null;
  readonly total: Field<Money> | null;
  readonly subtotal: Field<Money> | null;
  readonly taxTotal: Field<Money> | null;
  readonly tip: Field<Money> | null;
  readonly cardLastFour: Field<string> | null;
  /** Fields that could not be read as valid values; each becomes a Needs review reason. */
  readonly problems: readonly string[];
}

const RANK: Record<ConfidenceLevel, number> = { high: 2, medium: 1, low: 0 };
const lowest = (levels: readonly ConfidenceLevel[]): ConfidenceLevel =>
  levels.reduce((a, b) => (RANK[b] < RANK[a] ? b : a), 'high' as ConfidenceLevel);

/**
 * Converts what the model returned into domain values without rounding anything away.
 * An amount with more decimals than its currency allows, an unknown currency or an
 * impossible date becomes a problem, never a silently "fixed" value.
 */
export function normalizeExtraction(
  extraction: ReceiptExtraction,
  options: { fallbackCurrency?: CurrencyCode } = {},
): NormalizedExtraction {
  const problems: string[] = [];

  let currency: Field<CurrencyCode> | null = null;
  if (extraction.currency) {
    try {
      currency = {
        value: assertCurrency(extraction.currency.code.trim().toUpperCase()),
        confidence: extraction.currency.confidence,
      };
    } catch {
      problems.push('currency');
    }
  }
  const code = currency?.value ?? options.fallbackCurrency;

  const amount = (
    name: string,
    field: { value: string; confidence: ConfidenceLevel } | null,
  ): Field<Money> | null => {
    if (!field) return null;
    if (!code) {
      problems.push(name);
      return null;
    }
    try {
      return { value: fromDecimal(field.value, code), confidence: field.confidence };
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      problems.push(name);
      return null;
    }
  };

  // Read in field order, so problems are reported in the order a reviewer sees the fields.
  const total = amount('total', extraction.total);
  const subtotal = amount('subtotal', extraction.subtotal);
  const tip = amount('tip', extraction.tip);
  const taxes = extraction.taxes.map((t, i) => amount(`taxes[${i}]`, t));
  const readable = taxes.filter((t): t is Field<Money> => t !== null);
  const taxTotal =
    code && taxes.length > 0 && readable.length === taxes.length
      ? {
          value: sum(
            code,
            readable.map((t) => t.value),
          ),
          confidence: lowest(readable.map((t) => t.confidence)),
        }
      : null;

  let date: Field<string> | null = null;
  if (extraction.date) {
    if (isIsoDate(extraction.date.value)) {
      date = { value: extraction.date.value, confidence: extraction.date.confidence };
    } else {
      problems.push('date');
    }
  }

  let cardLastFour: Field<string> | null = null;
  if (extraction.cardLastFour) {
    if (/^\d{4}$/.test(extraction.cardLastFour.value)) {
      cardLastFour = extraction.cardLastFour;
    } else {
      problems.push('cardLastFour');
    }
  }

  const merchantName = extraction.merchant?.name.trim();
  return {
    documentType: extraction.documentType,
    merchant:
      extraction.merchant && merchantName
        ? { value: merchantName, confidence: extraction.merchant.confidence }
        : null,
    date,
    currency,
    total,
    subtotal,
    taxTotal,
    tip,
    cardLastFour,
    problems,
  };
}
