import { createHash } from 'node:crypto';
import {
  RECEIPT_READ_REQUESTED,
  RECEIPT_UPLOADED,
  type ExtractionRunRecord,
  type NewExtractionRun,
  type ReceiptStatus,
} from '@expensewise/db';
import {
  COMPARISON_MODELS,
  FALLBACK_MODEL,
  isAutoReady,
  MODELS,
  normalizeExtraction,
  PROMPT_VERSION,
  ProviderHttpError,
  readingDifferences,
  ReceiptExtractionSchema,
  SCHEMA_VERSION,
  type DocumentMediaType,
  type ExtractionRun,
  type Extractor,
  type ModelId,
  type NormalizedExtraction,
} from '@expensewise/extraction';
import { NonRetriableError, type Inngest } from 'inngest';

/** What the workflow knows about the file it is asked to read. */
export interface ReceiptFile {
  readonly storageKey: string;
  readonly contentType: string;
  readonly byteSize: number;
  readonly sha256: string;
}

/** Why a reading could not start: the organization has no usable key for the provider. */
export type KeyProblem = 'no_key' | 'unreadable_key';

/** What reading a receipt needs from the database, storage and the provider. */
export interface ReceiptReadingPorts {
  loadReceipt(orgId: string, receiptId: string): Promise<ReceiptFile | undefined>;
  fetchFile(storageKey: string): Promise<Uint8Array | null>;
  extractor(orgId: string, model: ModelId): Promise<Extractor | KeyProblem>;
  saveRun(orgId: string, run: NewExtractionRun): Promise<void>;
  runs(orgId: string, receiptId: string, requestId: string): Promise<ExtractionRunRecord[]>;
  settle(
    orgId: string,
    receiptId: string,
    outcome: { status: ReceiptStatus; requestId: string; detail: Record<string, unknown> },
  ): Promise<void>;
}

const SIGNATURES: [DocumentMediaType, (b: Uint8Array) => boolean][] = [
  ['image/jpeg', (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ['image/png', (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47],
  ['image/gif', (b) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38],
  [
    'image/webp',
    (b) =>
      String.fromCharCode(...b.subarray(0, 4)) === 'RIFF' &&
      String.fromCharCode(...b.subarray(8, 12)) === 'WEBP',
  ],
  ['application/pdf', (b) => String.fromCharCode(...b.subarray(0, 5)) === '%PDF-'],
];

/** The file's real type from its first bytes, whatever it was labelled. */
export function sniffMediaType(bytes: Uint8Array): DocumentMediaType | undefined {
  return SIGNATURES.find(([, matches]) => matches(bytes))?.[0];
}

export type FileProblem = 'missing_receipt' | 'not_uploaded' | 'file_changed' | 'unsupported_type';

/** Checks the uploaded file is the one the client described before anything reads it. */
export async function checkFile(
  ports: ReceiptReadingPorts,
  orgId: string,
  receiptId: string,
): Promise<{ ok: true; mediaType: DocumentMediaType } | { ok: false; problem: FileProblem }> {
  const receipt = await ports.loadReceipt(orgId, receiptId);
  if (!receipt) return { ok: false, problem: 'missing_receipt' };
  const bytes = await ports.fetchFile(receipt.storageKey);
  if (!bytes) return { ok: false, problem: 'not_uploaded' };
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (bytes.byteLength !== receipt.byteSize || sha256 !== receipt.sha256) {
    return { ok: false, problem: 'file_changed' };
  }
  const mediaType = sniffMediaType(bytes);
  if (!mediaType || mediaType !== receipt.contentType) {
    return { ok: false, problem: 'unsupported_type' };
  }
  return { ok: true, mediaType };
}

/**
 * A provider error that retrying won't fix: a rejected key, no credit, a refused file.
 * OpenAI reports an empty balance as 429 `insufficient_quota`, which waiting won't fix
 * either; any other 429 is a rate limit and is retried.
 */
export function permanentFailure(error: unknown): string | undefined {
  const status = (error as { status?: unknown }).status;
  if (typeof status !== 'number') return undefined;
  const noCredit = error instanceof ProviderHttpError && error.code === 'insufficient_quota';
  if (!noCredit && (status === 408 || status === 409 || status === 429 || status >= 500)) {
    return undefined;
  }
  const nested =
    error instanceof ProviderHttpError
      ? error.providerMessage
      : (error as { error?: { error?: { message?: unknown } } }).error?.error?.message;
  const message = typeof nested === 'string' ? nested : `The provider answered ${status}`;
  const code = status === 401 || status === 403 ? 'key_rejected' : 'request_rejected';
  return `${code}: ${message}`.slice(0, 300);
}

/** The extractor column: which provider's reader produced the reading. */
const extractorOf = (model: ModelId) => (MODELS[model].provider === 'openai' ? 'openai' : 'claude');

/** A reading in the shape it is stored, from what the extractor returned. */
export function toStoredRun(
  receiptId: string,
  requestId: string,
  run: ExtractionRun,
): NewExtractionRun {
  const normalized =
    run.outcome === 'extracted' && run.extraction ? normalizeExtraction(run.extraction) : null;
  return {
    receiptId,
    requestId,
    extractor: extractorOf(run.model),
    model: run.model,
    promptVersion: run.promptVersion,
    schemaVersion: SCHEMA_VERSION,
    outcome: normalized ? (isAutoReady(normalized) ? 'confident' : 'unsure') : 'failed',
    output: run.extraction,
    fieldConfidence: normalized
      ? {
          merchant: normalized.merchant?.confidence ?? null,
          date: normalized.date?.confidence ?? null,
          currency: normalized.currency?.confidence ?? null,
          total: normalized.total?.confidence ?? null,
        }
      : null,
    error: normalized ? null : `model_${run.outcome}`,
    latencyMs: run.latencyMs,
    inputTokens: run.usage.inputTokens,
    outputTokens: run.usage.outputTokens,
    // Cost is kept in whole micro-dollars; half a micro-dollar rounds up.
    costMicroUsd: Number((run.costNanoUsd + 500n) / 1000n),
  };
}

const failedRun = (
  receiptId: string,
  requestId: string,
  model: ModelId,
  error: string,
): NewExtractionRun => ({
  receiptId,
  requestId,
  extractor: extractorOf(model),
  model,
  promptVersion: PROMPT_VERSION,
  schemaVersion: SCHEMA_VERSION,
  outcome: 'failed',
  output: null,
  fieldConfidence: null,
  error,
  latencyMs: null,
  inputTokens: null,
  outputTokens: null,
  costMicroUsd: null,
});

export interface ReadingRequest {
  readonly orgId: string;
  readonly receiptId: string;
  /** The outbox event that asked for the reading. */
  readonly requestId: string;
}

/**
 * Reads the receipt with one model and stores the result. Problems retrying can't fix are
 * stored as a failed reading; anything else is thrown so the step is retried. An optional
 * reader (the fallback) is skipped, and nothing stored, when the organization has no key for
 * it.
 */
export async function readWith(
  ports: ReceiptReadingPorts,
  request: ReadingRequest,
  model: ModelId,
  mediaType: DocumentMediaType,
  options: { optional?: boolean } = {},
): Promise<NewExtractionRun['outcome'] | 'skipped'> {
  const { orgId, receiptId, requestId } = request;
  const save = async (run: NewExtractionRun) => {
    await ports.saveRun(orgId, run);
    return run.outcome;
  };
  const extractor = await ports.extractor(orgId, model);
  if (extractor === 'no_key' && options.optional) return 'skipped';
  if (typeof extractor === 'string') return save(failedRun(receiptId, requestId, model, extractor));
  const receipt = await ports.loadReceipt(orgId, receiptId);
  const bytes = receipt && (await ports.fetchFile(receipt.storageKey));
  if (!bytes) return save(failedRun(receiptId, requestId, model, 'not_uploaded'));
  try {
    return await save(
      toStoredRun(receiptId, requestId, await extractor.extract({ bytes, mediaType })),
    );
  } catch (error) {
    const permanent = permanentFailure(error);
    if (!permanent) throw error;
    return save(failedRun(receiptId, requestId, model, permanent));
  }
}

/**
 * Stores a failed reading for a model whose step ran out of retries, such as a provider
 * outage, so the receipt shows why and the fallback can read it.
 */
export async function noteUnavailable(
  ports: ReceiptReadingPorts,
  request: ReadingRequest,
  model: ModelId,
  reason: string,
): Promise<'failed'> {
  const { orgId, receiptId, requestId } = request;
  const error = `unavailable: ${reason}`.slice(0, 300);
  await ports.saveRun(orgId, failedRun(receiptId, requestId, model, error));
  return 'failed';
}

function readingOf(run: ExtractionRunRecord | undefined): NormalizedExtraction | null {
  if (!run || run.outcome === 'failed') return null;
  const parsed = ReceiptExtractionSchema.safeParse(run.output);
  return parsed.success ? normalizeExtraction(parsed.data) : null;
}

/**
 * Decides the receipt's status from the readings stored for this request. Until the tier
 * decision a receipt is Ready only when both models read it with confidence and agree on
 * merchant, date, currency and total; anything less needs a look. A model with no stored
 * reading counts as failed. When no Claude model read it, the fallback reading counts: it
 * can make a receipt Needs a look, never Ready, because one reading by a model nobody has
 * measured on these receipts is not the evidence Ready stands for (ADR-0020).
 */
export async function settleReading(
  ports: ReceiptReadingPorts,
  request: ReadingRequest,
  problem?: string,
): Promise<{ status: ReceiptStatus; differences: string[] }> {
  const { orgId, receiptId, requestId } = request;
  const runs = await ports.runs(orgId, receiptId, requestId);
  const byModel = COMPARISON_MODELS.map((model) => runs.find((r) => r.model === model));
  const readings = byModel.map(readingOf);
  const fallbackRun = runs.find((r) => r.model === FALLBACK_MODEL);
  const usedFallback = !readings.some(Boolean) && readingOf(fallbackRun) !== null;
  const [first, second] = readings;
  const differences = first && second ? readingDifferences(first, second) : [];
  const status: ReceiptStatus = usedFallback
    ? 'needs_review'
    : !readings.some(Boolean)
      ? 'failed'
      : first && second && differences.length === 0 && isAutoReady(first) && isAutoReady(second)
        ? 'extracted'
        : 'needs_review';
  await ports.settle(orgId, receiptId, {
    status,
    requestId,
    detail: {
      differences,
      readings: Object.fromEntries([
        ...COMPARISON_MODELS.map((model, i) => [model, byModel[i]?.outcome ?? 'missing']),
        ...(fallbackRun ? [[FALLBACK_MODEL, fallbackRun.outcome]] : []),
      ]),
      ...(usedFallback ? { fallback: FALLBACK_MODEL } : {}),
      ...(problem ? { problem } : {}),
    },
  });
  return { status, differences };
}

function readingRequest(data: unknown): ReadingRequest {
  const { orgId, receiptId, outboxId } = (data ?? {}) as Record<string, unknown>;
  if (typeof orgId !== 'string' || typeof receiptId !== 'string' || typeof outboxId !== 'string') {
    throw new NonRetriableError('The event is missing orgId, receiptId or outboxId');
  }
  return { orgId, receiptId, requestId: outboxId };
}

const stepFailure = (error: unknown) =>
  error instanceof Error ? error.message : 'the step failed after its retries';

/**
 * Reads a receipt after it is uploaded or when someone asks again: check the file, read it
 * with each compared model in parallel steps, then settle its status. If neither Claude model
 * could read it (no credit, a rejected key, an outage), the fallback model reads it, when the
 * organization has a key for it (ADR-0020). Steps retry on their own; a model whose step runs
 * out of retries is stored as unavailable. If the run itself fails, the receipt is settled
 * from whatever readings were stored, so it never stays "processing".
 */
export function receiptReadingFunction(client: Inngest, ports: () => ReceiptReadingPorts) {
  return client.createFunction(
    {
      id: 'receipt-reading',
      name: 'Read a receipt',
      triggers: [{ event: RECEIPT_UPLOADED }, { event: RECEIPT_READ_REQUESTED }],
      retries: 3,
      onFailure: async ({ event, step }) => {
        const request = readingRequest(event.data.event.data);
        await step.run('settle after failure', () =>
          settleReading(ports(), request, 'reading_failed'),
        );
      },
    },
    async ({ event, step }) => {
      const request = readingRequest(event.data);
      const file = await step.run('check the file', () =>
        checkFile(ports(), request.orgId, request.receiptId),
      );
      if (!file.ok) {
        return step.run('settle', () => settleReading(ports(), request, file.problem));
      }
      const readWithStep = (model: ModelId, optional = false) => {
        const { label } = MODELS[model];
        return step
          .run(`read with ${label}`, () =>
            readWith(ports(), request, model, file.mediaType, { optional }),
          )
          .catch((error: unknown) =>
            step.run(`note ${label} unavailable`, () =>
              noteUnavailable(ports(), request, model, stepFailure(error)),
            ),
          );
      };
      const outcomes = await Promise.all(COMPARISON_MODELS.map((model) => readWithStep(model)));
      if (!outcomes.some((outcome) => outcome === 'confident' || outcome === 'unsure')) {
        await readWithStep(FALLBACK_MODEL, true);
      }
      return step.run('settle', () => settleReading(ports(), request));
    },
  );
}
