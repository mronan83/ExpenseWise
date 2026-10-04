import type { ExpenseDetails, ExpenseValues } from '@expensewise/domain';
import { createHash } from 'node:crypto';
import {
  RECEIPT_READ_REQUESTED,
  RECEIPT_UPLOADED,
  type ExtractionRunRecord,
  type ModelRole,
  type NewExtractionRun,
  type ReceiptStatus,
} from '@expensewise/db';
import {
  COMPARISON_MODELS,
  type DocumentMediaType,
  type ExtractionRun,
  type Extractor,
  FALLBACK_MODEL,
  isAutoReady,
  type ModelId,
  MODELS,
  type NormalizedExtraction,
  normalizeExtraction,
  PROMPT_VERSION,
  ProviderHttpError,
  readingDifferences,
  StoredReadingSchema,
  SCHEMA_VERSION,
  valuesOfReading,
} from '@expensewise/extraction';
import { detailsOf } from '@expensewise/extraction/place';
import { NonRetriableError, type Inngest } from 'inngest';
import { SIDE_BY_SIDE, type ReadingPlan } from './reading-plan.ts';

/** What the workflow knows about the file it is asked to read. */
export interface ReceiptFile {
  readonly storageKey: string;
  readonly contentType: string;
  readonly byteSize: number;
  readonly sha256: string;
  /** When it was uploaded: a receipt can't be dated much after that (FR-INT-04). */
  readonly createdAt: Date;
}

/** Why a reading could not start: the organization has no usable key for the provider. */
export type KeyProblem = 'no_key' | 'unreadable_key';

/** What reading a receipt needs from the database, storage and the provider. */
export interface ReceiptReadingPorts {
  /** Which models read this organization's receipts now. Without it, side by side. */
  readingPlan?(orgId: string): Promise<ReadingPlan>;
  loadReceipt(orgId: string, receiptId: string): Promise<ReceiptFile | undefined>;
  fetchFile(storageKey: string): Promise<Uint8Array | null>;
  extractor(orgId: string, model: ModelId): Promise<Extractor | KeyProblem>;
  saveRun(orgId: string, run: NewExtractionRun): Promise<void>;
  runs(orgId: string, receiptId: string, requestId: string): Promise<ExtractionRunRecord[]>;
  settle(
    orgId: string,
    receiptId: string,
    outcome: {
      status: ReceiptStatus;
      requestId: string;
      detail: Record<string, unknown>;
      /** What the reading would file the receipt's expense with, its time and place too. */
      values: (ExpenseValues & { details?: ExpenseDetails }) | null;
    },
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

/**
 * A reading in the shape it is stored, from what the extractor returned. Confident means it
 * would be Ready on its own, its sums and date included, for a receipt uploaded then.
 */
export function toStoredRun(
  receiptId: string,
  requestId: string,
  run: ExtractionRun,
  uploadedAt: Date,
): NewExtractionRun {
  const normalized =
    run.outcome === 'extracted' && run.extraction ? normalizeExtraction(run.extraction) : null;
  return {
    receiptId,
    requestId,
    extractor: extractorOf(run.model),
    model: run.model,
    promptVersion: run.promptVersion,
    schemaVersion: run.schemaVersion ?? SCHEMA_VERSION,
    outcome: normalized ? (isAutoReady(normalized, uploadedAt) ? 'confident' : 'unsure') : 'failed',
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

export interface ReadOptions {
  /** Skipped, with nothing stored, when the organization has no key for the model. */
  readonly optional?: boolean;
  /** Why it reads, under the organization's AI model settings; kept with the reading. */
  readonly role?: ModelRole;
}

/**
 * Reads the receipt with one model and stores the result. Problems retrying can't fix are
 * stored as a failed reading; anything else is thrown so the step is retried. An optional
 * reader (the fallback, or any model under the organization's settings) is skipped, and
 * nothing stored, when the organization has no key for it.
 */
export async function readWith(
  ports: ReceiptReadingPorts,
  request: ReadingRequest,
  model: ModelId,
  mediaType: DocumentMediaType,
  options: ReadOptions = {},
): Promise<NewExtractionRun['outcome'] | 'skipped'> {
  const { orgId, receiptId, requestId } = request;
  const save = async (run: NewExtractionRun) => {
    await ports.saveRun(orgId, options.role ? { ...run, role: options.role } : run);
    return run.outcome;
  };
  const extractor = await ports.extractor(orgId, model);
  if (extractor === 'no_key' && options.optional) return 'skipped';
  if (typeof extractor === 'string') return save(failedRun(receiptId, requestId, model, extractor));
  const receipt = await ports.loadReceipt(orgId, receiptId);
  const bytes = receipt && (await ports.fetchFile(receipt.storageKey));
  if (!receipt || !bytes) return save(failedRun(receiptId, requestId, model, 'not_uploaded'));
  try {
    const run = await extractor.extract({ bytes, mediaType });
    return await save(toStoredRun(receiptId, requestId, run, receipt.createdAt));
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
  role?: ModelRole,
): Promise<'failed'> {
  const { orgId, receiptId, requestId } = request;
  const error = `unavailable: ${reason}`.slice(0, 300);
  const run = failedRun(receiptId, requestId, model, error);
  await ports.saveRun(orgId, role ? { ...run, role } : run);
  return 'failed';
}

/**
 * Stores a failed reading for a compared model the operator has stopped for every
 * organization (FR-INT-16), so the receipt says why it read nothing.
 */
export async function noteStopped(
  ports: ReceiptReadingPorts,
  request: ReadingRequest,
  model: ModelId,
): Promise<'failed'> {
  const { orgId, receiptId, requestId } = request;
  await ports.saveRun(orgId, failedRun(receiptId, requestId, model, 'stopped'));
  return 'failed';
}

/** Which models read this organization's receipts now: its settings, or side by side. */
export async function readingPlan(ports: ReceiptReadingPorts, orgId: string): Promise<ReadingPlan> {
  return ports.readingPlan ? ports.readingPlan(orgId) : SIDE_BY_SIDE;
}

function readingOf(run: ExtractionRunRecord | undefined): NormalizedExtraction | null {
  if (!run || run.outcome === 'failed') return null;
  const parsed = StoredReadingSchema.safeParse(run.output);
  return parsed.success ? normalizeExtraction(parsed.data) : null;
}

/**
 * Decides the receipt's status from the readings stored for this request. Until the tier
 * decision a receipt is Ready only when both models read it with confidence, agree on
 * merchant, date, currency and total, and their sums and date pass the checks (FR-INT-04);
 * anything less needs a look. A model with no stored
 * reading counts as failed. When no Claude model read it, the fallback reading counts: it
 * can make a receipt Needs a look, never Ready, because one reading by a model nobody has
 * measured on these receipts is not the evidence Ready stands for (ADR-0020).
 */
export async function settleReading(
  ports: ReceiptReadingPorts,
  request: ReadingRequest,
  problem?: string,
  plan?: ReadingPlan,
): Promise<{ status: ReceiptStatus; differences: string[] }> {
  if (plan?.mode === 'primary') return settleOneReading(ports, request, plan.order, problem);
  const { orgId, receiptId, requestId } = request;
  const runs = await ports.runs(orgId, receiptId, requestId);
  const uploadedAt = (await ports.loadReceipt(orgId, receiptId))?.createdAt ?? new Date();
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
      : first &&
          second &&
          differences.length === 0 &&
          isAutoReady(first, uploadedAt) &&
          isAutoReady(second, uploadedAt)
        ? 'extracted'
        : 'needs_review';
  // The expense is filed with the most capable reading there is, else the fallback's (ADR-0022).
  const best =
    [...readings].reverse().find(Boolean) ?? (usedFallback ? readingOf(fallbackRun) : null);
  await ports.settle(orgId, receiptId, {
    status,
    requestId,
    values: best ? { ...valuesOfReading(best), details: detailsOf(best) } : null,
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

/**
 * Decides the receipt's status under the organization's AI model settings (ADR-0033): the
 * first model in the order that produced a reading decides, alone. Ready when that reading
 * has merchant, date, currency and total with high confidence and its sums and date pass
 * (FR-INT-04); Needs a look when it doesn't, and its expense starts from it. Not read when
 * every model tried failed. With no model on to try, the receipt is filed for a person to
 * fill in: Needs a look, with nothing read (Q8).
 */
async function settleOneReading(
  ports: ReceiptReadingPorts,
  request: ReadingRequest,
  order: readonly ModelId[],
  problem?: string,
): Promise<{ status: ReceiptStatus; differences: string[] }> {
  const { orgId, receiptId, requestId } = request;
  const runs = await ports.runs(orgId, receiptId, requestId);
  const uploadedAt = (await ports.loadReceipt(orgId, receiptId))?.createdAt ?? new Date();
  const place = (model: string) => {
    const i = order.indexOf(model as ModelId);
    return i < 0 ? order.length : i;
  };
  const tried = [...runs].sort((a, b) => place(a.model) - place(b.model));
  const reader = tried.find((run) => readingOf(run) !== null);
  const reading = readingOf(reader);
  const notRead = runs.length === 0 && !problem;
  const status: ReceiptStatus = reading
    ? isAutoReady(reading, uploadedAt)
      ? 'extracted'
      : 'needs_review'
    : notRead
      ? 'needs_review'
      : 'failed';
  await ports.settle(orgId, receiptId, {
    status,
    requestId,
    values: reading ? { ...valuesOfReading(reading), details: detailsOf(reading) } : null,
    detail: {
      differences: [],
      readings: Object.fromEntries(tried.map((run) => [run.model, run.outcome])),
      order,
      ...(reader && reading ? { readBy: reader.model } : {}),
      ...(notRead ? { problem: 'no_model_on' } : problem ? { problem } : {}),
    },
  });
  return { status, differences: [] };
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
 * Reads a receipt after it is uploaded or when someone asks again: choose the models, check
 * the file, read it, then settle its status. Side by side, each compared model reads in
 * parallel steps, and if neither Claude model could read it (no credit, a rejected key, an
 * outage), the fallback model reads it, when the organization has a key for it (ADR-0020).
 * Under the organization's AI model settings, the primary reads it, and each back-up that is
 * on only when the models before it produced no reading, in the order set (ADR-0033); a
 * model with no key is passed over. A model the operator stopped reads nothing either way.
 * Steps retry on their own; a model whose step runs out of retries is stored as unavailable.
 * If the run itself fails, the receipt is settled from whatever readings were stored, so it
 * never stays "processing".
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
        await step.run('settle after failure', async () =>
          settleReading(
            ports(),
            request,
            'reading_failed',
            await readingPlan(ports(), request.orgId),
          ),
        );
      },
    },
    async ({ event, step }) => {
      const request = readingRequest(event.data);
      const plan = await step.run('choose the models', () => readingPlan(ports(), request.orgId));
      const file = await step.run('check the file', () =>
        checkFile(ports(), request.orgId, request.receiptId),
      );
      if (!file.ok) {
        return step.run('settle', () => settleReading(ports(), request, file.problem, plan));
      }
      const read = (outcome: string) => outcome === 'confident' || outcome === 'unsure';
      const readWithStep = (model: ModelId, options: ReadOptions = {}) => {
        const { label } = MODELS[model];
        return step
          .run(`read with ${label}`, () =>
            readWith(ports(), request, model, file.mediaType, options),
          )
          .catch((error: unknown) =>
            step.run(`note ${label} unavailable`, () =>
              noteUnavailable(ports(), request, model, stepFailure(error), options.role),
            ),
          );
      };
      if (plan.mode === 'primary') {
        // One model at a time: a back-up reads only when the ones before it couldn't.
        for (const [i, model] of plan.order.entries()) {
          const role = i === 0 ? 'primary' : 'backup';
          if (read(await readWithStep(model, { optional: true, role }))) break;
        }
        return step.run('settle', () => settleReading(ports(), request, undefined, plan));
      }
      const stopped = (model: ModelId) => plan.stopped.includes(model);
      const outcomes = await Promise.all(
        COMPARISON_MODELS.map((model) =>
          stopped(model)
            ? step.run(`note ${MODELS[model].label} stopped`, () =>
                noteStopped(ports(), request, model),
              )
            : readWithStep(model),
        ),
      );
      if (!outcomes.some(read) && !stopped(FALLBACK_MODEL)) {
        await readWithStep(FALLBACK_MODEL, { optional: true });
      }
      return step.run('settle', () => settleReading(ports(), request));
    },
  );
}
