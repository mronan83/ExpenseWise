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
  return lines.join('\n');
}
