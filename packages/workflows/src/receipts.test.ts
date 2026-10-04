import { createHash } from 'node:crypto';
import type { ExtractionRunRecord, NewExtractionRun } from '@expensewise/db';
import {
  ProviderHttpError,
  type ExtractionRun,
  type Extractor,
  type ModelId,
  type ReceiptExtraction,
} from '@expensewise/extraction';
import { InngestTestEngine, mockCtx } from '@inngest/test';
import { NO_DETAILS } from '@expensewise/domain';
import { describe, expect, it } from 'vitest';
import { createWorkflowClient } from './functions.ts';
import {
  permanentFailure,
  readWith,
  receiptReadingFunction,
  sniffMediaType,
  toStoredRun,
  type KeyProblem,
  type ReceiptReadingPorts,
} from './receipts.ts';

const client = createWorkflowClient({ isDev: true });
const ORG = '0192f7a0-0000-7000-8000-0000000000a1';
const RECEIPT = '0192f7a0-0000-7000-8000-0000000000d1';
const REQUEST = '0192f7a0-0000-7000-8000-0000000000e1';
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

const reading = (over: Partial<ReceiptExtraction> = {}): ReceiptExtraction => ({
  documentType: 'receipt',
  merchant: { name: 'Blue Bottle Coffee', confidence: 'high' },
  date: { value: '2026-09-24', confidence: 'high' },
  currency: { code: 'USD', confidence: 'high' },
  total: { value: '6.50', confidence: 'high' },
  subtotal: null,
  fees: [],
  taxes: [],
  tip: null,
  cardLastFour: null,
  time: null,
  address: null,
  lineItems: [],
  ...over,
});

/** What the default reading files an expense with. */
const COFFEE = {
  merchant: 'Blue Bottle Coffee',
  transactionDate: '2026-09-24',
  currency: 'USD',
  amountMinor: 650,
};

type Behaviour = ReceiptExtraction | Error | KeyProblem;

/** An organization with one uploaded receipt, and a scripted answer per model. */
function world(answers: Partial<Record<ModelId, Behaviour>>, file: Uint8Array | null = JPEG) {
  const runs: (NewExtractionRun & { orgId: string })[] = [];
  const settled: { status: string; detail: Record<string, unknown>; values: unknown }[] = [];
  const calls: string[] = [];
  const ports: ReceiptReadingPorts = {
    loadReceipt: () =>
      Promise.resolve({
        storageKey: `orgs/${ORG}/receipts/${RECEIPT}`,
        contentType: 'image/jpeg',
        byteSize: JPEG.byteLength,
        sha256: createHash('sha256').update(JPEG).digest('hex'),
        createdAt: new Date('2026-09-24T18:00:00Z'),
      }),
    fetchFile: () => Promise.resolve(file),
    extractor: (_org, model) => {
      const answer = answers[model];
      if (typeof answer === 'string') return Promise.resolve(answer);
      const extractor: Extractor = {
        model,
        extract: (): Promise<ExtractionRun> => {
          calls.push(model);
          if (answer instanceof Error) return Promise.reject(answer);
          return Promise.resolve({
            outcome: 'extracted',
            extraction: answer ?? reading(),
            model,
            promptVersion: 'extract-v1',
            latencyMs: model === 'claude-haiku-4-5' ? 1800 : 4200,
            usage: {
              inputTokens: 1500,
              outputTokens: 300,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
            },
            costNanoUsd: 4_500_400n,
          });
        },
      };
      return Promise.resolve(extractor);
    },
    saveRun: (orgId, run) => {
      if (!runs.some((r) => r.model === run.model && r.requestId === run.requestId)) {
        runs.push({ ...run, orgId });
      }
      return Promise.resolve();
    },
    runs: (_org, receiptId, requestId) =>
      Promise.resolve(
        runs
          .filter((r) => r.receiptId === receiptId && r.requestId === requestId)
          .map((r, i): ExtractionRunRecord => ({
            ...r,
            id: `run-${i}`,
            createdAt: new Date(),
          })),
      ),
    settle: (_org, _receipt, outcome) => {
      settled.push(outcome);
      return Promise.resolve();
    },
  };
  return { ports, runs, settled, calls };
}

const uploaded = {
  name: 'receipt.uploaded',
  data: { orgId: ORG, receiptId: RECEIPT, outboxId: REQUEST },
};

/**
 * Runs the function. `exhausted` names steps that have run out of retries: the runtime then
 * makes their `step.run` reject, which the test engine doesn't model, so it is injected.
 */
async function run(w: ReturnType<typeof world>, exhausted: string[] = []) {
  const t = new InngestTestEngine({
    function: receiptReadingFunction(client, () => w.ports),
    events: [uploaded],
    transformCtx: (raw) => {
      const ctx = mockCtx(raw);
      const original = ctx.step.run.bind(ctx.step);
      const run = ((id: string, ...rest: unknown[]) =>
        exhausted.includes(id)
          ? Promise.reject(new Error('Overloaded'))
          : (original as (...args: unknown[]) => unknown)(id, ...rest)) as typeof ctx.step.run;
      return { ...ctx, step: { ...ctx.step, run } };
    },
  });
  return t.execute();
}

/** The models called, once each: the test engine may run a parallel step twice. */
const called = (w: ReturnType<typeof world>) => [...new Set(w.calls)].sort();

const noCredit = () =>
  Object.assign(new Error('400'), {
    status: 400,
    error: { error: { message: 'Your credit balance is too low' } },
  });

describe('reading a receipt with both models', () => {
  it('files it as Ready when both read it with confidence and agree', async () => {
    const w = world({});
    const { result, error } = await run(w);
    expect(error).toBeUndefined();
    expect(result).toEqual({ status: 'extracted', differences: [] });
    expect(called(w)).toEqual(['claude-haiku-4-5', 'claude-sonnet-5-5']);
    expect(w.runs.map((r) => [r.model, r.outcome, r.requestId, r.costMicroUsd])).toEqual(
      expect.arrayContaining([
        ['claude-haiku-4-5', 'confident', REQUEST, 4500],
        ['claude-sonnet-5-5', 'confident', REQUEST, 4500],
      ]),
    );
    expect(w.settled[0]).toMatchObject({
      status: 'extracted',
      detail: { readings: { 'claude-haiku-4-5': 'confident', 'claude-sonnet-5-5': 'confident' } },
      // The expense is filed with what was read.
      values: COFFEE,
    });
  });

  it('asks for a look when the models disagree', async () => {
    const w = world({
      'claude-haiku-4-5': reading({ total: { value: '65.00', confidence: 'high' } }),
    });
    const { result } = await run(w);
    expect(result).toEqual({ status: 'needs_review', differences: ['total'] });
    // Its expense starts from the more capable model's reading.
    expect(w.settled[0]?.values).toEqual({ ...COFFEE, details: NO_DETAILS });
  });

  it('asks for a look when both agree on parts that don’t make the total', async () => {
    // 5.50 + 0.49 tax is 5.99; the tip that made 6.50 was missed by both.
    const short = reading({
      subtotal: { value: '5.50', confidence: 'high' },
      taxes: [{ label: 'Sales tax', value: '0.49', confidence: 'high' }],
    });
    const w = world({ 'claude-haiku-4-5': short, 'claude-sonnet-5-5': short });
    const { result } = await run(w);
    expect(result).toEqual({ status: 'needs_review', differences: [] });
    // Neither reading would be Ready on its own, which the comparison counts.
    expect(w.runs.map((r) => r.outcome)).toEqual(['unsure', 'unsure']);
  });

  it('asks for a look when both read a date after the upload', async () => {
    const later = reading({ date: { value: '2026-10-24', confidence: 'high' } });
    const w = world({ 'claude-haiku-4-5': later, 'claude-sonnet-5-5': later });
    const { result } = await run(w);
    expect(result).toEqual({ status: 'needs_review', differences: [] });
  });

  it('records a missing key as a failed reading, and calls no model', async () => {
    const w = world({
      'claude-haiku-4-5': 'no_key',
      'claude-sonnet-5-5': 'no_key',
      'gpt-5.6-luna': 'no_key',
    });
    const { result } = await run(w);
    expect(result).toEqual({ status: 'failed', differences: [] });
    expect(w.calls).toEqual([]);
    // The fallback is optional: without its key it is skipped, not stored as a failure.
    expect(w.runs.map((r) => [r.model, r.error])).toEqual([
      ['claude-haiku-4-5', 'no_key'],
      ['claude-sonnet-5-5', 'no_key'],
    ]);
  });

  it('keeps the other reading when the provider rejects one request for good', async () => {
    const w = world({ 'claude-sonnet-5-5': noCredit() });
    const { result } = await run(w);
    expect(result).toEqual({ status: 'needs_review', differences: [] });
    expect(w.runs.find((r) => r.model === 'claude-sonnet-5-5')?.error).toBe(
      'request_rejected: Your credit balance is too low',
    );
    expect(w.calls).not.toContain('gpt-5.6-luna');
  });

  it('reads nothing when the stored file is not the one described', async () => {
    const w = world({}, new Uint8Array([0xff, 0xd8, 0xff, 9, 9, 9, 9, 9]));
    const { result } = await run(w);
    expect(result).toEqual({ status: 'failed', differences: [] });
    expect(w.calls).toEqual([]);
    expect(w.settled[0]?.detail).toMatchObject({ problem: 'file_changed' });
  });
});

describe('the fallback reader', () => {
  it('reads the receipt when Anthropic has no credit, and asks for a look', async () => {
    const w = world({ 'claude-haiku-4-5': noCredit(), 'claude-sonnet-5-5': noCredit() });
    const { result, error } = await run(w);
    expect(error).toBeUndefined();
    // A confident fallback reading still needs a look: one unmeasured reading isn't Ready.
    expect(result).toEqual({ status: 'needs_review', differences: [] });
    expect(called(w)).toEqual(['claude-haiku-4-5', 'claude-sonnet-5-5', 'gpt-5.6-luna']);
    expect(w.runs.find((r) => r.model === 'gpt-5.6-luna')).toMatchObject({
      extractor: 'openai',
      outcome: 'confident',
      requestId: REQUEST,
    });
    expect(w.settled[0]?.values).toEqual({ ...COFFEE, details: NO_DETAILS });
    expect(w.settled[0]?.detail).toMatchObject({
      fallback: 'gpt-5.6-luna',
      readings: {
        'claude-haiku-4-5': 'failed',
        'claude-sonnet-5-5': 'failed',
        'gpt-5.6-luna': 'confident',
      },
    });
  });

  it('reads the receipt when there is no Anthropic key', async () => {
    const w = world({ 'claude-haiku-4-5': 'no_key', 'claude-sonnet-5-5': 'no_key' });
    const { result } = await run(w);
    expect(result).toEqual({ status: 'needs_review', differences: [] });
    expect(called(w)).toEqual(['gpt-5.6-luna']);
  });

  it('is not called when a Claude model read the receipt', async () => {
    const w = world({ 'claude-sonnet-5-5': 'no_key' });
    const { result } = await run(w);
    expect(result).toEqual({ status: 'needs_review', differences: [] });
    expect(called(w)).toEqual(['claude-haiku-4-5']);
    expect(w.settled[0]?.detail).not.toHaveProperty('fallback');
  });

  it('reads the receipt when the Claude steps run out of retries', async () => {
    const w = world({});
    const { result, error } = await run(w, ['read with Haiku 4.5', 'read with Sonnet 5.5']);
    expect(error).toBeUndefined();
    expect(result).toEqual({ status: 'needs_review', differences: [] });
    expect(w.runs.map((r) => [r.model, r.outcome, r.error])).toEqual(
      expect.arrayContaining([
        ['claude-haiku-4-5', 'failed', 'unavailable: Overloaded'],
        ['claude-sonnet-5-5', 'failed', 'unavailable: Overloaded'],
        ['gpt-5.6-luna', 'confident', null],
      ]),
    );
  });

  it('settles as failed when the fallback has no credit either', async () => {
    const w = world({
      'claude-haiku-4-5': noCredit(),
      'claude-sonnet-5-5': noCredit(),
      'gpt-5.6-luna': new ProviderHttpError(
        429,
        'You exceeded your current quota.',
        'insufficient_quota',
      ),
    });
    const { result } = await run(w);
    expect(result).toEqual({ status: 'failed', differences: [] });
    expect(w.settled[0]?.values).toBeNull();
    expect(w.runs.find((r) => r.model === 'gpt-5.6-luna')?.error).toBe(
      'request_rejected: You exceeded your current quota.',
    );
  });
});

/** The organization reads under its AI model settings, in this order (FR-INT-16). */
function withSettings(w: ReturnType<typeof world>, order: ModelId[]) {
  w.ports.readingPlan = () => Promise.resolve({ mode: 'primary', order });
  return w;
}

const roles = (w: ReturnType<typeof world>) =>
  w.runs.map((r) => [r.model, r.role ?? null, r.outcome, r.error]);

describe('reading under the organization’s AI model settings (ADR-0033)', () => {
  const SONNET_FIRST: ModelId[] = ['claude-sonnet-5-5', 'claude-haiku-4-5', 'gpt-5.6-luna'];

  it('files it as Ready on one confident reading by the primary, and asks no back-up', async () => {
    const w = withSettings(world({}), SONNET_FIRST);
    const { result, error } = await run(w);
    expect(error).toBeUndefined();
    expect(result).toEqual({ status: 'extracted', differences: [] });
    expect(called(w)).toEqual(['claude-sonnet-5-5']);
    expect(roles(w)).toEqual([['claude-sonnet-5-5', 'primary', 'confident', null]]);
    expect(w.settled[0]).toMatchObject({
      status: 'extracted',
      values: COFFEE,
      detail: { readBy: 'claude-sonnet-5-5', readings: { 'claude-sonnet-5-5': 'confident' } },
    });
  });

  it('asks for a look when the primary is unsure, and still asks no back-up', async () => {
    const unsure = reading({ total: { value: '6.50', confidence: 'medium' } });
    const w = withSettings(world({ 'claude-sonnet-5-5': unsure }), SONNET_FIRST);
    const { result } = await run(w);
    expect(result).toEqual({ status: 'needs_review', differences: [] });
    expect(called(w)).toEqual(['claude-sonnet-5-5']);
    // Its expense starts from that reading.
    expect(w.settled[0]?.values).toEqual({ ...COFFEE, details: NO_DETAILS });
  });

  it('asks for a look when the one reading’s parts don’t make its total', async () => {
    const short = reading({
      subtotal: { value: '5.50', confidence: 'high' },
      taxes: [{ label: 'Sales tax', value: '0.49', confidence: 'high' }],
    });
    const w = withSettings(world({ 'claude-sonnet-5-5': short }), SONNET_FIRST);
    expect((await run(w)).result).toEqual({ status: 'needs_review', differences: [] });
  });

  it('reads with the back-ups in the order set, only while the ones before could not', async () => {
    const w = withSettings(world({ 'claude-sonnet-5-5': noCredit(), 'gpt-5.6-luna': noCredit() }), [
      'claude-sonnet-5-5',
      'gpt-5.6-luna',
      'claude-haiku-4-5',
    ]);
    const { result } = await run(w);
    // A back-up's confident reading is Ready as well: every model that is on is trusted alike.
    expect(result).toEqual({ status: 'extracted', differences: [] });
    expect(roles(w)).toEqual([
      [
        'claude-sonnet-5-5',
        'primary',
        'failed',
        'request_rejected: Your credit balance is too low',
      ],
      ['gpt-5.6-luna', 'backup', 'failed', 'request_rejected: Your credit balance is too low'],
      ['claude-haiku-4-5', 'backup', 'confident', null],
    ]);
    expect(w.settled[0]?.detail).toMatchObject({ readBy: 'claude-haiku-4-5' });
  });

  it('reads with OpenAI’s model as primary, like any other', async () => {
    const w = withSettings(world({}), ['gpt-5.6-luna', 'claude-haiku-4-5']);
    const { result } = await run(w);
    expect(result).toEqual({ status: 'extracted', differences: [] });
    expect(called(w)).toEqual(['gpt-5.6-luna']);
    expect(w.runs[0]).toMatchObject({ extractor: 'openai', role: 'primary' });
  });

  it('reads each request with the settings as they are then, read again included', async () => {
    const w = withSettings(world({}), ['claude-sonnet-5-5']);
    await run(w);
    // The owner makes OpenAI's model primary; the receipt is read again.
    withSettings(w, ['gpt-5.6-luna']);
    await run(w);
    expect(called(w)).toEqual(['claude-sonnet-5-5', 'gpt-5.6-luna']);
  });

  it('passes over a model with no key, storing nothing for it', async () => {
    const w = withSettings(world({ 'claude-sonnet-5-5': 'no_key' }), SONNET_FIRST);
    const { result } = await run(w);
    expect(result).toEqual({ status: 'extracted', differences: [] });
    expect(roles(w)).toEqual([['claude-haiku-4-5', 'backup', 'confident', null]]);
  });

  it('notes a primary that runs out of retries as unavailable, then reads with a back-up', async () => {
    const w = withSettings(world({}), SONNET_FIRST);
    const { result } = await run(w, ['read with Sonnet 5.5']);
    expect(result).toEqual({ status: 'extracted', differences: [] });
    expect(roles(w)).toEqual([
      ['claude-sonnet-5-5', 'primary', 'failed', 'unavailable: Overloaded'],
      ['claude-haiku-4-5', 'backup', 'confident', null],
    ]);
  });

  it('settles as not read when every model that is on fails', async () => {
    const w = withSettings(
      world({ 'claude-sonnet-5-5': noCredit(), 'claude-haiku-4-5': noCredit() }),
      ['claude-sonnet-5-5', 'claude-haiku-4-5'],
    );
    const { result } = await run(w);
    expect(result).toEqual({ status: 'failed', differences: [] });
    expect(w.settled[0]?.values).toBeNull();
  });

  it('files it for a person to fill in when every model is off', async () => {
    const w = withSettings(world({}), []);
    const { result, error } = await run(w);
    expect(error).toBeUndefined();
    expect(result).toEqual({ status: 'needs_review', differences: [] });
    expect(w.calls).toEqual([]);
    expect(w.runs).toEqual([]);
    expect(w.settled[0]).toMatchObject({
      status: 'needs_review',
      values: null,
      detail: { problem: 'no_model_on', order: [] },
    });
  });

  it('settles a file that is not the one described as not read, whatever the settings', async () => {
    const w = withSettings(
      world({}, new Uint8Array([0xff, 0xd8, 0xff, 9, 9, 9, 9, 9])),
      SONNET_FIRST,
    );
    const { result } = await run(w);
    expect(result).toEqual({ status: 'failed', differences: [] });
    expect(w.calls).toEqual([]);
    expect(w.settled[0]?.detail).toMatchObject({ problem: 'file_changed' });
  });
});

describe('the operator’s switch for a model, side by side', () => {
  it('stores a stopped compared model as failed, asks it nothing, and never asks a stopped fallback', async () => {
    const w = world({ 'claude-sonnet-5-5': noCredit() });
    w.ports.readingPlan = () =>
      Promise.resolve({ mode: 'compare', stopped: ['claude-haiku-4-5', 'gpt-5.6-luna'] });
    const { result } = await run(w);
    expect(result).toEqual({ status: 'failed', differences: [] });
    expect(called(w)).toEqual(['claude-sonnet-5-5']);
    expect(w.runs.find((r) => r.model === 'claude-haiku-4-5')?.error).toBe('stopped');
  });
});

describe('permanentFailure', () => {
  it.each([
    [
      new ProviderHttpError(401, 'Incorrect API key provided.', 'invalid_api_key'),
      'key_rejected: Incorrect API key provided.',
    ],
    [
      new ProviderHttpError(429, 'Quota exceeded.', 'insufficient_quota'),
      'request_rejected: Quota exceeded.',
    ],
    [
      new ProviderHttpError(400, undefined, undefined),
      'request_rejected: The provider answered 400',
    ],
    [new ProviderHttpError(429, 'Rate limit reached.', 'rate_limit_exceeded'), undefined],
    [new ProviderHttpError(503, 'Unavailable', undefined), undefined],
    [new Error('socket hang up'), undefined],
  ])('reads %o as %s', (error, expected) => {
    expect(permanentFailure(error)).toBe(expected);
  });
});

describe('readWith', () => {
  it('throws errors a retry may fix, so the step is retried', async () => {
    const w = world({
      'claude-haiku-4-5': Object.assign(new Error('overloaded'), { status: 529 }),
    });
    const request = { orgId: ORG, receiptId: RECEIPT, requestId: REQUEST };
    await expect(readWith(w.ports, request, 'claude-haiku-4-5', 'image/jpeg')).rejects.toThrow(
      'overloaded',
    );
    expect(w.runs).toEqual([]);
  });
});

describe('toStoredRun', () => {
  const run = (over: Partial<ExtractionRun>): ExtractionRun => ({
    outcome: 'extracted',
    extraction: reading(),
    model: 'claude-haiku-4-5',
    promptVersion: 'extract-v3',
    latencyMs: 1800,
    usage: { inputTokens: 1500, outputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 0 },
    costNanoUsd: 4_500_400n,
    ...over,
  });
  const uploaded = new Date('2026-09-24T18:00:00Z');

  it('stores the line each field was read from with the reading, under the version asked', () => {
    const sources = { merchant: 'BLUE BOTTLE COFFEE', total: 'TOTAL 6.50' };
    const stored = toStoredRun(
      RECEIPT,
      REQUEST,
      run({
        extraction: { ...reading(), sources } as ReceiptExtraction,
        promptVersion: 'extract-v4',
        schemaVersion: 'receipt-v4',
      }),
      uploaded,
    );
    expect(stored).toMatchObject({
      promptVersion: 'extract-v4',
      schemaVersion: 'receipt-v4',
      outcome: 'confident',
      output: { sources },
    });
  });

  it('stores a reading asked for without them as receipt-v3, as before', () => {
    const stored = toStoredRun(RECEIPT, REQUEST, run({}), uploaded);
    expect(stored).toMatchObject({ promptVersion: 'extract-v3', schemaVersion: 'receipt-v3' });
    expect(stored.output).not.toHaveProperty('sources');
  });
});

describe('sniffMediaType', () => {
  it.each([
    ['image/jpeg', [0xff, 0xd8, 0xff, 0xdb]],
    ['image/png', [0x89, 0x50, 0x4e, 0x47, 0x0d]],
    ['application/pdf', [...'%PDF-1.7'].map((c) => c.charCodeAt(0))],
    ['image/webp', [...'RIFF\0\0\0\0WEBP'].map((c) => c.charCodeAt(0))],
  ])('recognizes %s', (type, bytes) => {
    expect(sniffMediaType(new Uint8Array(bytes))).toBe(type);
  });

  it('rejects anything else', () => {
    expect(sniffMediaType(new TextEncoder().encode('<html>'))).toBeUndefined();
  });
});

describe('journeys and stays (FR-INT-20, FR-INT-21)', () => {
  const flight = reading({
    documentType: 'airline_ticket',
    merchant: { name: 'United Airlines', confidence: 'high' },
    journey: {
      from: { value: 'SFO', confidence: 'high' },
      to: { value: 'ORD', confidence: 'high' },
    },
    stay: null,
  });

  it('files a journey with its expense from a reading asked for it, and none from one not asked', async () => {
    const asked = world({ 'claude-haiku-4-5': flight, 'claude-sonnet-5-5': flight });
    await run(asked);
    expect(asked.settled[0]).toMatchObject({
      status: 'extracted',
      values: {
        merchant: 'United Airlines',
        travel: { journeyFrom: 'SFO', journeyTo: 'ORD', checkIn: null, checkOut: null },
      },
    });
    const before = world({});
    await run(before);
    expect(before.settled[0]?.values).not.toHaveProperty('travel');
  });

  it('asks for a look when a folio’s nights aren’t sure, and still files its dates as read', async () => {
    const folio = reading({
      documentType: 'hotel_folio',
      merchant: { name: 'Hilton Omaha', confidence: 'high' },
      journey: null,
      stay: {
        checkIn: { value: '2026-10-01', confidence: 'high' },
        checkOut: { value: '2026-09-24', confidence: 'high' },
      },
    });
    const w = world({ 'claude-haiku-4-5': folio, 'claude-sonnet-5-5': folio });
    const { result } = await run(w);
    expect(result).toEqual({ status: 'needs_review', differences: [] });
    expect(w.runs.map((r) => r.outcome)).toEqual(['unsure', 'unsure']);
    expect(w.settled[0]).toMatchObject({
      values: { travel: { checkIn: '2026-10-01', checkOut: '2026-09-24' } },
    });
  });

  it('stores a reading asked for them under the version asked, with them', () => {
    const stored = toStoredRun(
      RECEIPT,
      REQUEST,
      {
        outcome: 'extracted',
        extraction: flight,
        model: 'claude-sonnet-5-5',
        promptVersion: 'extract-v4+journeys-v1',
        schemaVersion: 'receipt-v4+journeys-v1',
        latencyMs: 1800,
        usage: { inputTokens: 1500, outputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 0 },
        costNanoUsd: 4_500_400n,
      },
      new Date('2026-09-24T18:00:00Z'),
    );
    expect(stored).toMatchObject({
      promptVersion: 'extract-v4+journeys-v1',
      schemaVersion: 'receipt-v4+journeys-v1',
      outcome: 'confident',
      output: { journey: { from: { value: 'SFO' } } },
    });
  });
});

describe('the lines a reading files its expense with (ADR-0041)', () => {
  it('hands on the itemized lines of the reading the expense is filed with, and none when it prints none', async () => {
    const itemized = reading({
      subtotal: { value: '6.00', confidence: 'high' },
      taxes: [{ label: 'Sales tax', value: '0.50', confidence: 'high' }],
      lineItems: [
        { description: 'Latte', quantity: '1', amount: '4.50' },
        { description: 'Croissant', quantity: null, amount: '1.50' },
      ],
    });
    const w = world({ 'claude-haiku-4-5': itemized, 'claude-sonnet-5-5': itemized });
    await run(w);
    const { lines } = w.settled[0] as { lines?: { lines: { description: string }[] } | null };
    expect(lines?.lines.map((l) => l.description)).toEqual(['Latte', 'Croissant', 'Sales tax']);

    const plain = world({});
    await run(plain);
    expect((plain.settled[0] as { lines?: unknown }).lines).toBeNull();
  });
});
