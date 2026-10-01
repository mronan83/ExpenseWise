import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import Anthropic from '@anthropic-ai/sdk';
import {
  ClaudeExtractor,
  formatUsd,
  isModelId,
  MODEL_IDS,
  MODELS,
  PROMPT_VERSION,
  type ExtractionInput,
  type Extractor,
  type ModelId,
} from '@expensewise/extraction';
import { OracleExtractor } from './oracle.ts';
import { CACHE_DIR, MANIFEST, RESULTS_DIR } from './paths.ts';
import { renderReport, type Outcome, type ResultRow } from './report.ts';
import { scoreDocument } from './score.ts';
import { SOURCES, type GroundTruth, type Manifest, type Source } from './truth.ts';

const ALIASES: Record<string, ModelId> = {
  fable: 'claude-fable-5-1',
  opus: 'claude-opus-5-5',
  sonnet: 'claude-sonnet-5-5',
  haiku: 'claude-haiku-4-5',
};

const { values } = parseArgs({
  // `pnpm … spike -- --flag` passes the `--` through; drop it so both spellings work.
  args: process.argv.slice(2).filter((a) => a !== '--'),
  options: {
    models: { type: 'string', default: MODEL_IDS.join(',') },
    sources: { type: 'string', default: SOURCES.join(',') },
    limit: { type: 'string' },
    concurrency: { type: 'string', default: '4' },
    'dry-run': { type: 'boolean', default: false },
    yes: { type: 'boolean', default: false },
  },
});

const models = values.models.split(',').map((m) => {
  const id = ALIASES[m.trim()] ?? m.trim();
  if (!isModelId(id))
    throw new Error(`Unknown model "${m}". Use ${Object.keys(ALIASES).join(', ')}.`);
  return id;
});
const sources = values.sources.split(',').map((s) => s.trim()) as Source[];
const limit = values.limit ? Number(values.limit) : Infinity;
const dryRun = values['dry-run'];

const manifest = JSON.parse(await readFile(MANIFEST, 'utf8')) as Manifest;
const items = sources.flatMap((source) =>
  manifest.items.filter((i) => i.source === source).slice(0, limit),
);
if (items.length === 0)
  throw new Error('No eval documents. Run `pnpm --filter @expensewise/evals data` first.');

// A rough pre-run estimate: ~1,000 prompt and schema tokens, ~1,600 per image, ~2,500 per
// PDF page, ~700 output tokens, plus ~600 thinking tokens on models that think by default.
const estimateNano = (model: ModelId) =>
  items.reduce((sum, i) => {
    const input = 1_000n + (i.mediaType === 'application/pdf' ? 2_500n : 1_600n);
    const output = 700n + (MODELS[model].effort ? 600n : 0n);
    return sum + input * MODELS[model].price.input + output * MODELS[model].price.output;
  }, 0n);
const estimate = models.reduce((s, m) => s + estimateNano(m), 0n);
console.log(
  `${items.length} documents × ${models.length} models (${models.map((m) => MODELS[m].label).join(', ')}).`,
);
console.log(`Estimated API cost: about $${formatUsd(estimate, 2)}.`);
if (!dryRun && !values.yes) {
  console.log('Nothing was sent. Re-run with --yes to spend it, or --dry-run to test the harness.');
  process.exit(0);
}

const byFile = new Map(items.map((i) => [i.file, i]));
const inputs = await Promise.all(
  items.map(async (truth) => ({
    truth,
    input: {
      bytes: new Uint8Array(await readFile(`${CACHE_DIR}${truth.file}`)),
      mediaType: truth.mediaType,
      file: truth.file,
    },
  })),
);
const truthFor = (input: ExtractionInput & { file?: string }): GroundTruth => {
  const truth = input.file ? byFile.get(input.file) : undefined;
  if (!truth) throw new Error('Oracle could not find the document');
  return truth;
};
const client = dryRun ? null : new Anthropic({ maxRetries: 4 });
const extractorFor = (model: ModelId): Extractor =>
  client ? new ClaudeExtractor(client, model) : new OracleExtractor(model, truthFor);

const startedAt = new Date().toISOString();
const outDir = `${RESULTS_DIR}${startedAt.replace(/[:.]/g, '-')}${dryRun ? '-dry' : ''}/`;
await mkdir(outDir, { recursive: true });
const rows: ResultRow[] = [];
const raw: string[] = [];

for (const model of models) {
  const extractor = extractorFor(model);
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < inputs.length) {
      const { truth, input } = inputs[next++]!;
      let outcome: Outcome;
      let record: Record<string, unknown>;
      try {
        const run = await extractor.extract(input);
        outcome = run.outcome;
        const score = scoreDocument(truth, run);
        rows.push({
          itemId: truth.id,
          source: truth.source,
          model,
          outcome,
          latencyMs: run.latencyMs,
          costNanoUsd: run.costNanoUsd,
          score,
        });
        record = { ...run, costNanoUsd: run.costNanoUsd.toString(), score };
      } catch (error) {
        outcome = 'error';
        const status =
          error instanceof Anthropic.APIError ? (error.status as number | undefined) : undefined;
        const name = error instanceof Error ? error.name : 'Error';
        rows.push({
          itemId: truth.id,
          source: truth.source,
          model,
          outcome,
          latencyMs: 0,
          costNanoUsd: 0n,
          score: scoreDocument(truth, { outcome: 'invalid', extraction: null }),
        });
        record = { error: name, status };
      }
      raw.push(
        JSON.stringify({ itemId: truth.id, source: truth.source, model, outcome, ...record }),
      );
      done++;
      if (done % 20 === 0 || done === inputs.length) {
        console.log(`  ${MODELS[model].label}: ${done}/${inputs.length}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Number(values.concurrency) }, worker));
}

const report = renderReport(rows, models, sources, {
  promptVersion: PROMPT_VERSION,
  dryRun,
  startedAt,
});
await writeFile(`${outDir}results.jsonl`, raw.join('\n') + '\n');
await writeFile(`${outDir}report.md`, report);
console.log(`\n${report}\nResults: ${outDir}`);
