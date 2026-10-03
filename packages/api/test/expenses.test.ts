import type {
  ExpenseRecord,
  ExtractionRunRecord,
  Membership,
  ReceiptRecord,
  ReceiptReviewRecord,
} from '@expensewise/db';
import { applyExpenseEdit } from '@expensewise/domain';
import type { ReceiptExtraction } from '@expensewise/extraction';
import { describe, expect, it } from 'vitest';
import { createApi } from '../src/app.ts';
import type { Identity } from '../src/auth.ts';
import type { ExpenseStore } from '../src/expenses.ts';
import type { WorkspaceStore } from '../src/workspace.ts';

const ORG = '0192f7a0-0000-7000-8000-0000000000a1';
const MEMBER = '0192f7a0-0000-7000-8000-0000000000b1';
const RECEIPT = '0192f7a0-0000-7000-8000-0000000000d1';
const EXPENSE = '0192f7a0-0000-7000-8000-0000000000e1';
const TYPED = '0192f7a0-0000-7000-8000-0000000000e2';
const REQUEST = '0192f7a0-0000-7000-8000-0000000000f1';
const NOW = new Date('2026-10-03T12:00:00.000Z');

const identity = (userId: string): Identity => ({
  userId,
  email: `${userId}@example.com`,
  assuranceLevel: 'aal1',
  sessionId: 's',
  issuedAt: NOW,
});

const reading: ReceiptExtraction = {
  documentType: 'receipt',
  merchant: { name: 'Blue Bottle Coffee', confidence: 'high' },
  date: { value: '2026-09-24', confidence: 'high' },
  currency: { code: 'USD', confidence: 'high' },
  total: { value: '7.25', confidence: 'high' },
  subtotal: null,
  taxes: [],
  tip: null,
  cardLastFour: null,
  lineItems: [],
};

function setup() {
  const receipt: ReceiptRecord = {
    id: RECEIPT,
    memberId: MEMBER,
    uploadedBy: 'riley',
    source: 'camera',
    storageKey: `orgs/${ORG}/receipts/${RECEIPT}`,
    contentType: 'image/jpeg',
    byteSize: 400_000,
    sha256: 'a'.repeat(64),
    status: 'needs_review',
    expenseId: EXPENSE,
    createdAt: NOW,
  };
  const runs: ExtractionRunRecord[] = [
    {
      id: 'run-1',
      receiptId: RECEIPT,
      requestId: REQUEST,
      model: 'gpt-5.6-luna',
      promptVersion: 'extract-v1',
      outcome: 'confident',
      output: reading,
      error: null,
      latencyMs: 2500,
      inputTokens: 2000,
      outputTokens: 400,
      costMicroUsd: 880,
      createdAt: NOW,
    },
  ];
  const reviews: ReceiptReviewRecord[] = [];
  const expense = (over: Partial<ExpenseRecord>): ExpenseRecord => ({
    id: EXPENSE,
    memberId: MEMBER,
    owner: 'riley',
    status: 'needs_review',
    source: 'camera',
    merchant: 'Blue Bottle Coffee',
    transactionDate: '2026-09-24',
    currency: 'USD',
    amountMinor: 725,
    receiptId: RECEIPT,
    editedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  });
  const expenses: ExpenseRecord[] = [
    expense({}),
    expense({
      id: TYPED,
      source: 'manual',
      status: 'ready',
      merchant: 'Parking',
      amountMinor: 1200,
      receiptId: null,
    }),
  ];
  const store: ExpenseStore = {
    list: () => Promise.resolve({ expenses, receipts: [receipt], runs, reviews }),
    get: (_org, id) => {
      const found = expenses.find((e) => e.id === id);
      return Promise.resolve(
        found
          ? { expense: found, proof: found.receiptId ? { receipt, runs, reviews } : null }
          : undefined,
      );
    },
    edit: (_org, id, edit) => {
      const i = expenses.findIndex((e) => e.id === id);
      if (i === -1) return Promise.resolve({ status: 'missing' });
      const current = expenses[i]!;
      if (current.status !== 'needs_review' && current.status !== 'ready') {
        return Promise.resolve({ status: 'not_editable', current: current.status });
      }
      const result = applyExpenseEdit(current, edit);
      if (!result.ok) return Promise.resolve({ status: 'invalid', problem: result.error });
      if (result.value.changes.length === 0) return Promise.resolve({ status: 'unchanged' });
      expenses[i] = { ...current, ...result.value.values, editedAt: NOW };
      return Promise.resolve({ status: 'edited', changes: result.value.changes });
    },
  };
  const memberships: Record<string, Membership> = {
    riley: { orgId: ORG, memberId: MEMBER, role: 'owner' },
  };
  const api = createApi({
    version: 't',
    verifyToken: (token) => Promise.resolve(identity(token)),
    workspace: {
      findMembership: (userId: string) => Promise.resolve(memberships[userId]),
    } as unknown as WorkspaceStore,
    expenses: store,
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
  return { call, expenses, receipt, reviews };
}

describe('expenses', () => {
  it('lists each expense with whether it matches its receipt', async () => {
    const { call } = setup();
    const res = await call('GET', '/v1/expenses', 'riley');
    expect(res.status).toBe(200);
    expect(res.body.expenses).toEqual([
      expect.objectContaining({
        id: EXPENSE,
        status: 'needs_review',
        owner: 'riley',
        merchant: 'Blue Bottle Coffee',
        amount: { amountMinor: 725, currency: 'USD', decimal: '7.25' },
        receiptId: RECEIPT,
        matchesReceipt: true,
      }),
      expect.objectContaining({ id: TYPED, receiptId: null, matchesReceipt: null }),
    ]);
  });

  it('shows what its receipt shows, as its proof', async () => {
    const { call, reviews } = setup();
    const res = await call('GET', `/v1/expenses/${EXPENSE}`, 'riley');
    expect(res.body).toMatchObject({
      editable: true,
      editedAt: null,
      proof: {
        receiptId: RECEIPT,
        status: 'needs_review',
        confirmedBy: null,
        merchant: 'Blue Bottle Coffee',
        date: '2026-09-24',
        amount: { decimal: '7.25' },
        differences: [],
      },
    });
    expect((await call('GET', `/v1/expenses/${TYPED}`, 'riley')).body.proof).toBeNull();
    expect(reviews).toEqual([]);
  });

  it('edits an expense and shows where it now differs from its receipt', async () => {
    const { call } = setup();
    const res = await call('PATCH', `/v1/expenses/${EXPENSE}`, 'riley', { amount: '7.75' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      amount: { amountMinor: 775, decimal: '7.75' },
      matchesReceipt: false,
      editedAt: NOW.toISOString(),
      proof: { amount: { decimal: '7.25' }, differences: ['amount'] },
    });
    // Editing changes the claim, never the proof.
    const list = await call('GET', '/v1/expenses', 'riley');
    expect((list.body.expenses as { matchesReceipt: boolean }[])[0]!.matchesReceipt).toBe(false);
  });

  it('names the field that is not valid', async () => {
    const { call } = setup();
    expect(
      await call('PATCH', `/v1/expenses/${EXPENSE}`, 'riley', { date: '2026-13-01' }),
    ).toMatchObject({ status: 422, body: { code: 'invalid_value', field: 'date' } });
    expect((await call('PATCH', `/v1/expenses/${EXPENSE}`, 'riley', {})).status).toBe(400);
    expect(
      (await call('PATCH', `/v1/expenses/${EXPENSE}`, 'riley', { category: 'Meals' })).status,
    ).toBe(400);
  });

  it('refuses an edit while the receipt is read, or once submitted', async () => {
    const { call, expenses } = setup();
    expenses[0] = { ...expenses[0]!, status: 'processing' };
    expect(
      await call('PATCH', `/v1/expenses/${EXPENSE}`, 'riley', { amount: '1.00' }),
    ).toMatchObject({ status: 409, body: { code: 'being_read' } });
    expenses[0] = { ...expenses[0], status: 'submitted' };
    expect(
      await call('PATCH', `/v1/expenses/${EXPENSE}`, 'riley', { amount: '1.00' }),
    ).toMatchObject({ status: 409, body: { code: 'locked' } });
    expect((await call('GET', `/v1/expenses/${EXPENSE}`, 'riley')).body.editable).toBe(false);
  });

  it('answers 404 for an expense it does not have, and needs a signed-in member', async () => {
    const { call } = setup();
    const missing = '0192f7a0-0000-7000-8000-0000000000e9';
    expect((await call('GET', `/v1/expenses/${missing}`, 'riley')).status).toBe(404);
    expect((await call('PATCH', `/v1/expenses/${missing}`, 'riley', { amount: '1' })).status).toBe(
      404,
    );
    expect((await call('GET', '/v1/expenses')).status).toBe(401);
    expect((await call('GET', '/v1/expenses', 'mallory')).status).toBe(403);
  });
});
