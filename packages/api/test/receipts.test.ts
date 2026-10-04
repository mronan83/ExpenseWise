import type {
  CommittedEvent,
  DuplicatePairRecord,
  DuplicateSide,
  ExtractionRunRecord,
  Membership,
  NewReceipt,
  ReceiptRecord,
  ReceiptReviewRecord,
} from '@expensewise/db';
import type { ExpenseEdit } from '@expensewise/domain';
import type { ReceiptExtraction } from '@expensewise/extraction';
import { memoryObjectStore } from '@expensewise/storage';
import { describe, expect, it } from 'vitest';
import { createApi } from '../src/app.ts';
import type { Identity } from '../src/auth.ts';
import type { DuplicateDecision, ReceiptStore } from '../src/receipts.ts';
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
  fees: [],
  taxes: [],
  tip: null,
  cardLastFour: null,
  time: null,
  address: null,
  lineItems: [],
});

function fakeReceipts() {
  const receipts: ReceiptRecord[] = [];
  const runs: ExtractionRunRecord[] = [];
  const reviews: ReceiptReviewRecord[] = [];
  const events: CommittedEvent[] = [];
  /** Open pairs, as the held receipt sees them: receiptId is the later copy. */
  const pairs: { held: string; of: string }[] = [];
  /** Receipts whose expense is submitted or further along. */
  const locked = new Set<string>();
  /** What a receipt's expense says beyond the ride every side starts as. */
  const facts = new Map<string, Partial<DuplicateSide>>();
  const decisions: { receiptId: string; otherReceiptId: string; decision: DuplicateDecision }[] =
    [];
  /** What each correction of a Ready receipt changed on its expense. */
  const edits: { receiptId: string; expense: ExpenseEdit; changes: readonly unknown[] }[] = [];
  let n = 0;
  const side = (id: string): DuplicateSide => ({
    receiptId: id,
    source: 'email',
    contentType: 'application/pdf',
    createdAt: NOW,
    expenseId: `expense-${id}`,
    expenseStatus: 'needs_review',
    merchant: 'Uber',
    transactionDate: '2026-10-02',
    currency: 'USD',
    amountMinor: 3142,
    notes: null,
    tripId: null,
    tripName: null,
    time: null,
    address: null,
    city: null,
    country: null,
    ...facts.get(id),
  });
  const pairsOf = (ids: readonly string[]): DuplicatePairRecord[] =>
    pairs.flatMap(({ held, of }) => [
      ...(ids.includes(held)
        ? [
            {
              receiptId: held,
              otherReceiptId: of,
              heldReceiptId: held,
              self: side(held),
              other: side(of),
            },
          ]
        : []),
      ...(ids.includes(of)
        ? [
            {
              receiptId: of,
              otherReceiptId: held,
              heldReceiptId: held,
              self: side(of),
              other: side(held),
            },
          ]
        : []),
    ]);
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
        expenseId: null,
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
    list: (_org, _limit, filter = {}) => {
      const shown = receipts.filter(
        (r) =>
          (!filter.statuses || filter.statuses.includes(r.status)) &&
          (!filter.memberId || r.memberId === filter.memberId),
      );
      return Promise.resolve({
        receipts: shown,
        runs,
        reviews,
        pairs: pairsOf(shown.map((r) => r.id)),
      });
    },
    get: (_org, id) => {
      const receipt = receipts.find((r) => r.id === id);
      return Promise.resolve(
        receipt ? { receipt, runs, reviews, pairs: pairsOf([id]) } : undefined,
      );
    },
    confirm: (_org, id, review) => {
      const i = receipts.findIndex((r) => r.id === id);
      if (i === -1) return Promise.resolve('missing');
      if (!['needs_review', 'failed'].includes(receipts[i]!.status)) {
        return Promise.resolve('not_waiting');
      }
      const latest = runs
        .filter((r) => r.receiptId === id)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
      if ((latest?.requestId ?? null) !== review.requestId) return Promise.resolve('stale');
      if (pairs.some((p) => p.held === id)) return Promise.resolve('duplicate');
      const { memberId: _member, ...values } = review;
      reviews.unshift({
        ...values,
        id: `review-${reviews.length}`,
        receiptId: id,
        reviewedBy: 'riley',
        createdAt: NOW,
      });
      receipts[i] = { ...receipts[i]!, status: 'extracted' };
      return Promise.resolve('confirmed');
    },
    correct: (_org, id, correction) => {
      const i = receipts.findIndex((r) => r.id === id);
      if (i === -1) return Promise.resolve({ status: 'missing' as const });
      if (receipts[i]!.status !== 'extracted') {
        return Promise.resolve({ status: 'not_ready' as const });
      }
      const latest = runs
        .filter((r) => r.receiptId === id)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
      if ((latest?.requestId ?? null) !== correction.review.requestId) {
        return Promise.resolve({ status: 'stale' as const });
      }
      if (locked.has(id)) return Promise.resolve({ status: 'locked' as const });
      edits.push({ receiptId: id, expense: correction.expense, changes: correction.changes });
      const { memberId: _member, ...values } = correction.review;
      reviews.unshift({
        ...values,
        id: `review-${reviews.length}`,
        receiptId: id,
        reviewedBy: 'riley',
        createdAt: NOW,
      });
      return Promise.resolve({ status: 'corrected' as const });
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
    resolveDuplicate: (_org, receiptId, otherReceiptId, decision) => {
      decisions.push({ receiptId, otherReceiptId, decision });
      const at = pairs.findIndex(
        (p) =>
          (p.held === receiptId && p.of === otherReceiptId) ||
          (p.held === otherReceiptId && p.of === receiptId),
      );
      if (at === -1) return Promise.resolve({ status: 'not_a_pair' as const });
      const pair = pairs[at]!;
      if (decision.action === 'keep_both') {
        pairs.splice(at, 1);
        const held = receipts.findIndex((r) => r.id === pair.held);
        receipts[held] = { ...receipts[held]!, status: 'extracted' };
        return Promise.resolve({ status: 'kept_both' as const });
      }
      const kept = decision.action === 'delete' ? decision.keep : decision.primary;
      const doomed = kept === receiptId ? otherReceiptId : receiptId;
      if (locked.has(doomed) || (decision.action === 'merge' && locked.has(kept))) {
        return Promise.resolve({ status: 'locked' as const });
      }
      pairs.splice(at, 1);
      const gone = receipts.findIndex((r) => r.id === doomed);
      const { storageKey } = receipts[gone]!;
      receipts.splice(gone, 1);
      return Promise.resolve(
        decision.action === 'delete'
          ? { status: 'deleted' as const, kept, storageKey }
          : { status: 'merged' as const, kept, storageKey, taken: [...decision.fields] },
      );
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
  return {
    store,
    receipts,
    runs,
    reviews,
    events,
    pairs,
    locked,
    facts,
    decisions,
    edits,
    read,
    readByFallback,
  };
}

function setup(opts: { files?: boolean; dispatch?: 'ok' | 'fails' | 'none'; flags?: string } = {}) {
  const memberships: Record<string, Membership> = {
    riley: { orgId: ORG, memberId: MEMBER, role: 'owner' },
  };
  const workspace = {
    findMembership: (userId: string) => Promise.resolve(memberships[userId]),
    // No organization switches a feature on here: each is off unless the test overrides it.
    featureOn: () => Promise.resolve(false),
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
    flagOverrides: opts.flags,
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

async function filed(s: ReturnType<typeof setup>) {
  const { body: ticket } = await s.call('POST', '/v1/receipts/uploads', 'riley', s.file);
  await s.call('POST', '/v1/receipts', 'riley', {
    id: ticket.receiptId,
    source: 'camera',
    ...s.file,
  });
  return ticket.receiptId as string;
}

describe('reading receipts side by side', () => {
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

  it('names the checks each reading fails: its sums, and a date after the upload', async () => {
    const s = setup();
    const id = await filed(s);
    s.read(id, ['6.50', '6.50'], 'needs_review');
    // Uploaded Oct 2: the subtotal and tax make 6.20, not 6.50; then dated Oct 9.
    const outputs = [
      {
        ...reading('6.50'),
        subtotal: { value: '5.70', confidence: 'high' },
        taxes: [{ label: 'Sales tax', value: '0.50', confidence: 'high' }],
      },
      { ...reading('6.50'), date: { value: '2026-10-09', confidence: 'high' } },
    ];
    const first = s.runs.length - 2;
    outputs.forEach((output, i) => (s.runs[first + i] = { ...s.runs[first + i]!, output }));
    const { body } = await s.call('GET', `/v1/receipts/${id}`, 'riley');
    const readings = body.readings as { checks: string[] }[];
    expect(readings.map((r) => r.checks)).toEqual([['sums'], ['future_date']]);
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

describe('confirming a receipt that needs a look', () => {
  const confirm = (s: ReturnType<typeof setup>, id: string, body: unknown, who = 'riley') =>
    s.call('POST', `/v1/receipts/${id}/confirm`, who, body);

  it('makes the fallback reading Ready with Looks right, and says who confirmed it', async () => {
    const s = setup();
    const id = await filed(s);
    s.readByFallback(id);
    const res = await confirm(s, id, { model: 'gpt-5.6-luna' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'extracted',
      merchant: 'Blue Bottle Coffee',
      date: '2026-09-24',
      total: { amountMinor: 725, currency: 'USD', decimal: '7.25', assumed: false },
      confirmation: {
        by: 'riley',
        model: 'gpt-5.6-luna',
        label: 'GPT-5.6 Luna',
        corrections: [],
      },
    });
    expect(s.reviews).toEqual([
      expect.objectContaining({ totalMinor: 725, taxMinor: 0, tipMinor: 0, corrections: [] }),
    ]);
    const list = await s.call('GET', '/v1/receipts', 'riley');
    expect(list.body.receipts).toEqual([
      expect.objectContaining({ id, status: 'extracted', total: res.body.total }),
    ]);
  });

  it('files corrected fields with Edit a field, keeping what the model read', async () => {
    const s = setup();
    const id = await filed(s);
    s.read(id, ['65.00', '6.50'], 'needs_review');
    const res = await confirm(s, id, {
      model: 'claude-sonnet-5-5',
      corrections: { total: '6.75', tip: '1.00' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'extracted',
      total: { amountMinor: 675, decimal: '6.75' },
      confirmation: {
        label: 'Sonnet 5.5',
        values: {
          merchant: 'Blue Bottle Coffee',
          date: '2026-09-24',
          currency: 'USD',
          total: { amountMinor: 675, decimal: '6.75' },
          taxTotal: { amountMinor: 0, decimal: '0.00' },
          tip: { amountMinor: 100, decimal: '1.00' },
        },
        corrections: [
          { field: 'total', read: '6.50', corrected: '6.75' },
          { field: 'tip', read: null, corrected: '1.00' },
        ],
      },
    });
    // The readings themselves stay as the models read them.
    const sonnet = (res.body.readings as { fields: { total: { decimal: string } } }[])[1];
    expect(sonnet!.fields.total.decimal).toBe('6.50');
  });

  it('refuses a receipt that is not waiting for a look', async () => {
    const s = setup();
    const id = await filed(s);
    expect((await confirm(s, id, { model: 'claude-haiku-4-5' })).status).toBe(409);
    s.read(id, ['6.50', '6.50'], 'extracted');
    const ready = await confirm(s, id, { model: 'claude-haiku-4-5' });
    expect(ready).toMatchObject({ status: 409, body: { code: 'not_waiting' } });
    const missing = await confirm(s, '0192f7a0-0000-7000-8000-0000000000c9', {
      model: 'claude-haiku-4-5',
    });
    expect(missing.status).toBe(404);
  });

  it('names the field that is not valid, or the filing fields still missing', async () => {
    const s = setup();
    const id = await filed(s);
    s.readByFallback(id);
    expect(await confirm(s, id, { model: 'claude-opus-9' })).toMatchObject({
      status: 422,
      body: { code: 'no_such_reading' },
    });
    expect(
      await confirm(s, id, { model: 'gpt-5.6-luna', corrections: { date: '2026-13-01' } }),
    ).toMatchObject({ status: 422, body: { code: 'invalid_value', field: 'date' } });
    expect(
      await confirm(s, id, { model: 'gpt-5.6-luna', corrections: { total: '7.255' } }),
    ).toMatchObject({ status: 422, body: { code: 'invalid_value', field: 'total' } });

    // A reading with no total can't be filed as it is; entering one fixes that.
    const luna = s.runs.findIndex((r) => r.model === 'gpt-5.6-luna');
    s.runs[luna] = { ...s.runs[luna]!, output: { ...reading('7.25'), total: null } };
    expect(await confirm(s, id, { model: 'gpt-5.6-luna' })).toMatchObject({
      status: 422,
      body: { code: 'missing_fields', fields: ['total'] },
    });
    const fixed = await confirm(s, id, { model: 'gpt-5.6-luna', corrections: { total: '7.25' } });
    expect(fixed.status).toBe(200);
    expect(s.reviews).toHaveLength(1);
  });

  it('lets a receipt no model could read be filled in by hand', async () => {
    const s = setup();
    const id = await filed(s);
    s.readByFallback(id);
    const luna = s.runs.findIndex((r) => r.model === 'gpt-5.6-luna');
    s.runs[luna] = { ...s.runs[luna]!, outcome: 'failed', output: null, error: 'unreadable' };
    s.receipts[0] = { ...s.receipts[0]!, status: 'failed' };
    expect(await confirm(s, id, { model: 'gpt-5.6-luna' })).toMatchObject({
      status: 422,
      body: { code: 'missing_fields', fields: ['merchant', 'date', 'currency', 'total'] },
    });
    const res = await confirm(s, id, {
      model: 'gpt-5.6-luna',
      corrections: { merchant: 'Corner Store', date: '2026-10-01', currency: 'USD', total: '4.20' },
    });
    expect(res).toMatchObject({
      status: 200,
      body: { status: 'extracted', merchant: 'Corner Store', total: { decimal: '4.20' } },
    });
  });

  it('starts over when the receipt is read again', async () => {
    const s = setup();
    const id = await filed(s);
    s.readByFallback(id);
    await confirm(s, id, { model: 'gpt-5.6-luna', corrections: { total: '9.00' } });
    const again = await s.call('POST', `/v1/receipts/${id}/read`, 'riley');
    expect(again.body).toMatchObject({ status: 'processing' });
    s.readByFallback(id);
    const { body } = await s.call('GET', `/v1/receipts/${id}`, 'riley');
    expect(body).toMatchObject({
      status: 'needs_review',
      total: { decimal: '7.25' },
      confirmation: null,
    });
  });

  it('needs a signed-in member', async () => {
    const s = setup();
    const id = await filed(s);
    s.readByFallback(id);
    expect(
      (await s.call('POST', `/v1/receipts/${id}/confirm`, undefined, { model: 'gpt-5.6-luna' }))
        .status,
    ).toBe(401);
    expect((await confirm(s, id, { model: 'gpt-5.6-luna' }, 'mallory')).status).toBe(403);
  });
});

describe('the Needs you inbox', () => {
  /** Files a receipt with its own file, so several can be filed. */
  const fileAs = async (s: ReturnType<typeof setup>, sha256: string) => {
    const file = { ...s.file, sha256 };
    const { body: ticket } = await s.call('POST', '/v1/receipts/uploads', 'riley', file);
    await s.call('POST', '/v1/receipts', 'riley', {
      id: ticket.receiptId,
      source: 'camera',
      ...file,
    });
    return ticket.receiptId as string;
  };
  /** Stands in for the workflow when no key is saved: nothing could read it. */
  const failWithoutKey = (s: ReturnType<typeof setup>, id: string) => {
    for (const model of ['claude-haiku-4-5', 'claude-sonnet-5-5'] as const) {
      s.runs.push({
        id: `run-${s.runs.length}`,
        receiptId: id,
        requestId: s.events.at(-1)!.outboxId,
        model,
        promptVersion: 'extract-v1',
        outcome: 'failed',
        output: null,
        error: 'no_key',
        latencyMs: null,
        inputTokens: null,
        outputTokens: null,
        costMicroUsd: null,
        createdAt: new Date(NOW.getTime() + s.runs.length),
      });
    }
    const at = s.receipts.findIndex((r) => r.id === id);
    s.receipts[at] = { ...s.receipts[at]!, status: 'failed' };
  };

  it('lists what needs a look or could not be read, newest first, each with why', async () => {
    const s = setup();
    const ready = await fileAs(s, 'a'.repeat(64));
    s.read(ready, ['6.50', '6.50'], 'extracted');
    const differ = await fileAs(s, 'b'.repeat(64));
    s.read(differ, ['65.00', '6.50'], 'needs_review');
    const fallback = await fileAs(s, 'c'.repeat(64));
    s.readByFallback(fallback);
    await fileAs(s, 'd'.repeat(64)); // still being read
    const failed = await fileAs(s, 'e'.repeat(64));
    failWithoutKey(s, failed);

    const { status, body } = await s.call('GET', '/v1/inbox', 'riley');
    expect(status).toBe(200);
    const items = body.items as {
      kind: string;
      receipt: { id: string; merchant: string | null };
      reason: { code: string; fields: string[]; error: string | null; by: string | null };
    }[];
    expect(items.map((i) => [i.kind, i.receipt.id, i.reason.code])).toEqual([
      ['receipt', failed, 'failed'],
      ['receipt', fallback, 'fallback'],
      ['receipt', differ, 'differ'],
    ]);
    expect(items[0]!.reason.error).toBe('no_key');
    expect(items[1]!.reason.by).toBe('GPT-5.6 Luna');
    expect(items[2]!.reason.fields).toEqual(['total']);
    expect(items[2]!.receipt.merchant).toBe('Blue Bottle Coffee');
  });

  it('says which check failed when the models agree', async () => {
    const s = setup();
    const id = await fileAs(s, 'f'.repeat(64));
    s.read(id, ['6.50', '6.50'], 'needs_review');
    const first = s.runs.length - 2;
    for (const i of [first, first + 1]) {
      s.runs[i] = {
        ...s.runs[i]!,
        output: { ...reading('6.50'), date: { value: '2026-10-09', confidence: 'high' } },
      };
    }
    const { body } = await s.call('GET', '/v1/inbox', 'riley');
    expect((body.items as { reason: unknown }[]).map((i) => i.reason)).toEqual([
      {
        code: 'checks',
        fields: [],
        checks: ['future_date'],
        error: null,
        by: null,
        duplicateOf: null,
      },
    ]);
  });

  it('is empty when nothing needs the person, and needs a signed-in member', async () => {
    const s = setup();
    expect((await s.call('GET', '/v1/inbox', 'riley')).body).toEqual({ items: [] });
    expect((await s.call('GET', '/v1/inbox')).status).toBe(401);
    expect((await s.call('GET', '/v1/inbox', 'mallory')).status).toBe(403);
  });
});

describe('possible duplicates (FR-INT-18)', () => {
  /** Two forwards of one receipt, both read alike; the later is held as a possible copy. */
  const twoForwards = async () => {
    const s = setup();
    const ids: string[] = [];
    for (const sha256 of ['1'.repeat(64), '2'.repeat(64)]) {
      const file = { ...s.file, sha256 };
      const { body: ticket } = await s.call('POST', '/v1/receipts/uploads', 'riley', file);
      await s.call('POST', '/v1/receipts', 'riley', {
        id: ticket.receiptId,
        source: 'upload',
        ...file,
      });
      const id = ticket.receiptId as string;
      s.files.put(`orgs/${ORG}/receipts/${id}`, new Uint8Array([1]));
      ids.push(id);
    }
    const [first, copy] = ids as [string, string];
    s.read(first, ['6.50', '6.50'], 'extracted');
    s.read(copy, ['6.50', '6.50'], 'needs_review');
    s.pairs.push({ held: copy, of: first });
    return { ...s, first, copy };
  };

  it('puts the later copy in Needs you, naming the receipt it looks like', async () => {
    const s = await twoForwards();
    const { body } = await s.call('GET', '/v1/inbox', 'riley');
    const items = body.items as { receipt: { id: string }; reason: unknown }[];
    expect(items.map((i) => i.receipt.id)).toEqual([s.copy]);
    expect(items[0]!.reason).toEqual({
      code: 'duplicate',
      fields: [],
      checks: [],
      error: null,
      by: null,
      duplicateOf: {
        kind: 'possible',
        receiptId: s.first,
        merchant: 'Uber',
        date: '2026-10-02',
        amount: { amountMinor: 3142, currency: 'USD', decimal: '31.42' },
        createdAt: NOW.toISOString(),
      },
    });
  });

  it('says whether a pair is exact or possible, from the time, place and total (ADR-0031)', async () => {
    const s = await twoForwards();
    const omaha = { time: '18:42', city: 'Omaha', country: 'US', address: null };
    s.facts.set(s.first, omaha);
    s.facts.set(s.copy, omaha);
    const kind = async () => {
      const { body } = await s.call('GET', `/v1/receipts/${s.copy}`, 'riley');
      return (body.duplicates as { kind: string }[])[0]!.kind;
    };
    expect(await kind()).toBe('exact');
    const { body } = await s.call('GET', '/v1/inbox', 'riley');
    expect(body.items).toMatchObject([{ reason: { duplicateOf: { kind: 'exact' } } }]);
    // A tip added a few minutes later: the same purchase, possibly.
    s.facts.set(s.copy, { ...omaha, time: '18:47', amountMinor: 3642 });
    expect(await kind()).toBe('possible');
    // Edited apart since it was flagged: it stays possible until the person decides.
    s.facts.set(s.copy, { ...omaha, time: '09:00' });
    expect(await kind()).toBe('possible');
  });

  it('shows the pair on both receipts, and refuses Looks right while the copy is held', async () => {
    const s = await twoForwards();
    const held = await s.call('GET', `/v1/receipts/${s.copy}`, 'riley');
    expect(held.body.duplicates).toHaveLength(1);
    expect(held.body.duplicates).toMatchObject([
      {
        kind: 'possible',
        held: true,
        self: { receiptId: s.copy, merchant: 'Uber', trip: null },
        other: {
          receiptId: s.first,
          amount: { amountMinor: 3142, currency: 'USD', decimal: '31.42' },
        },
      },
    ]);
    const original = await s.call('GET', `/v1/receipts/${s.first}`, 'riley');
    expect(original.body.duplicates).toMatchObject([
      { held: false, self: { receiptId: s.first }, other: { receiptId: s.copy } },
    ]);

    const confirm = await s.call('POST', `/v1/receipts/${s.copy}/confirm`, 'riley', {
      model: 'claude-sonnet-5-5',
    });
    expect(confirm.status).toBe(409);
    expect(confirm.body.code).toBe('possible_duplicate');
    expect(s.reviews).toHaveLength(0);
  });

  it('keeps both: nothing is deleted', async () => {
    const s = await twoForwards();
    const res = await s.call('POST', `/v1/receipts/${s.copy}/duplicates/${s.first}`, 'riley', {
      action: 'keep_both',
    });
    expect(res).toEqual({
      status: 200,
      body: { outcome: 'kept_both', kept: s.copy, deleted: null, taken: [] },
    });
    expect(s.files.objects.size).toBe(2);
  });

  it('deletes the one not kept, then its file', async () => {
    const s = await twoForwards();
    const res = await s.call('POST', `/v1/receipts/${s.copy}/duplicates/${s.first}`, 'riley', {
      action: 'delete',
      keep: s.first,
    });
    expect(res).toEqual({
      status: 200,
      body: { outcome: 'deleted', kept: s.first, deleted: s.copy, taken: [] },
    });
    expect(s.receipts.map((r) => r.id)).toEqual([s.first]);
    expect([...s.files.objects.keys()]).toEqual([`orgs/${ORG}/receipts/${s.first}`]);
  });

  it('merges into the primary chosen, from either receipt’s page', async () => {
    const s = await twoForwards();
    const res = await s.call('POST', `/v1/receipts/${s.first}/duplicates/${s.copy}`, 'riley', {
      action: 'merge',
      primary: s.copy,
      fields: ['notes', 'trip'],
    });
    expect(res.body).toEqual({
      outcome: 'merged',
      kept: s.copy,
      deleted: s.first,
      taken: ['notes', 'trip'],
    });
    expect(s.decisions.at(-1)?.decision).toEqual({
      action: 'merge',
      primary: s.copy,
      fields: ['notes', 'trip'],
    });
    expect([...s.files.objects.keys()]).toEqual([`orgs/${ORG}/receipts/${s.copy}`]);
  });

  it('refuses a receipt outside the pair, a pair already decided, and a locked expense', async () => {
    const s = await twoForwards();
    const path = `/v1/receipts/${s.copy}/duplicates/${s.first}`;
    const outside = await s.call('POST', path, 'riley', { action: 'delete', keep: MEMBER });
    expect([outside.status, outside.body.code]).toEqual([422, 'not_in_pair']);
    expect(s.decisions).toHaveLength(0);

    const badField = await s.call('POST', path, 'riley', {
      action: 'merge',
      primary: s.first,
      fields: ['category'],
    });
    expect(badField.status).toBe(400);

    s.locked.add(s.copy);
    const locked = await s.call('POST', path, 'riley', { action: 'delete', keep: s.first });
    expect([locked.status, locked.body.code]).toEqual([409, 'locked']);
    expect(s.files.objects.size).toBe(2);

    await s.call('POST', path, 'riley', { action: 'keep_both' });
    const again = await s.call('POST', path, 'riley', { action: 'keep_both' });
    expect([again.status, again.body.code]).toEqual([404, 'not_a_pair']);
  });

  it('still deletes when the file can’t be removed, and needs a signed-in member', async () => {
    const s = await twoForwards();
    s.files.remove = () => Promise.reject(new Error('storage down'));
    const res = await s.call('POST', `/v1/receipts/${s.copy}/duplicates/${s.first}`, 'riley', {
      action: 'delete',
      keep: s.first,
    });
    expect(res.status).toBe(200);
    expect(s.receipts.map((r) => r.id)).toEqual([s.first]);

    const path = `/v1/receipts/${s.first}/duplicates/${s.copy}`;
    expect((await s.call('POST', path, undefined, { action: 'keep_both' })).status).toBe(401);
    expect((await s.call('POST', path, 'mallory', { action: 'keep_both' })).status).toBe(403);
  });
});

describe('where each field was read, and a Ready receipt corrected with a tap', () => {
  const SOURCES = 'receipts.field-sources=on';
  const correct = (s: ReturnType<typeof setup>, id: string, corrections: unknown) =>
    s.call('POST', `/v1/receipts/${id}/corrections`, 'riley', { corrections });
  /** The line each field was read from, as a model asked for them answers. */
  const lines = {
    merchant: 'BLUE BOTTLE COFFEE',
    date: '09/24/2026 08:12',
    time: null,
    address: null,
    currency: null,
    total: 'TOTAL ........ $6.50',
    subtotal: null,
    taxes: null,
    tip: null,
    fees: null,
    cardLastFour: null,
  };

  it('shows the line each field was read from beside it, with the feature on', async () => {
    const s = setup({ flags: SOURCES });
    const id = await filed(s);
    const pending = await s.call('GET', `/v1/receipts/${id}`, 'riley');
    expect((pending.body.readings as { sources: unknown }[]).map((r) => r.sources)).toEqual([
      null,
      null,
    ]);
    s.read(id, ['6.50', '6.50'], 'extracted');
    // Sonnet was asked for the lines; Haiku's reading came before the feature was on.
    const sonnet = s.runs.findIndex((r) => r.model === 'claude-sonnet-5-5');
    s.runs[sonnet] = {
      ...s.runs[sonnet]!,
      promptVersion: 'extract-v4',
      output: { ...reading('6.50'), sources: lines },
    };
    const { body } = await s.call('GET', `/v1/receipts/${id}`, 'riley');
    const [haiku, withLines] = body.readings as { sources: Record<string, unknown> | null }[];
    expect(haiku!.sources).toBeNull();
    expect(withLines!.sources).toEqual({
      merchant: 'BLUE BOTTLE COFFEE',
      date: '09/24/2026 08:12',
      time: null,
      address: null,
      currency: null,
      total: 'TOTAL ........ $6.50',
      subtotal: null,
      taxTotal: null,
      tip: null,
      fees: null,
      cardLastFour: null,
    });
  });

  it('shows no source lines and takes no correction with the feature off, as before', async () => {
    const s = setup();
    const id = await filed(s);
    s.read(id, ['6.50', '6.50'], 'extracted');
    const at = s.runs.findIndex((r) => r.model === 'claude-sonnet-5-5');
    s.runs[at] = { ...s.runs[at]!, output: { ...reading('6.50'), sources: lines } };
    const { body } = await s.call('GET', `/v1/receipts/${id}`, 'riley');
    for (const r of body.readings as object[]) expect(r).not.toHaveProperty('sources');
    const res = await correct(s, id, { merchant: 'Blue Bottle' });
    expect([res.status, res.body.code]).toEqual([404, 'feature_off']);
    expect(s.reviews).toEqual([]);
  });

  it('corrects a field of a Ready receipt through its expense, keeping what the model read', async () => {
    const s = setup({ flags: SOURCES });
    const id = await filed(s);
    s.read(id, ['6.50', '6.50'], 'extracted');
    const res = await correct(s, id, { merchant: 'Blue Bottle Coffee — Oxbow' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'extracted',
      merchant: 'Blue Bottle Coffee — Oxbow',
      confirmation: {
        by: 'riley',
        model: 'claude-sonnet-5-5',
        corrections: [
          {
            field: 'merchant',
            read: 'Blue Bottle Coffee',
            corrected: 'Blue Bottle Coffee — Oxbow',
          },
        ],
      },
    });
    // The review keeps every value filed, against the reading the expense was filed with.
    expect(s.reviews[0]).toMatchObject({
      requestId: s.events.at(-1)!.outboxId,
      model: 'claude-sonnet-5-5',
      merchant: 'Blue Bottle Coffee — Oxbow',
      totalMinor: 650,
      taxMinor: 0,
      tipMinor: 0,
    });
    expect(s.edits).toEqual([
      {
        receiptId: id,
        expense: { merchant: 'Blue Bottle Coffee — Oxbow' },
        changes: [
          { field: 'merchant', from: 'Blue Bottle Coffee', to: 'Blue Bottle Coffee — Oxbow' },
        ],
      },
    ]);
  });

  it('keeps an earlier correction when another field is corrected; tax and tip stay on the receipt', async () => {
    const s = setup({ flags: SOURCES });
    const id = await filed(s);
    s.read(id, ['6.50', '6.50'], 'extracted');
    expect((await correct(s, id, { total: '7.25' })).status).toBe(200);
    const res = await correct(s, id, { tip: '1.00' });
    expect(res.status).toBe(200);
    expect((res.body.confirmation as { corrections: unknown[] }).corrections).toEqual([
      { field: 'total', read: '6.50', corrected: '7.25' },
      { field: 'tip', read: null, corrected: '1.00' },
    ]);
    expect(s.edits.map((e) => e.expense)).toEqual([{ amount: '7.25' }, {}]);
    expect(s.reviews[0]).toMatchObject({ totalMinor: 725, tipMinor: 100 });
  });

  it('refuses a receipt not Ready, a locked expense, a value not valid, and one filed so already', async () => {
    const s = setup({ flags: SOURCES });
    const id = await filed(s);
    s.read(id, ['65.00', '6.50'], 'needs_review');
    const waiting = await correct(s, id, { total: '6.50' });
    expect([waiting.status, waiting.body.code]).toEqual([409, 'not_ready']);

    s.read(id, ['6.50', '6.50'], 'extracted');
    const invalid = await correct(s, id, { date: '2026-02-30' });
    expect([invalid.status, invalid.body.code, invalid.body.field]).toEqual([
      422,
      'invalid_value',
      'date',
    ]);
    const same = await correct(s, id, { total: '6.5' });
    expect([same.status, same.body.code]).toEqual([422, 'unchanged']);
    const empty = await correct(s, id, {});
    expect(empty.status).toBe(400);

    s.locked.add(id);
    const locked = await correct(s, id, { merchant: 'Blue Bottle' });
    expect([locked.status, locked.body.code]).toEqual([409, 'locked']);
    expect(locked.body.detail).toContain('reversal');
    expect(s.reviews).toEqual([]);
  });
});

describe('the time from capture to read', () => {
  const CAPTURE = 'receipts.capture-time=on';
  const fileAs = async (s: ReturnType<typeof setup>, sha256: string) => {
    const file = { ...s.file, sha256 };
    const { body: ticket } = await s.call('POST', '/v1/receipts/uploads', 'riley', file);
    await s.call('POST', '/v1/receipts', 'riley', {
      id: ticket.receiptId,
      source: 'camera',
      ...file,
    });
    return ticket.receiptId as string;
  };
  /** Settles a receipt this long after it was filed. */
  const settleAfter = (s: ReturnType<typeof setup>, id: string, ms: number) => {
    s.read(id, ['6.50', '6.50'], 'extracted');
    const at = s.receipts.findIndex((r) => r.id === id);
    s.receipts[at] = { ...s.receipts[at]!, settledAt: new Date(NOW.getTime() + ms) };
  };

  it('shows the 95th percentile beside the comparison, over the receipts read, with the feature on', async () => {
    const s = setup({ flags: CAPTURE });
    const times = [4_200, 9_800, 12_345, 31_000];
    for (const [i, ms] of times.entries()) {
      settleAfter(s, await fileAs(s, String(i + 1).repeat(64)), ms);
    }
    // One still being read for the first time: it has no time yet.
    await fileAs(s, '9'.repeat(64));
    const { body } = await s.call('GET', '/v1/receipts', 'riley');
    expect(body.captureToReady).toEqual({
      receipts: 4,
      p95Ms: 31_000,
      sloMs: 30_000,
      withinSlo: false,
    });
  });

  it('is left out with the feature off, so Receipts is as it was', async () => {
    const s = setup();
    settleAfter(s, await fileAs(s, '1'.repeat(64)), 4_200);
    const { body } = await s.call('GET', '/v1/receipts', 'riley');
    expect(body).not.toHaveProperty('captureToReady');
    expect(Object.keys(body)).toEqual(['receipts', 'comparison', 'readingAvailable']);
  });
});
