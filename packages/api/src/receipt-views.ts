import type { ExtractionRunRecord, ReceiptRecord } from '@expensewise/db';
import { toDecimal, type Money } from '@expensewise/domain';
import {
  COMPARISON_MODELS,
  FALLBACK_MODEL,
  MODELS,
  normalizeExtraction,
  readingDifferences,
  ReceiptExtractionSchema,
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
      }
    : null;

const textView = (field: Field<string> | null) =>
  field ? { value: field.value, confidence: field.confidence } : null;

function normalized(run: ExtractionRunRecord | undefined): NormalizedExtraction | null {
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
          taxTotal: moneyView(n.taxTotal),
          tip: moneyView(n.tip),
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

export function receiptSummary(receipt: ReceiptRecord, runs: readonly ExtractionRunRecord[]) {
  // The headline comes from the most capable compared model that read it, else the fallback.
  const readings = readingsOf(receipt, runs);
  const compared = readings.filter((r) => r.role === 'compared').reverse();
  const best =
    compared.find((r) => r.fields)?.fields ??
    readings.find((r) => r.role === 'fallback')?.fields ??
    null;
  return {
    id: receipt.id,
    status: receipt.status,
    source: receipt.source,
    contentType: receipt.contentType,
    byteSize: receipt.byteSize,
    uploadedBy: receipt.uploadedBy,
    createdAt: receipt.createdAt.toISOString(),
    merchant: best?.merchant?.value ?? null,
    date: best?.date?.value ?? null,
    total: best?.total ?? null,
  };
}

export function receiptDetail(
  receipt: ReceiptRecord,
  runs: readonly ExtractionRunRecord[],
  imageUrl: string | null,
) {
  return {
    ...receiptSummary(receipt, runs),
    imageUrl,
    readings: readingsOf(receipt, runs),
    differences: differencesOf(receipt, runs),
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
