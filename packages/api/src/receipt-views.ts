import type {
  DuplicatePairRecord,
  DuplicateSide,
  ExtractionRunRecord,
  ReceiptRecord,
  ReceiptReviewRecord,
} from '@expensewise/db';
import { isCurrencyCode, money, toDecimal, zero, type Money } from '@expensewise/domain';
import {
  assumedZeros,
  COMPARISON_MODELS,
  FALLBACK_MODEL,
  MODELS,
  normalizeExtraction,
  READING_CHECKS,
  readingChecks,
  readingDifferences,
  StoredReadingSchema,
  type CorrectableField,
  type Field,
  type ModelId,
  type NormalizedExtraction,
  type ReadingCheck,
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

/** An expense's amount, for display; null until both its amount and currency are known. */
export const amountView = (amountMinor: number | null, currency: string | null) =>
  amountMinor === null || currency === null || !isCurrencyCode(currency)
    ? null
    : { amountMinor, currency, decimal: toDecimal(money(amountMinor, currency)) };

const textView = (field: Field<string> | null) =>
  field ? { value: field.value, confidence: field.confidence } : null;

export function normalized(run: ExtractionRunRecord | undefined): NormalizedExtraction | null {
  if (!run || run.outcome === 'failed') return null;
  const parsed = StoredReadingSchema.safeParse(run.output);
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

/** One model's reading of a receipt uploaded at `uploadedAt`, as the receipt shows it. */
export function readingView(
  model: ModelId,
  run: ExtractionRunRecord | undefined,
  pending: boolean,
  uploadedAt: Date,
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
          fees: moneyView(n.feeTotal),
          cardLastFour: textView(n.cardLastFour),
        }
      : null,
    problems: n ? [...n.problems] : [],
    checks: n ? readingChecks(n, uploadedAt) : [],
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
        receipt.createdAt,
      ),
    ),
    ...(fallback ? [readingView(FALLBACK_MODEL, fallback, pending, receipt.createdAt)] : []),
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

/** One receipt of a possible duplicate pair, with the expense it proves (FR-INT-18). */
function duplicateSideView(side: DuplicateSide) {
  return {
    receiptId: side.receiptId,
    source: side.source,
    contentType: side.contentType,
    createdAt: side.createdAt.toISOString(),
    expenseId: side.expenseId,
    expenseStatus: side.expenseStatus,
    merchant: side.merchant,
    date: side.transactionDate,
    amount: amountView(side.amountMinor, side.currency),
    notes: side.notes,
    trip: side.tripId && side.tripName ? { id: side.tripId, name: side.tripName } : null,
  };
}

/**
 * The receipts this one may duplicate, side by side with it, for the person to keep both,
 * delete one, or merge one into the other (FR-INT-18). held: this receipt is the later copy,
 * which waits for the decision.
 */
export function duplicatesOf(receiptId: string, pairs: readonly DuplicatePairRecord[]) {
  return pairs
    .filter((p) => p.receiptId === receiptId)
    .map((p) => ({
      held: p.heldReceiptId === receiptId,
      self: duplicateSideView(p.self),
      other: duplicateSideView(p.other),
    }));
}

/**
 * Why a receipt needs the person, for the Needs you inbox (FR-EXP-02). failed: no model
 * could read it, with the first compared reading's error. duplicate: it looks like the same
 * purchase as an earlier receipt, which it names (FR-INT-18). fallback: only the fallback
 * read it. differ: the compared models read the filing fields differently. checks: they
 * agree, and the sums or date fail a check (FR-INT-04). unsure: a model wasn't confident, or
 * one couldn't read it. Null when it doesn't need the person.
 */
export function needsYouReason(
  receipt: ReceiptRecord,
  runs: readonly ExtractionRunRecord[],
  pairs: readonly DuplicatePairRecord[] = [],
) {
  if (receipt.status !== 'needs_review' && receipt.status !== 'failed') return null;
  const readings = readingsOf(receipt, runs);
  const compared = readings.filter((r) => r.role === 'compared');
  const fallback = readings.find((r) => r.role === 'fallback' && r.fields);
  const none = {
    fields: [] as string[],
    checks: [] as ReadingCheck[],
    error: null,
    by: null,
    duplicateOf: null,
  };
  const held = pairs.find((p) => p.receiptId === receipt.id && p.heldReceiptId === receipt.id);
  if (held && receipt.status === 'needs_review') {
    const { other } = held;
    return {
      ...none,
      code: 'duplicate' as const,
      duplicateOf: {
        receiptId: other.receiptId,
        merchant: other.merchant,
        date: other.transactionDate,
        amount: amountView(other.amountMinor, other.currency),
        createdAt: other.createdAt.toISOString(),
      },
    };
  }
  if (receipt.status === 'failed') {
    return {
      ...none,
      code: 'failed' as const,
      error: compared.find((r) => r.error)?.error ?? null,
    };
  }
  if (fallback) return { ...none, code: 'fallback' as const, by: fallback.label };
  const differences = differencesOf(receipt, runs);
  if (differences.length > 0) return { ...none, code: 'differ' as const, fields: differences };
  const checks = READING_CHECKS.filter((c) => compared.some((r) => r.checks.includes(c)));
  if (checks.length > 0) return { ...none, code: 'checks' as const, checks };
  return { ...none, code: 'unsure' as const };
}

/** One thing in the Needs you inbox: a receipt, and why it needs the person. */
export function inboxItem(
  receipt: ReceiptRecord,
  runs: readonly ExtractionRunRecord[],
  reviews: readonly ReceiptReviewRecord[],
  pairs: readonly DuplicatePairRecord[] = [],
) {
  const reason = needsYouReason(receipt, runs, pairs);
  return reason
    ? { kind: 'receipt' as const, receipt: receiptSummary(receipt, runs, reviews), reason }
    : null;
}

export function receiptDetail(
  receipt: ReceiptRecord,
  runs: readonly ExtractionRunRecord[],
  imageUrl: string | null,
  reviews: readonly ReceiptReviewRecord[] = [],
  pairs: readonly DuplicatePairRecord[] = [],
) {
  const review = currentReview(receipt, runs, reviews);
  return {
    ...receiptSummary(receipt, runs, reviews),
    imageUrl,
    readings: readingsOf(receipt, runs),
    differences: differencesOf(receipt, runs),
    confirmation: review ? confirmationView(review) : null,
    duplicates: duplicatesOf(receipt.id, pairs),
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
