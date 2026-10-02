import type {
  CommittedEvent,
  ExtractionRunRecord,
  Membership,
  NewReceipt,
  ReceiptRecord,
} from '@expensewise/db';
import type { ReceiptExtraction } from '@expensewise/extraction';
import { memoryObjectStore } from '@expensewise/storage';
import { describe, expect, it } from 'vitest';
import { createApi } from '../src/app.ts';
import type { Identity } from '../src/auth.ts';
import type { ReceiptStore } from '../src/receipts.ts';
import type { WorkspaceStore } from '../src/workspace.ts';

const ORG = '0192f7a0-0000-7000-8000-0000000000a1';
const MEMBER = '0192f7a0-0000-7000-8000-0000000000b1';
const NOW = new Date('2026-10-02T12:00:00.000Z');
const SHA = 'a'.repeat(64);

const identity = (userId: string): Identity => ({
  userId,
  email: `${userId}@example.com`,
  assuranceLevel: 'aal1',
  sessionId: 's',
  issuedAt: NOW,
});

const reading = (total: string): ReceiptExtraction => ({
  documentType: 'receipt',
  merchant: { name: 'Blue Bottle Coffee', confidence: 'high' },
  date: { value: '2026-09-24', confidence: 'high' },
  currency: { code: 'USD', confidence: 'high' },
  total: { value: total, confidence: 'high' },
  subtotal: null,
  taxes: [],
  tip: null,
  cardLastFour: null,
  lineItems: [],
});

function fakeReceipts() {
  const receipts: ReceiptRecord[] = [];
  const runs: ExtractionRunRecord[] = [];
  const events: CommittedEvent[] = [];
  let n = 0;
  const store: ReceiptStore = {
    findBySha256: (_org, sha) => Promise.resolve(receipts.find((r) => r.sha256 === sha)?.id),
    file: (orgId, input: NewReceipt) => {
      const existing = receipts.find((r) => r.id === input.id);
      if (existing) return Promise.resolve({ status: 'exists', receipt: existing });
      const same = receipts.find((r) => r.sha256 === input.sha256);
      if (same) return Promise.resolve({ status: 'duplicate', receiptId: same.id });
      const receipt: ReceiptRecord = {
        ...input,
        uploadedBy: 'riley',
        status: 'processing',
        createdAt: NOW,
      };
      receipts.unshift(receipt);
      const event = {
        outboxId: `0192f7a0-0000-7000-8000-00000000f00${++n}`,
        topic: 'receipt.uploaded',
        orgId,
        payload: { receiptId: input.id },
      };
      events.push(event);
      return Promise.resolve({ status: 'filed', receipt, event });
    },
    list: () => Promise.resolve({ receipts, runs }),
    get: (_org, id) => {
      const receipt = receipts.find((r) => r.id === id);
      return Promise.resolve(receipt ? { receipt, runs } : undefined);
    },
    requestReading: (orgId, id) => {
      const i = receipts.findIndex((r) => r.id === id);
      if (i === -1) return Promise.resolve(undefined);
      receipts[i] = { ...receipts[i]!, status: 'processing' };
      const event = {
        outboxId: `0192f7a0-0000-7000-8000-00000000f00${++n}`,
        topic: 'receipt.read_requested',
        orgId,
        payload: { receiptId: id },
      };
      events.push(event);
      return Promise.resolve(event);
    },
  };
  /** Stands in for the workflow: both models read the receipt, then it is settled. */
  const read = (id: string, totals: [string, string], status: ReceiptRecord['status']) => {
    const requestId = events.at(-1)!.outboxId;
    (['claude-haiku-4-5', 'claude-sonnet-5-5'] as const).forEach((model, i) =>
      runs.push({
        id: `run-${runs.length}`,
        receiptId: id,
        requestId,
        model,
        promptVersion: 'extract-v1',
        outcome: 'confident',
        output: reading(totals[i]!),
        error: null,
        latencyMs: i === 0 ? 1800 : 4200,
        inputTokens: 1500,
        outputTokens: 300,
        costMicroUsd: i === 0 ? 3000 : 6000,
        createdAt: new Date(NOW.getTime() + runs.length),
      }),
    );
    const at = receipts.findIndex((r) => r.id === id);
    receipts[at] = { ...receipts[at]!, status };
  };
  /** Stands in for the workflow when Anthropic has no credit: the fallback reads it. */
  const readByFallback = (id: string) => {
    const requestId = events.at(-1)!.outboxId;
    const base = {
      receiptId: id,
      requestId,
      promptVersion: 'extract-v1',
      inputTokens: null,
      outputTokens: null,
      latencyMs: null,
      costMicroUsd: null,
    };
    for (const model of ['claude-haiku-4-5', 'claude-sonnet-5-5'] as const) {
      runs.push({
        ...base,
        id: `run-${runs.length}`,
        model,
        outcome: 'failed',
        output: null,
        error: 'request_rejected: Your credit balance is too low',
        createdAt: new Date(NOW.getTime() + runs.length),
      });
    }
    runs.push({
      ...base,
      id: `run-${runs.length}`,
      model: 'gpt-5.6-luna',
      outcome: 'confident',
      output: reading('7.25'),
      error: null,
      latencyMs: 2500,
      inputTokens: 2000,
      outputTokens: 400,
      costMicroUsd: 880,
      createdAt: new Date(NOW.getTime() + runs.length),
    });
    const at = receipts.findIndex((r) => r.id === id);
    receipts[at] = { ...receipts[at]!, status: 'needs_review' };
  };
  return { store, receipts, runs, events, read, readByFallback };
}

function setup(opts: { files?: boolean; dispatch?: 'ok' | 'fails' | 'none' } = {}) {
  const memberships: Record<string, Membership> = {
    riley: { orgId: ORG, memberId: MEMBER, role: 'owner' },
  };
  const workspace = {
    findMembership: (userId: string) => Promise.resolve(memberships[userId]),
  } as unknown as WorkspaceStore;
  const fake = fakeReceipts();
  const files = memoryObjectStore();
  const dispatched: CommittedEvent[] = [];
  const api = createApi({
    version: 't',
    verifyToken: (token) => Promise.resolve(identity(token)),
    workspace,
    receipts: fake.store,
    files: opts.files === false ? undefined : files,
    dispatch:
      opts.dispatch === 'none'
        ? undefined
        : (events) => {
            if (opts.dispatch === 'fails') return Promise.reject(new Error('runner down'));
            dispatched.push(...events);
            return Promise.resolve();
          },
  });
  const call = async (method: string, path: string, who?: string, body?: unknown) => {
    const res = await api.request(path, {
      method,
      headers: {
        ...(who ? { authorization: `Bearer ${who}` } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return {
      status: res.status,
      body: (await res.json().catch(() => null)) as Record<string, unknown>,
    };
  };
  const file = { contentType: 'image/jpeg', byteSize: 400_000, sha256: SHA };
  return { ...fake, files, dispatched, call, file };
}

describe('capturing a receipt', () => {
  it('hands out a one-time upload for a path inside the organization', async () => {
    const { call, file } = setup();
    const res = await call('POST', '/v1/receipts/uploads', 'riley', file);
    expect(res.status).toBe(201);
    const receiptId = res.body.receiptId as string;
    expect(res.body).toEqual({
      receiptId,
      bucket: 'receipts',
      path: `orgs/${ORG}/receipts/${receiptId}`,
      token: 'upload-token-1',
    });
  });

  it('files the receipt, hands its event to the runner, and is safe to retry', async () => {
    const { call, file, dispatched, receipts } = setup();
    const { body: ticket } = await call('POST', '/v1/receipts/uploads', 'riley', file);
    const filing = { id: ticket.receiptId, source: 'camera', ...file };
    const res = await call('POST', '/v1/receipts', 'riley', filing);
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ id: ticket.receiptId, status: 'processing', merchant: null });
    expect(dispatched.map((e) => e.topic)).toEqual(['receipt.uploaded']);
    // The storage path is the server's, whatever the client sends.
    expect(receipts[0]!.storageKey).toBe(`orgs/${ORG}/receipts/${String(ticket.receiptId)}`);

    expect((await call('POST', '/v1/receipts', 'riley', filing)).status).toBe(200);
    expect(dispatched).toHaveLength(1);
  });

  it('refuses a file that is already filed, before and after upload', async () => {
    const { call, file } = setup();
    const { body: ticket } = await call('POST', '/v1/receipts/uploads', 'riley', file);
    await call('POST', '/v1/receipts', 'riley', {
      id: ticket.receiptId,
      source: 'upload',
      ...file,
    });

    const before = await call('POST', '/v1/receipts/uploads', 'riley', file);
    expect(before.status).toBe(409);
    expect(before.body).toMatchObject({ code: 'duplicate_receipt', receiptId: ticket.receiptId });
    const after = await call('POST', '/v1/receipts', 'riley', {
      id: '0192f7a0-0000-7000-8000-0000000000c9',
      source: 'upload',
      ...file,
    });
    expect(after.status).toBe(409);
  });

  it('still files the receipt when the runner is unreachable; the relay sends it later', async () => {
    const { call, file } = setup({ dispatch: 'fails' });
    const { body: ticket } = await call('POST', '/v1/receipts/uploads', 'riley', file);
    const res = await call('POST', '/v1/receipts', 'riley', {
      id: ticket.receiptId,
      source: 'camera',
      ...file,
    });
    expect(res.status).toBe(202);
  });

  it('rejects files over 10 MB and types it cannot read', async () => {
    const { call, file } = setup();
    expect(
      (await call('POST', '/v1/receipts/uploads', 'riley', { ...file, byteSize: 11_000_000 }))
        .status,
    ).toBe(400);
    expect(
      (await call('POST', '/v1/receipts/uploads', 'riley', { ...file, contentType: 'text/html' }))
        .status,
    ).toBe(400);
  });

  it('needs storage, a signed-in user and an organization', async () => {
    const { call, file } = setup({ files: false });
    const res = await call('POST', '/v1/receipts/uploads', 'riley', file);
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ code: 'storage_not_configured' });
    expect((await call('GET', '/v1/receipts')).status).toBe(401);
    expect((await call('GET', '/v1/receipts', 'stranger')).status).toBe(403);
  });
});

describe('reading receipts side by side', () => {
  async function filed(s: ReturnType<typeof setup>) {
    const { body: ticket } = await s.call('POST', '/v1/receipts/uploads', 'riley', s.file);
    await s.call('POST', '/v1/receipts', 'riley', {
      id: ticket.receiptId,
      source: 'camera',
      ...s.file,
    });
    return ticket.receiptId as string;
  }

  it('shows each model pending while the receipt is read', async () => {
    const s = setup();
    const id = await filed(s);
    const res = await s.call('GET', `/v1/receipts/${id}`, 'riley');
    expect(res.status).toBe(200);
    expect(res.body.imageUrl).toBe(`memory://orgs/${ORG}/receipts/${id}?expires=300`);
    expect(
      (res.body.readings as { label: string; state: string }[]).map((r) => [r.label, r.state]),
    ).toEqual([
      ['Haiku 4.5', 'pending'],
      ['Sonnet 5.5', 'pending'],
    ]);
  });

  it('shows both readings, where they differ, and money as minor units', async () => {
    const s = setup();
    const id = await filed(s);
    s.read(id, ['65.00', '6.50'], 'needs_review');
    const { body } = await s.call('GET', `/v1/receipts/${id}`, 'riley');
    expect(body).toMatchObject({
      status: 'needs_review',
      merchant: 'Blue Bottle Coffee',
      total: { amountMinor: 650, currency: 'USD', decimal: '6.50' },
      differences: ['total'],
    });
    const [haiku, sonnet] = body.readings as {
      state: string;
      costMicroUsd: number;
      fields: { total: { decimal: string } };
    }[];
    expect([haiku!.fields.total.decimal, sonnet!.fields.total.decimal]).toEqual(['65.00', '6.50']);
    expect([haiku!.costMicroUsd, sonnet!.costMicroUsd]).toEqual([3000, 6000]);
  });

  it("shows tax and tip the receipt doesn't print as zero, marked as assumed", async () => {
    const s = setup();
    const id = await filed(s);
    s.read(id, ['6.50', '6.50'], 'extracted');
    const { body } = await s.call('GET', `/v1/receipts/${id}`, 'riley');
    const [haiku] = body.readings as {
      fields: Record<string, { decimal: string; assumed: boolean } | null>;
    }[];
    expect(haiku!.fields.total).toMatchObject({ decimal: '6.50', assumed: false });
    expect(haiku!.fields.taxTotal).toMatchObject({
      decimal: '0.00',
      currency: 'USD',
      assumed: true,
    });
    expect(haiku!.fields.tip).toMatchObject({ decimal: '0.00', assumed: true });
    expect(haiku!.fields.subtotal).toBeNull();
  });

  it('keeps a running comparison of the two models', async () => {
    const s = setup();
    const id = await filed(s);
    s.read(id, ['6.50', '6.50'], 'extracted');
    const { body } = await s.call('GET', '/v1/receipts', 'riley');
    expect(body.readingAvailable).toBe(true);
    expect(body.comparison).toEqual({
      receipts: 1,
      compared: 1,
      agreed: 1,
      models: [
        {
          model: 'claude-haiku-4-5',
          label: 'Haiku 4.5',
          role: 'compared',
          readings: 1,
          confident: 1,
          failed: 0,
          averageLatencyMs: 1800,
          costMicroUsd: 3000,
        },
        {
          model: 'claude-sonnet-5-5',
          label: 'Sonnet 5.5',
          role: 'compared',
          readings: 1,
          confident: 1,
          failed: 0,
          averageLatencyMs: 4200,
          costMicroUsd: 6000,
        },
      ],
    });
  });

  it('shows the fallback reading when no Claude model could read the receipt', async () => {
    const s = setup();
    const id = await filed(s);
    s.readByFallback(id);
    const { body } = await s.call('GET', `/v1/receipts/${id}`, 'riley');
    expect(body).toMatchObject({
      status: 'needs_review',
      merchant: 'Blue Bottle Coffee',
      total: { amountMinor: 725, decimal: '7.25' },
      differences: [],
    });
    expect(
      (body.readings as { label: string; role: string; state: string }[]).map((r) => [
        r.label,
        r.role,
        r.state,
      ]),
    ).toEqual([
      ['Haiku 4.5', 'compared', 'failed'],
      ['Sonnet 5.5', 'compared', 'failed'],
      ['GPT-5.6 Luna', 'fallback', 'confident'],
    ]);
    const list = await s.call('GET', '/v1/receipts', 'riley');
    expect(list.body.comparison).toMatchObject({ receipts: 1, compared: 0, agreed: 0 });
    expect(
      (list.body.comparison as { models: { model: string; role: string; costMicroUsd: number }[] })
        .models,
    ).toEqual([
      expect.objectContaining({ model: 'claude-haiku-4-5', role: 'compared', failed: 1 }),
      expect.objectContaining({ model: 'claude-sonnet-5-5', role: 'compared', failed: 1 }),
      expect.objectContaining({
        model: 'gpt-5.6-luna',
        role: 'fallback',
        confident: 1,
        costMicroUsd: 880,
      }),
    ]);
  });

  it('reads a receipt again on request', async () => {
    const s = setup();
    const id = await filed(s);
    s.read(id, ['6.50', '6.50'], 'extracted');
    const res = await s.call('POST', `/v1/receipts/${id}/read`, 'riley');
    expect(res.status).toBe(202);
    expect(res.body.status).toBe('processing');
    expect(s.dispatched.map((e) => e.topic)).toEqual([
      'receipt.uploaded',
      'receipt.read_requested',
    ]);
    const missing = await s.call(
      'POST',
      '/v1/receipts/0192f7a0-0000-7000-8000-0000000000c9/read',
      'riley',
    );
    expect(missing.status).toBe(404);
  });

  it('says when this server cannot have receipts read', async () => {
    const s = setup({ dispatch: 'none' });
    const { body } = await s.call('GET', '/v1/receipts', 'riley');
    expect(body.readingAvailable).toBe(false);
  });
});
