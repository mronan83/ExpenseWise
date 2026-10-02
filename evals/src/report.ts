import { divRound, formatUnits } from '@expensewise/domain';
import { formatUsd, MODELS, type ModelId } from '@expensewise/extraction';
import { FIELDS, type DocumentScore, type FieldName } from './score.ts';
import type { Source } from './truth.ts';

export type Outcome = 'extracted' | 'refused' | 'truncated' | 'invalid' | 'error';

export interface ResultRow {
  readonly itemId: string;
  readonly source: Source;
  readonly model: ModelId;
  readonly outcome: Outcome;
  readonly latencyMs: number;
  readonly costNanoUsd: bigint;
  readonly score: DocumentScore;
}

export interface Summary {
  readonly model: ModelId;
  readonly source: Source | 'all';
  readonly documents: number;
  readonly failures: number;
  readonly fieldAccuracy: Partial<Record<FieldName, { correct: number; scored: number }>>;
  readonly fieldsCorrect: number;
  readonly fieldsScored: number;
  readonly allCorrect: number;
  readonly autoReady: number;
  readonly silentErrors: number;
  /** Wrong fields the model marked high confidence: errors the review gate cannot see. */
  readonly confidentlyWrong: number;
  readonly wrongFields: number;
  readonly latencyP50Ms: number;
  readonly latencyP95Ms: number;
  readonly costNanoUsd: bigint;
}

/** "97.5": a percentage to one decimal place, by integer arithmetic. */
export function percent(part: number, whole: number): string {
  if (whole === 0) return '–';
  return formatUnits(divRound(BigInt(part) * 1000n, BigInt(whole), 'half-up'), 1);
}

export function percentile(values: readonly number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)] ?? 0;
}

export function summarize(
  rows: readonly ResultRow[],
  model: ModelId,
  source: Source | 'all',
): Summary {
  const mine = rows.filter((r) => r.model === model && (source === 'all' || r.source === source));
  const fieldAccuracy: Summary['fieldAccuracy'] = {};
  let fieldsCorrect = 0;
  let fieldsScored = 0;
  let confidentlyWrong = 0;
  let wrongFields = 0;
  for (const row of mine) {
    for (const f of row.score.fields) {
      const entry = (fieldAccuracy[f.field] ??= { correct: 0, scored: 0 });
      entry.scored++;
      fieldsScored++;
      if (f.correct) {
        entry.correct++;
        fieldsCorrect++;
      } else {
        wrongFields++;
        if (f.confidence === 'high') confidentlyWrong++;
      }
    }
  }
  const latencies = mine.filter((r) => r.outcome !== 'error').map((r) => r.latencyMs);
  return {
    model,
    source,
    documents: mine.length,
    failures: mine.filter((r) => r.outcome !== 'extracted').length,
    fieldAccuracy,
    fieldsCorrect,
    fieldsScored,
    allCorrect: mine.filter((r) => r.score.allCorrect).length,
    autoReady: mine.filter((r) => r.score.autoReady).length,
    silentErrors: mine.filter((r) => r.score.silentError).length,
    confidentlyWrong,
    wrongFields,
    latencyP50Ms: percentile(latencies, 0.5),
    latencyP95Ms: percentile(latencies, 0.95),
    costNanoUsd: mine.reduce((s, r) => s + r.costNanoUsd, 0n),
  };
}

export interface CascadeSummary {
  readonly first: ModelId;
  readonly second: ModelId;
  readonly source: Source | 'all';
  readonly documents: number;
  /** Documents whose first read would not skip review, so the second model read them too. */
  readonly escalated: number;
  readonly fieldsCorrect: number;
  readonly fieldsScored: number;
  readonly allCorrect: number;
  readonly autoReady: number;
  readonly silentErrors: number;
  readonly costNanoUsd: bigint;
}

/**
 * Model-tier escalation (ADR-0006): every document goes to `first`; when its read would
 * not skip review, `second` reads it too and its answer is kept. Built from the same run's
 * results, so it costs nothing extra to evaluate.
 */
export function summarizeCascade(
  rows: readonly ResultRow[],
  first: ModelId,
  second: ModelId,
  source: Source | 'all',
): CascadeSummary {
  const byItem = new Map<string, { first?: ResultRow; second?: ResultRow }>();
  for (const row of rows) {
    if (source !== 'all' && row.source !== source) continue;
    const entry = byItem.get(row.itemId) ?? {};
    if (row.model === first) entry.first = row;
    if (row.model === second) entry.second = row;
    byItem.set(row.itemId, entry);
  }
  let documents = 0;
  let escalated = 0;
  let fieldsCorrect = 0;
  let fieldsScored = 0;
  let allCorrect = 0;
  let autoReady = 0;
  let silentErrors = 0;
  let costNanoUsd = 0n;
  for (const { first: a, second: b } of byItem.values()) {
    if (!a) continue;
    documents++;
    costNanoUsd += a.costNanoUsd;
    let kept = a;
    if (!a.score.autoReady && b) {
      escalated++;
      costNanoUsd += b.costNanoUsd;
      kept = b;
    }
    fieldsScored += kept.score.fields.length;
    fieldsCorrect += kept.score.fields.filter((f) => f.correct).length;
    if (kept.score.allCorrect) allCorrect++;
    if (kept.score.autoReady) autoReady++;
    if (kept.score.silentError) silentErrors++;
  }
  return {
    first,
    second,
    source,
    documents,
    escalated,
    fieldsCorrect,
    fieldsScored,
    allCorrect,
    autoReady,
    silentErrors,
    costNanoUsd,
  };
}

/** The two cheapest models in a run, cheapest first: the natural escalation pair. */
export function cascadePair(models: readonly ModelId[]): [ModelId, ModelId] | null {
  const byPrice = [...models].sort((a, b) =>
    MODELS[a].price.input < MODELS[b].price.input
      ? -1
      : MODELS[a].price.input > MODELS[b].price.input
        ? 1
        : 0,
  );
  const [cheapest, next] = byPrice;
  return cheapest && next ? [cheapest, next] : null;
}

const perDocument = (s: Summary) => (s.documents === 0 ? 0n : s.costNanoUsd / BigInt(s.documents));

/** The spike report: one table across models, then field accuracy by model and source. */
export function renderReport(
  rows: readonly ResultRow[],
  models: readonly ModelId[],
  sources: readonly Source[],
  meta: { promptVersion: string; dryRun: boolean; startedAt: string },
): string {
  const overall = models.map((m) => summarize(rows, m, 'all'));
  const lines: string[] = [
    `# Extraction spike ${meta.dryRun ? '(dry run: oracle answers, no API calls)' : ''}`.trim(),
    '',
    `Run ${meta.startedAt} · prompt ${meta.promptVersion} · ${rows.length / Math.max(models.length, 1)} documents per model`,
    '',
    '| Model | Fields correct | Documents fully correct | Would skip review | Wrong but skipped review | Confidently wrong fields | Failures | Latency p50 / p95 | Cost per document | Run cost |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...overall.map(
      (s) =>
        `| ${MODELS[s.model].label} | ${percent(s.fieldsCorrect, s.fieldsScored)}% | ${percent(s.allCorrect, s.documents)}% | ${percent(s.autoReady, s.documents)}% | ${s.silentErrors} | ${s.confidentlyWrong} of ${s.wrongFields} | ${s.failures} | ${(s.latencyP50Ms / 1000).toFixed(1)} s / ${(s.latencyP95Ms / 1000).toFixed(1)} s | $${formatUsd(perDocument(s), 4)} | $${formatUsd(s.costNanoUsd, 2)} |`,
    ),
    '',
    '"Would skip review" means merchant, date, currency and total came back with high confidence and every value parsed. "Wrong but skipped review" counts documents that would have been filed as Ready with a wrong scored field.',
    '',
  ];
  for (const source of sources) {
    lines.push(`## ${source}`, '', `| Model | ${FIELDS.join(' | ')} | Skip review |`);
    lines.push(`| --- | ${FIELDS.map(() => '---').join(' | ')} | --- |`);
    for (const model of models) {
      const s = summarize(rows, model, source);
      const cells = FIELDS.map((f) => {
        const a = s.fieldAccuracy[f];
        return a ? `${percent(a.correct, a.scored)}%` : '–';
      });
      lines.push(
        `| ${MODELS[model].label} | ${cells.join(' | ')} | ${percent(s.autoReady, s.documents)}% |`,
      );
    }
    lines.push('');
  }
  const pair = cascadePair(models);
  if (pair) {
    const [first, second] = pair;
    lines.push(
      `## Cascade: ${MODELS[first].label} first, ${MODELS[second].label} when unsure`,
      '',
      `Every document goes to ${MODELS[first].label}. When its read would not skip review, ${MODELS[second].label} reads it too and its answer is kept.`,
      '',
      '| Documents | Escalated | Fields correct | Documents fully correct | Would skip review | Wrong but skipped review | Cost per document |',
      '| --- | --- | --- | --- | --- | --- | --- |',
    );
    for (const source of ['all', ...sources] as const) {
      const c = summarizeCascade(rows, first, second, source);
      const perDoc = c.documents === 0 ? 0n : c.costNanoUsd / BigInt(c.documents);
      lines.push(
        `| ${source === 'all' ? 'All' : source} (${c.documents}) | ${percent(c.escalated, c.documents)}% | ${percent(c.fieldsCorrect, c.fieldsScored)}% | ${percent(c.allCorrect, c.documents)}% | ${percent(c.autoReady, c.documents)}% | ${c.silentErrors} | $${formatUsd(perDoc, 4)} |`,
      );
    }
    lines.push('');
  }
  return lines.join('\n');
}
