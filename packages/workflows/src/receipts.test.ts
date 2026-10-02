import { createHash } from 'node:crypto';
import type { ExtractionRunRecord, NewExtractionRun } from '@expensewise/db';
import type { ExtractionRun, Extractor, ModelId, ReceiptExtraction } from '@expensewise/extraction';
import { InngestTestEngine } from '@inngest/test';
import { describe, expect, it } from 'vitest';
import { createWorkflowClient } from './functions.ts';
import {
  readWith,
  receiptReadingFunction,
  sniffMediaType,
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
  taxes: [],
  tip: null,
  cardLastFour: null,
  lineItems: [],
  ...over,
});

type Behaviour = ReceiptExtraction | Error | KeyProblem;

/** An organization with one uploaded receipt, and a scripted answer per model. */
function world(answers: Partial<Record<ModelId, Behaviour>>, file: Uint8Array | null = JPEG) {
  const runs: (NewExtractionRun & { orgId: string })[] = [];
  const settled: { status: string; detail: Record<string, unknown> }[] = [];
  const calls: string[] = [];
  const ports: ReceiptReadingPorts = {
    loadReceipt: () =>
      Promise.resolve({
        storageKey: `orgs/${ORG}/receipts/${RECEIPT}`,
        contentType: 'image/jpeg',
        byteSize: JPEG.byteLength,
        sha256: createHash('sha256').update(JPEG).digest('hex'),
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

async function run(w: ReturnType<typeof world>) {
  const t = new InngestTestEngine({
    function: receiptReadingFunction(client, () => w.ports),
    events: [uploaded],
  });
  return t.execute();
}

describe('reading a receipt with both models', () => {
  it('files it as Ready when both read it with confidence and agree', async () => {
    const w = world({});
    const { result, error } = await run(w);
    expect(error).toBeUndefined();
    expect(result).toEqual({ status: 'extracted', differences: [] });
    expect(w.calls.sort()).toEqual(['claude-haiku-4-5', 'claude-sonnet-5-5']);
    expect(w.runs.map((r) => [r.model, r.outcome, r.requestId, r.costMicroUsd])).toEqual(
      expect.arrayContaining([
        ['claude-haiku-4-5', 'confident', REQUEST, 4500],
        ['claude-sonnet-5-5', 'confident', REQUEST, 4500],
      ]),
    );
    expect(w.settled[0]).toMatchObject({
      status: 'extracted',
      detail: { readings: { 'claude-haiku-4-5': 'confident', 'claude-sonnet-5-5': 'confident' } },
    });
  });

  it('asks for a look when the models disagree', async () => {
    const w = world({
      'claude-haiku-4-5': reading({ total: { value: '65.00', confidence: 'high' } }),
    });
    const { result } = await run(w);
    expect(result).toEqual({ status: 'needs_review', differences: ['total'] });
  });

  it('records a missing key as a failed reading, and calls no model', async () => {
    const w = world({ 'claude-haiku-4-5': 'no_key', 'claude-sonnet-5-5': 'no_key' });
    const { result } = await run(w);
    expect(result).toEqual({ status: 'failed', differences: [] });
    expect(w.calls).toEqual([]);
    expect(w.runs.map((r) => r.error)).toEqual(['no_key', 'no_key']);
  });

  it('keeps the other reading when the provider rejects one request for good', async () => {
    const rejected = Object.assign(new Error('400'), {
      status: 400,
      error: { error: { message: 'Your credit balance is too low' } },
    });
    const w = world({ 'claude-sonnet-5-5': rejected });
    const { result } = await run(w);
    expect(result).toEqual({ status: 'needs_review', differences: [] });
    expect(w.runs.find((r) => r.model === 'claude-sonnet-5-5')?.error).toBe(
      'request_rejected: Your credit balance is too low',
    );
  });

  it('reads nothing when the stored file is not the one described', async () => {
    const w = world({}, new Uint8Array([0xff, 0xd8, 0xff, 9, 9, 9, 9, 9]));
    const { result } = await run(w);
    expect(result).toEqual({ status: 'failed', differences: [] });
    expect(w.calls).toEqual([]);
    expect(w.settled[0]?.detail).toMatchObject({ problem: 'file_changed' });
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
