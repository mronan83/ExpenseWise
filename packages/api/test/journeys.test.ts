import type {
  ExpenseRecord,
  ExtractionRunRecord,
  Membership,
  ReceiptRecord,
  ReceiptReviewRecord,
} from '@expensewise/db';
import { applyTravelEdit, type ExpenseTravel } from '@expensewise/domain';
import type { ReceiptExtraction } from '@expensewise/extraction';
import { describe, expect, it } from 'vitest';
import { createApi } from '../src/app.ts';
import type { Identity } from '../src/auth.ts';
import type { ExpenseStore } from '../src/expenses.ts';
import type { ReceiptStore } from '../src/receipts.ts';
import type { WorkspaceStore } from '../src/workspace.ts';

const ORG = '0192f7a0-0000-7000-8000-0000000000a1';
const MEMBER = '0192f7a0-0000-7000-8000-0000000000b1';
const RECEIPT = '0192f7a0-0000-7000-8000-0000000000d1';
const EXPENSE = '0192f7a0-0000-7000-8000-0000000000e1';
const REQUEST = '0192f7a0-0000-7000-8000-0000000000f1';
const NOW = new Date('2026-10-03T12:00:00.000Z');
const ON = 'receipts.journeys=on';

const identity = (userId: string): Identity => ({
  userId,
  email: `${userId}@example.com`,
  assuranceLevel: 'aal1',
  sessionId: 's',
  issuedAt: NOW,
});

/** A hotel folio read with its stay, as an organization with the feature on is asked. */
const folio: ReceiptExtraction = {
  documentType: 'hotel_folio',
  merchant: { name: 'Hilton Omaha', confidence: 'high' },
  date: { value: '2026-10-01', confidence: 'high' },
  currency: { code: 'USD', confidence: 'high' },
  total: { value: '412.60', confidence: 'high' },
  subtotal: null,
  fees: [],
  taxes: [],
  tip: null,
  cardLastFour: null,
  time: null,
  address: null,
  lineItems: [],
  journey: null,
  stay: {
    checkIn: { value: '2026-09-29', confidence: 'high' },
    checkOut: { value: '2026-10-01', confidence: 'medium' },
  },
};

const STAY: ExpenseTravel = {
  journeyFrom: null,
  journeyTo: null,
  checkIn: '2026-09-29',
  checkOut: '2026-10-01',
};

function setup(options: { flags?: string; travel?: ExpenseTravel; status?: string } = {}) {
  const receipt: ReceiptRecord = {
    id: RECEIPT,
    memberId: MEMBER,
    uploadedBy: 'riley',
    source: 'upload',
    storageKey: `orgs/${ORG}/receipts/${RECEIPT}`,
    contentType: 'application/pdf',
    byteSize: 40_000,
    sha256: 'a'.repeat(64),
    status: (options.status ?? 'extracted') as ReceiptRecord['status'],
    expenseId: EXPENSE,
    createdAt: NOW,
  };
  const runs: ExtractionRunRecord[] = ['claude-haiku-4-5', 'claude-sonnet-5-5'].map((model) => ({
    id: `run-${model}`,
    receiptId: RECEIPT,
    requestId: REQUEST,
    model,
    promptVersion: 'extract-v3+journeys-v1',
    outcome: 'confident',
    output: folio,
    error: null,
    latencyMs: 2500,
    inputTokens: 2000,
    outputTokens: 400,
    costMicroUsd: 880,
    createdAt: NOW,
  }));
  const reviews: ReceiptReviewRecord[] = [];
  let expense: ExpenseRecord = {
    id: EXPENSE,
    memberId: MEMBER,
    owner: 'riley',
    status: 'ready',
    source: 'upload',
    merchant: 'Hilton Omaha',
    transactionDate: '2026-10-01',
    currency: 'USD',
    amountMinor: 41_260,
    receiptId: RECEIPT,
    tripId: null,
    tripName: null,
    tripPinned: false,
    time: null,
    timeZone: null,
    address: null,
    city: null,
    region: null,
    country: null,
    ...(options.travel ?? STAY),
    reportId: null,
    tripReportId: null,
    justification: null,
    editedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
  const edits: Parameters<ExpenseStore['edit']>[2][] = [];
  const expenses: ExpenseStore = {
    list: () => Promise.resolve({ expenses: [expense], receipts: [receipt], runs, reviews }),
    get: () => Promise.resolve({ expense, proof: { receipt, runs, reviews } }),
    edit: (_org, _id, edit) => {
      edits.push(edit);
      const applied = applyTravelEdit(
        {
          journeyFrom: expense.journeyFrom ?? null,
          journeyTo: expense.journeyTo ?? null,
          checkIn: expense.checkIn ?? null,
          checkOut: expense.checkOut ?? null,
        },
        edit.travel ?? {},
      );
      if (!applied.ok) return Promise.resolve({ status: 'invalid', problem: applied.error });
      expense = { ...expense, ...applied.value.travel, editedAt: NOW };
      return Promise.resolve({
        status: 'edited',
        changes: [],
        detailChanges: [],
        travelChanges: applied.value.changes,
      });
    },
    setTrip: () => Promise.resolve({ status: 'missing' }),
  };
  const confirmed: unknown[] = [];
  const receipts = {
    get: () => Promise.resolve({ receipt, runs, reviews, pairs: [] }),
    confirm: (...args: unknown[]) => {
      confirmed.push(args[5]);
      return Promise.resolve('confirmed');
    },
  } as unknown as ReceiptStore;
  const memberships: Record<string, Membership> = {
    riley: { orgId: ORG, memberId: MEMBER, role: 'owner' },
  };
  const api = createApi({
    version: 't',
    verifyToken: (token) => Promise.resolve(identity(token)),
    workspace: {
      findMembership: (userId: string) => Promise.resolve(memberships[userId]),
      featureOn: () => Promise.resolve(false),
    } as unknown as WorkspaceStore,
    expenses,
    receipts,
    flagOverrides: options.flags,
  });
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await api.request(path, {
      method,
      headers: {
        authorization: 'Bearer riley',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return {
      status: res.status,
      body: (await res.json().catch(() => null)) as Record<string, unknown>,
    };
  };
  return { call, edits, confirmed };
}

describe('journeys and stays, switched off', () => {
  it('show no journey or stay on the expense, its receipt or its readings, as before', async () => {
    const { call } = setup();
    const expense = await call('GET', `/v1/expenses/${EXPENSE}`);
    expect(expense.status).toBe(200);
    expect(expense.body).not.toHaveProperty('journey');
    expect(expense.body).not.toHaveProperty('stay');
    expect(expense.body.proof).not.toHaveProperty('stay');
    expect(expense.body.proof).not.toHaveProperty('travelDifferences');
    const receipt = await call('GET', `/v1/receipts/${RECEIPT}`);
    expect(receipt.status).toBe(200);
    const [reading] = receipt.body.readings as { fields: Record<string, unknown> }[];
    expect(reading?.fields).not.toHaveProperty('checkIn');
    expect(reading?.fields).not.toHaveProperty('from');
  });

  it('take no correction of a journey or a stay: the feature is off', async () => {
    const { call, edits } = setup();
    const res = await call('PATCH', `/v1/expenses/${EXPENSE}`, { checkOut: '2026-10-02' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('feature_off');
    expect(edits).toEqual([]);
  });
});

describe('journeys and stays, switched on (FR-INT-20, FR-INT-21)', () => {
  it('show the stay on the expense with its nights worked out, beside its receipt’s', async () => {
    const { call } = setup({ flags: ON });
    const res = await call('GET', `/v1/expenses/${EXPENSE}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      journey: { from: null, to: null },
      stay: { checkIn: '2026-09-29', checkOut: '2026-10-01', nights: 2, doubt: null },
      proof: {
        stay: { checkIn: '2026-09-29', checkOut: '2026-10-01', nights: 2 },
        travelDifferences: [],
      },
    });
  });

  it('show a journey as kept, and where it differs from its receipt', async () => {
    const { call } = setup({
      flags: ON,
      travel: { journeyFrom: 'SFO', journeyTo: 'ORD', checkIn: '2026-09-29', checkOut: null },
    });
    const res = await call('GET', `/v1/expenses/${EXPENSE}`);
    expect(res.body).toMatchObject({
      journey: { from: 'SFO', to: 'ORD' },
      stay: { checkIn: '2026-09-29', checkOut: null, nights: null, doubt: null },
      proof: { travelDifferences: ['checkOut'] },
    });
  });

  it('say a stay’s nights aren’t sure rather than show a wrong number', async () => {
    const { call } = setup({
      flags: ON,
      travel: { journeyFrom: null, journeyTo: null, checkIn: '2026-10-01', checkOut: '2026-09-29' },
    });
    const res = await call('GET', `/v1/expenses/${EXPENSE}`);
    expect(res.body.stay).toEqual({
      checkIn: '2026-10-01',
      checkOut: '2026-09-29',
      nights: null,
      doubt: 'check_out_before_check_in',
    });
  });

  it('correct a journey and a stay on the expense, refusing a stay that can’t be', async () => {
    const { call, edits } = setup({ flags: ON });
    const res = await call('PATCH', `/v1/expenses/${EXPENSE}`, {
      journeyTo: 'Hilton Omaha',
      checkOut: '2026-10-02',
    });
    expect(res.status).toBe(200);
    expect(edits).toEqual([{ travel: { journeyTo: 'Hilton Omaha', checkOut: '2026-10-02' } }]);
    expect(res.body).toMatchObject({
      journey: { from: null, to: 'Hilton Omaha' },
      stay: { checkOut: '2026-10-02', nights: 3 },
      proof: { travelDifferences: ['checkOut'] },
    });
    const backwards = await call('PATCH', `/v1/expenses/${EXPENSE}`, { checkOut: '2026-09-01' });
    expect(backwards.status).toBe(422);
    expect(backwards.body).toMatchObject({
      code: 'invalid_value',
      field: 'checkOut',
      detail: 'Check-out is on or after check-in.',
    });
  });

  it('show each model’s journey and stay in the reading table, as read', async () => {
    const { call } = setup({ flags: ON });
    const res = await call('GET', `/v1/receipts/${RECEIPT}`);
    expect(res.status).toBe(200);
    const readings = res.body.readings as { fields: Record<string, unknown> }[];
    expect(readings).toHaveLength(2);
    expect(readings[0]?.fields).toMatchObject({
      documentType: 'hotel_folio',
      from: null,
      to: null,
      checkIn: { value: '2026-09-29', confidence: 'high' },
      checkOut: { value: '2026-10-01', confidence: 'medium' },
    });
  });

  it('file the stay of a reading confirmed with its expense', async () => {
    const { call, confirmed } = setup({ flags: ON, status: 'needs_review' });
    const res = await call('POST', `/v1/receipts/${RECEIPT}/confirm`, {
      model: 'claude-sonnet-5-5',
    });
    expect(res.status).toBe(200);
    expect(confirmed).toEqual([STAY]);
  });
});
