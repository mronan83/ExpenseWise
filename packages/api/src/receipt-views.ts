import type { ExtractionRunRecord, ReceiptRecord, ReceiptReviewRecord } from '@expensewise/db';
import { money, toDecimal, zero, type Money } from '@expensewise/domain';
import {
  assumedZeros,
  COMPARISON_MODELS,
  FALLBACK_MODEL,
  MODELS,
  normalizeExtraction,
  readingDifferences,
  ReceiptExtractionSchema,
  type CorrectableField,
  type Field,
  type ModelId,
  type NormalizedExtraction,
} from '@expensewise/extraction';

const moneyView = (field: Field<Money> | null) =>
  field
    ? {
        amountMinor: field.value.amountMinor,
        currency: field.value.currency,
        decimal: toDecimal(field.value),
        confidence: field.confidence,
        assumed: false,
      }
    : null;

/** Zero in the reading's currency, for a tax or tip the receipt doesn't print. */
const assumedZeroView = (currency: string) => {
  const nothing = zero(currency);
  return {
    amountMinor: nothing.amountMinor,
    currency,
    decimal: toDecimal(nothing),
    confidence: 'high' as const,
    assumed: true,
  };
};

const textView = (field: Field<string> | null) =>
  field ? { value: field.value, confidence: field.confidence } : null;

export function normalized(run: ExtractionRunRecord | undefined): NormalizedExtraction | null {
  if (!run || run.outcome === 'failed') return null;
  const parsed = ReceiptExtractionSchema.safeParse(run.output);
  return parsed.success ? normalizeExtraction(parsed.data) : null;
}

/** The readings from the receipt's most recent request, one per model at most. */
export function latestRuns(receiptId: string, runs: readonly ExtractionRunRecord[]) {
  const mine = runs
    .filter((r) => r.receiptId === receiptId)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const latest = mine[0]?.requestId;
  return mine.filter((r) => r.requestId === latest);
}

/**
 * compared: a model the tier decision weighs. fallback: it read the receipt only because no
 * compared model could (ADR-0020).
 */
export type ReadingRole = 'compared' | 'fallback';

const roleOf = (model: ModelId): ReadingRole =>
  model === FALLBACK_MODEL ? 'fallback' : 'compared';

export function readingView(
  model: ModelId,
  run: ExtractionRunRecord | undefined,
  pending: boolean,
) {
  const n = pending ? null : normalized(run);
  const assumed = n ? assumedZeros(n) : [];
  return {
    model,
    label: MODELS[model].label,
    role: roleOf(model),
    state: pending ? ('pending' as const) : run ? run.outcome : ('missing' as const),
    error: pending ? null : (run?.error ?? null),
    latencyMs: pending ? null : (run?.latencyMs ?? null),
    costMicroUsd: pending ? null : (run?.costMicroUsd ?? null),
    inputTokens: pending ? null : (run?.inputTokens ?? null),
    outputTokens: pending ? null : (run?.outputTokens ?? null),
    fields: n
      ? {
          documentType: n.documentType,
          merchant: textView(n.merchant),
          date: textView(n.date),
          currency: n.currency
            ? { value: n.currency.value, confidence: n.currency.confidence }
            : null,
          total: moneyView(n.total),
          subtotal: moneyView(n.subtotal),
          taxTotal: n.taxTotal
            ? moneyView(n.taxTotal)
            : assumed.includes('taxTotal') && n.total
              ? assumedZeroView(n.total.value.currency)
              : null,
          tip: n.tip
            ? moneyView(n.tip)
            : assumed.includes('tip') && n.total
              ? assumedZeroView(n.total.value.currency)
              : null,
          cardLastFour: textView(n.cardLastFour),
        }
      : null,
    problems: n ? [...n.problems] : [],
  };
}

export type ReadingView = ReturnType<typeof readingView>;

/**
 * The readings to show for a receipt: every compared model, pending while it is read, then
 * the fallback model's, only when it was asked to read.
 */
export function readingsOf(receipt: ReceiptRecord, runs: readonly ExtractionRunRecord[]) {
  const latest = latestRuns(receipt.id, runs);
  const pending = receipt.status === 'processing';
  const fallback = latest.find((r) => r.model === FALLBACK_MODEL);
  return [
    ...COMPARISON_MODELS.map((model) =>
      readingView(
        model,
        latest.find((r) => r.model === model),
        pending,
      ),
    ),
    ...(fallback ? [readingView(FALLBACK_MODEL, fallback, pending)] : []),
  ];
}

function differencesOf(receipt: ReceiptRecord, runs: readonly ExtractionRunRecord[]): string[] {
  if (receipt.status === 'processing') return [];
  const latest = latestRuns(receipt.id, runs);
  const [a, b] = COMPARISON_MODELS.map((m) => normalized(latest.find((r) => r.model === m)));
  return a && b ? readingDifferences(a, b) : [];
}

/**
 * The confirmation that decides what the receipt is filed with: the newest one of its latest
 * readings, while the receipt is Ready. Reading it again starts over (ADR-0021).
 */
export function currentReview(
  receipt: ReceiptRecord,
  runs: readonly ExtractionRunRecord[],
  reviews: readonly ReceiptReviewRecord[],
): ReceiptReviewRecord | null {
  if (receipt.status !== 'extracted') return null;
  const request = latestRuns(receipt.id, runs)[0]?.requestId ?? null;
  return reviews.find((r) => r.receiptId === receipt.id && r.requestId === request) ?? null;
}

function confirmationView(review: ReceiptReviewRecord) {
  const corrections = Array.isArray(review.corrections)
    ? (review.corrections as { field: CorrectableField; read: string | null; corrected: string }[])
    : [];
  const amount = (minor: number | null) =>
    minor === null ? null : moneyView({ value: money(minor, review.currency), confidence: 'high' });
  return {
    by: review.reviewedBy,
    at: review.createdAt.toISOString(),
    model: review.model,
    label: review.model in MODELS ? MODELS[review.model as ModelId].label : review.model,
    values: {
      merchant: review.merchant,
      date: review.transactionDate,
      currency: review.currency,
      total: amount(review.totalMinor),
      taxTotal: amount(review.taxMinor),
      tip: amount(review.tipMinor),
    },
    corrections: corrections.map(({ field, read, corrected }) => ({ field, read, corrected })),
  };
}

export function receiptSummary(
  receipt: ReceiptRecord,
  runs: readonly ExtractionRunRecord[],
  reviews: readonly ReceiptReviewRecord[] = [],
) {
  const review = currentReview(receipt, runs, reviews);
  // The headline is what a member confirmed; else the most capable compared model that read
  // it; else the fallback.
  const readings = readingsOf(receipt, runs);
  const compared = readings.filter((r) => r.role === 'compared').reverse();
  const best =
    compared.find((r) => r.fields)?.fields ??
    readings.find((r) => r.role === 'fallback')?.fields ??
    null;
  const confirmed = review
    ? {
        merchant: review.merchant,
        date: review.transactionDate,
        total: moneyView({
          value: money(review.totalMinor, review.currency),
          confidence: 'high',
        }),
      }
    : null;
  return {
    id: receipt.id,
    status: receipt.status,
    source: receipt.source,
    contentType: receipt.contentType,
    byteSize: receipt.byteSize,
    uploadedBy: receipt.uploadedBy,
    createdAt: receipt.createdAt.toISOString(),
    merchant: confirmed ? confirmed.merchant : (best?.merchant?.value ?? null),
    date: confirmed ? confirmed.date : (best?.date?.value ?? null),
    total: confirmed ? confirmed.total : (best?.total ?? null),
    expenseId: receipt.expenseId,
  };
}

export function receiptDetail(
  receipt: ReceiptRecord,
  runs: readonly ExtractionRunRecord[],
  imageUrl: string | null,
  reviews: readonly ReceiptReviewRecord[] = [],
) {
  const review = currentReview(receipt, runs, reviews);
  return {
    ...receiptSummary(receipt, runs, reviews),
    imageUrl,
    readings: readingsOf(receipt, runs),
    differences: differencesOf(receipt, runs),
    confirmation: review ? confirmationView(review) : null,
  };
}

/**
 * How the compared models did on these receipts' latest readings: what the product owner
 * needs to choose a tier (ADR-0006, ADR-0017). The fallback model gets its own row once it
 * has been asked to read, so its spend shows; it never counts as compared.
 */
export function comparisonSummary(
  receipts: readonly ReceiptRecord[],
  runs: readonly ExtractionRunRecord[],
) {
  const settled = receipts.filter((r) => r.status !== 'processing');
  const latest = new Map(settled.map((r) => [r.id, latestRuns(r.id, runs)]));
  const usedFallback = [...latest.values()].some((rs) =>
    rs.some((r) => r.model === FALLBACK_MODEL),
  );
  const shown: ModelId[] = usedFallback
    ? [...COMPARISON_MODELS, FALLBACK_MODEL]
    : [...COMPARISON_MODELS];
  const models = shown.map((model) => {
    const mine = [...latest.values()].flatMap((rs) => rs.filter((r) => r.model === model));
    const read = mine.filter((r) => r.outcome !== 'failed');
    const timed = read.filter((r) => r.latencyMs !== null);
    return {
      model,
      label: MODELS[model].label,
      role: roleOf(model),
      readings: mine.length,
      confident: mine.filter((r) => r.outcome === 'confident').length,
      failed: mine.length - read.length,
      // Whole milliseconds; an average of durations, not money.
      averageLatencyMs:
        timed.length === 0
          ? null
          : Math.round(timed.reduce((sum, r) => sum + (r.latencyMs ?? 0), 0) / timed.length),
      costMicroUsd: mine.reduce((sum, r) => sum + (r.costMicroUsd ?? 0), 0),
    };
  });
  let compared = 0;
  let agreed = 0;
  for (const [id, rs] of latest) {
    const receipt = settled.find((r) => r.id === id);
    if (!receipt) continue;
    const [a, b] = COMPARISON_MODELS.map((m) => normalized(rs.find((r) => r.model === m)));
    if (!a || !b) continue;
    compared += 1;
    if (readingDifferences(a, b).length === 0) agreed += 1;
  }
  return { receipts: settled.length, compared, agreed, models };
}
