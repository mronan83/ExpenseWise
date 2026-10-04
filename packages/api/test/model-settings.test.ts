import type {
  AiProvider,
  ExtractionRunRecord,
  Membership,
  ModelSwitch,
  ReceiptRecord,
  ReceiptReviewRecord,
  StoredModelSettings,
  StoredProviderKey,
} from '@expensewise/db';
import type { ReceiptExtraction } from '@expensewise/extraction';
import { describe, expect, it } from 'vitest';
import { createApi } from '../src/app.ts';
import type { Identity } from '../src/auth.ts';
import type { ModelSettingsStore } from '../src/model-settings.ts';
import type { ReceiptStore } from '../src/receipts.ts';
import type { WorkspaceStore } from '../src/workspace.ts';

const ORG = '0192f7a0-0000-7000-8000-0000000000a1';
const NOW = new Date('2026-10-04T12:00:00.000Z');
const RECEIPT = '0192f7a0-0000-7000-8000-0000000000d1';
const REQUEST = '0192f7a0-0000-7000-8000-0000000000e1';
const ON = 'receipts.model-settings=on';

const identity = (userId: string): Identity => ({
  userId,
  email: `${userId}@example.com`,
  assuranceLevel: 'aal1',
  sessionId: 's',
  issuedAt: NOW,
});

const reading = (total: string, confidence: 'high' | 'low' = 'high'): ReceiptExtraction => ({
  documentType: 'receipt',
  merchant: { name: 'Blue Bottle Coffee', confidence: 'high' },
  date: { value: '2026-09-24', confidence: 'high' },
  currency: { code: 'USD', confidence: 'high' },
  total: { value: total, confidence },
  subtotal: null,
  fees: [],
  taxes: [],
  tip: null,
  cardLastFour: null,
  time: null,
  address: null,
  lineItems: [],
});

type Run = Partial<ExtractionRunRecord> & Pick<ExtractionRunRecord, 'model' | 'outcome'>;

function setup(opts: { overrides?: string; keys?: AiProvider[] } = {}) {
  const memberships: Record<string, Membership> = {
    owner: { orgId: ORG, memberId: 'm-owner', role: 'owner' },
    finance: { orgId: ORG, memberId: 'm-finance', role: 'finance_admin' },
    alex: { orgId: ORG, memberId: 'm-alex', role: 'member' },
  };
  const keys = (opts.keys ?? ['anthropic']).map((provider): StoredProviderKey => ({
    provider,
    ciphertext: 'x',
    keyHint: 'wxyz',
    authScheme: 'api_key',
    verifiedAt: NOW,
    updatedAt: NOW,
  }));
  const workspace = {
    findMembership: (userId: string) => Promise.resolve(memberships[userId]),
    listKeys: () => Promise.resolve(keys),
    featureOn: () => Promise.resolve(false),
    listFeatures: () => Promise.resolve([]),
  } as unknown as WorkspaceStore;

  let saved: StoredModelSettings | undefined;
  const saves: { member: Membership; actor: string; models: readonly ModelSwitch[] }[] = [];
  const modelSettings: ModelSettingsStore = {
    get: () => Promise.resolve(saved),
    save: (member, settings, actor) => {
      saves.push({ member, actor, models: settings.models });
      saved = { ...settings, updatedAt: NOW };
      return Promise.resolve('saved');
    },
  };

  const receipts: ReceiptRecord[] = [];
  const runs: ExtractionRunRecord[] = [];
  const reviews: ReceiptReviewRecord[] = [];
  const store = {
    list: () => Promise.resolve({ receipts, runs, reviews, pairs: [] }),
    get: (_org: string, id: string) => {
      const receipt = receipts.find((r) => r.id === id);
      return Promise.resolve(receipt ? { receipt, runs, reviews, pairs: [] } : undefined);
    },
    confirm: (_org: string, id: string, review: { model: string; requestId: string | null }) => {
      const i = receipts.findIndex((r) => r.id === id);
      reviews.unshift({
        ...(review as unknown as ReceiptReviewRecord),
        id: 'review-1',
        receiptId: id,
        reviewedBy: 'owner',
        createdAt: NOW,
      });
      receipts[i] = { ...receipts[i]!, status: 'extracted' };
      return Promise.resolve('confirmed');
    },
  } as unknown as ReceiptStore;

  const receipt = (status: ReceiptRecord['status']) => {
    receipts.splice(0, receipts.length, {
      id: RECEIPT,
      memberId: 'm-owner',
      uploadedBy: 'owner',
      source: 'camera',
      storageKey: `orgs/${ORG}/receipts/${RECEIPT}`,
      contentType: 'image/jpeg',
      byteSize: 1000,
      sha256: 'a'.repeat(64),
      status,
      expenseId: 'expense-1',
      createdAt: NOW,
    });
  };
  const read = (...made: Run[]) =>
    made.forEach((run, i) =>
      runs.push({
        id: `run-${runs.length}`,
        receiptId: RECEIPT,
        requestId: REQUEST,
        promptVersion: 'extract-v1',
        output: null,
        error: null,
        latencyMs: 2000,
        inputTokens: 1500,
        outputTokens: 300,
        costMicroUsd: 4000,
        createdAt: new Date(NOW.getTime() + i),
        ...run,
      }),
    );

  const api = createApi({
    version: 't',
    verifyToken: (token) => Promise.resolve(identity(token)),
    workspace,
    receipts: store,
    modelSettings,
    ...(opts.overrides === undefined ? {} : { flagOverrides: opts.overrides }),
  });
  const call = async (method: string, path: string, who: string, body?: unknown) => {
    const res = await api.request(path, {
      method,
      headers: {
        authorization: `Bearer ${who}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: (await res.json().catch(() => null)) as never };
  };
  return { call, saves, receipt, read, reviews };
}

interface ModelView {
  model: string;
  enabled: boolean;
  primary: boolean;
  reads: string;
  keyConfigured: boolean;
  stopped: boolean;
  record: { readings: number; confident: number };
}
const byModel = (body: { models: ModelView[] }) =>
  Object.fromEntries(body.models.map((m) => [m.model, m]));

const choose = (primary: string | null, on: string[], order = ALL) => ({
  primary,
  models: order.map((model) => ({ model, enabled: on.includes(model) })),
});
const ALL = [
  'claude-sonnet-5-5',
  'claude-haiku-4-5',
  'gpt-5.6-luna',
  'claude-opus-5-5',
  'claude-fable-5-1',
];

describe('Settings › AI models (FR-INT-16)', () => {
  it('answers 404 feature_off while AI model settings are off', async () => {
    const s = setup();
    expect(await s.call('GET', '/v1/settings/ai-models', 'owner')).toMatchObject({
      status: 404,
      body: { code: 'feature_off' },
    });
    expect(await s.call('PUT', '/v1/settings/ai-models', 'owner', choose(null, []))).toMatchObject({
      status: 404,
      body: { code: 'feature_off' },
    });
    expect(s.saves).toEqual([]);
  });

  it('shows each model, the primary, what each does now and how each has read our receipts', async () => {
    const s = setup({ overrides: ON });
    s.receipt('extracted');
    s.read({ model: 'claude-sonnet-5-5', outcome: 'confident', role: 'primary' });
    const { status, body } = await s.call('GET', '/v1/settings/ai-models', 'owner');
    expect(status).toBe(200);
    expect(body).toMatchObject({ primary: 'claude-sonnet-5-5', saved: false, canChange: true });
    const models = byModel(body);
    expect(Object.keys(models)).toEqual(ALL);
    expect(models['claude-sonnet-5-5']).toMatchObject({
      label: 'Sonnet 5.5',
      price: { input: '2.00', output: '10.00' },
      enabled: true,
      primary: true,
      reads: 'primary',
      record: { readings: 1, confident: 1, failed: 0, averageLatencyMs: 2000, costMicroUsd: 4000 },
    });
    expect(models['claude-haiku-4-5']).toMatchObject({ enabled: true, reads: 'backup' });
    // A model with no key stays off.
    expect(models['gpt-5.6-luna']).toMatchObject({
      enabled: false,
      reads: 'off',
      keyConfigured: false,
    });
    expect(models['claude-opus-5-5']).toMatchObject({ enabled: false, reads: 'off' });
  });

  it('saves any model as primary and the back-ups in order, for owners and finance admins', async () => {
    const s = setup({ overrides: ON, keys: ['anthropic', 'openai'] });
    const order = ['gpt-5.6-luna', 'claude-haiku-4-5', 'claude-sonnet-5-5', ...ALL.slice(3)];
    const chosen = choose(
      'gpt-5.6-luna',
      ['gpt-5.6-luna', 'claude-sonnet-5-5', 'claude-haiku-4-5'],
      order,
    );
    const { status, body } = await s.call('PUT', '/v1/settings/ai-models', 'finance', chosen);
    expect(status).toBe(200);
    expect(body).toMatchObject({ primary: 'gpt-5.6-luna', saved: true });
    expect((body as { models: ModelView[] }).models.map((m) => [m.model, m.reads])).toEqual([
      ['gpt-5.6-luna', 'primary'],
      ['claude-haiku-4-5', 'backup'],
      ['claude-sonnet-5-5', 'backup'],
      ['claude-opus-5-5', 'off'],
      ['claude-fable-5-1', 'off'],
    ]);
    // Who changed it goes with the change, for its audit event.
    expect(s.saves).toHaveLength(1);
    expect(s.saves[0]).toMatchObject({ actor: 'finance', models: chosen.models });
    expect(s.saves[0]?.member.memberId).toBe('m-finance');
  });

  it('lets every model be off, so receipts are filed for a person to fill in', async () => {
    const s = setup({ overrides: ON });
    const { status, body } = await s.call(
      'PUT',
      '/v1/settings/ai-models',
      'owner',
      choose(null, []),
    );
    expect(status).toBe(200);
    expect(body).toMatchObject({ primary: null });
    expect((body as { models: ModelView[] }).models.every((m) => m.reads === 'off')).toBe(true);
  });

  it('lets anyone see the models, and only owners and finance admins change them', async () => {
    const s = setup({ overrides: ON });
    expect(await s.call('GET', '/v1/settings/ai-models', 'alex')).toMatchObject({
      status: 200,
      body: { canChange: false },
    });
    expect(await s.call('PUT', '/v1/settings/ai-models', 'alex', choose(null, []))).toMatchObject({
      status: 403,
      body: { code: 'forbidden_role' },
    });
    expect(s.saves).toEqual([]);
  });

  it('refuses a primary that is off, a model missing or unknown, and a model with no key', async () => {
    const s = setup({ overrides: ON });
    const put = (body: unknown) => s.call('PUT', '/v1/settings/ai-models', 'owner', body);
    expect(await put(choose('claude-opus-5-5', ['claude-haiku-4-5']))).toMatchObject({
      status: 422,
      body: { code: 'primary_off' },
    });
    expect(await put(choose(null, ['claude-haiku-4-5']))).toMatchObject({
      status: 422,
      body: { code: 'primary_required' },
    });
    expect(await put(choose(null, [], ALL.slice(1)))).toMatchObject({
      status: 422,
      body: { code: 'models_missing' },
    });
    expect(
      await put({
        primary: null,
        models: [...choose(null, []).models, { model: 'gpt-4', enabled: false }],
      }),
    ).toMatchObject({ status: 422, body: { code: 'unknown_model' } });
    const keyless = await put(choose('gpt-5.6-luna', ['gpt-5.6-luna']));
    expect(keyless).toMatchObject({ status: 422, body: { code: 'no_key' } });
    expect((keyless.body as { detail: string }).detail).toContain('OpenAI key');
    expect(s.saves).toEqual([]);
  });

  it('shows a model the operator stopped as reading nothing, whatever was chosen', async () => {
    const s = setup({ overrides: `${ON},operator.claude-sonnet-5-5=off` });
    const models = byModel((await s.call('GET', '/v1/settings/ai-models', 'owner')).body);
    expect(models['claude-sonnet-5-5']).toMatchObject({
      primary: true,
      stopped: true,
      reads: 'off',
    });
    expect(models['claude-haiku-4-5']).toMatchObject({ reads: 'primary' });
  });
});

describe('receipts read under the organization’s AI model settings', () => {
  it('shows the model reading it, then each model that read, as primary or back-up', async () => {
    const s = setup({ overrides: ON });
    s.receipt('processing');
    const pending = await s.call('GET', `/v1/receipts/${RECEIPT}`, 'owner');
    expect(
      (pending.body as { readings: { model: string; role: string; state: string }[] }).readings,
    ).toEqual([
      expect.objectContaining({ model: 'claude-sonnet-5-5', role: 'primary', state: 'pending' }),
    ]);

    s.receipt('needs_review');
    s.read(
      {
        model: 'claude-sonnet-5-5',
        outcome: 'failed',
        role: 'primary',
        error: 'request_rejected: Your credit balance is too low',
      },
      {
        model: 'claude-haiku-4-5',
        outcome: 'unsure',
        role: 'backup',
        output: reading('6.50', 'low'),
      },
    );
    const { body } = await s.call('GET', `/v1/receipts/${RECEIPT}`, 'owner');
    expect(body).toMatchObject({
      merchant: 'Blue Bottle Coffee',
      total: { decimal: '6.50' },
      differences: [],
      readings: [
        { model: 'claude-sonnet-5-5', role: 'primary', state: 'failed' },
        { model: 'claude-haiku-4-5', role: 'backup', state: 'unsure' },
      ],
    });
    const inbox = await s.call('GET', '/v1/inbox', 'owner');
    expect(inbox.body).toMatchObject({ items: [{ reason: { code: 'unsure' } }] });
  });

  it('puts a receipt nothing read in Needs you, to be filled in by hand', async () => {
    const s = setup({ overrides: ON });
    s.receipt('needs_review');
    expect(await s.call('GET', '/v1/inbox', 'owner')).toMatchObject({
      body: { items: [{ kind: 'receipt', reason: { code: 'not_read' } }] },
    });
    expect((await s.call('GET', `/v1/receipts/${RECEIPT}`, 'owner')).body).toMatchObject({
      readings: [],
    });
    const confirm = (body: unknown) =>
      s.call('POST', `/v1/receipts/${RECEIPT}/confirm`, 'owner', body);
    expect(await confirm({ corrections: { merchant: 'Corner Store' } })).toMatchObject({
      status: 422,
      body: { code: 'missing_fields', fields: ['date', 'currency', 'total'] },
    });
    const res = await confirm({
      corrections: { merchant: 'Corner Store', date: '2026-10-01', currency: 'USD', total: '4.20' },
    });
    expect(res).toMatchObject({
      status: 200,
      body: {
        status: 'extracted',
        merchant: 'Corner Store',
        readings: [],
        confirmation: { model: 'none', label: 'Filled in by hand' },
      },
    });
    expect(s.reviews[0]).toMatchObject({ model: 'none', requestId: null, totalMinor: 420 });
  });

  it('asks for a model when the receipt has readings to choose from', async () => {
    const s = setup({ overrides: ON });
    s.receipt('needs_review');
    s.read({
      model: 'claude-sonnet-5-5',
      outcome: 'unsure',
      role: 'primary',
      output: reading('6.50', 'low'),
    });
    expect(
      await s.call('POST', `/v1/receipts/${RECEIPT}/confirm`, 'owner', {
        corrections: { total: '6.50' },
      }),
    ).toMatchObject({ status: 422, body: { code: 'no_such_reading' } });
  });
});
