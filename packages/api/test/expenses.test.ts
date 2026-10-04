import type {
  ExpenseFilter,
  ExpenseRecord,
  ExtractionRunRecord,
  Membership,
  ReceiptRecord,
  ReceiptReviewRecord,
} from '@expensewise/db';
import { applyDetailsEdit, applyExpenseEdit } from '@expensewise/domain';
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
const TRIP = '0192f7a0-0000-7000-8000-0000000000c1';
const THEIR_TRIP = '0192f7a0-0000-7000-8000-0000000000c2';
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
  fees: [],
  taxes: [],
  tip: null,
  cardLastFour: null,
  time: null,
  address: null,
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
    tripId: null,
    tripName: null,
    tripPinned: false,
    time: null,
    timeZone: null,
    address: null,
    city: null,
    region: null,
    country: null,
    reportId: null,
    tripReportId: null,
    justification: null,
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
  const filters: ExpenseFilter[] = [];
  const edits: Parameters<ExpenseStore['edit']>[2][] = [];
  const trips: Record<string, { name: string; memberId: string }> = {
    [TRIP]: { name: 'Houston · Acme onsite', memberId: MEMBER },
    [THEIR_TRIP]: { name: 'Denver', memberId: 'someone-else' },
  };
  const store: ExpenseStore = {
    list: (_org, _limit, filter = {}) => {
      filters.push(filter);
      return Promise.resolve({ expenses, receipts: [receipt], runs, reviews });
    },
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
      const { details: detailsEdit, ...valuesEdit } = edit;
      const result = applyExpenseEdit(current, valuesEdit);
      if (!result.ok) return Promise.resolve({ status: 'invalid', problem: result.error });
      const placed = applyDetailsEdit(current, detailsEdit ?? {});
      if (!placed.ok) return Promise.resolve({ status: 'invalid', problem: placed.error });
      const { changes } = result.value;
      const detailChanges = placed.value.changes;
      if (changes.length === 0 && detailChanges.length === 0) {
        return Promise.resolve({ status: 'unchanged' });
      }
      edits.push(edit);
      expenses[i] = { ...current, ...result.value.values, ...placed.value.details, editedAt: NOW };
      return Promise.resolve({ status: 'edited', changes, detailChanges });
    },
    setTrip: (_org, id, choice) => {
      const i = expenses.findIndex((e) => e.id === id);
      if (i === -1) return Promise.resolve({ status: 'missing' });
      const current = expenses[i]!;
      if (['submitted', 'approved', 'settled'].includes(current.status)) {
        return Promise.resolve({ status: 'not_movable', current: current.status });
      }
      // The fake's trips cover no expense's date, so filing by date puts it on none.
      const tripId = 'byDate' in choice ? null : choice.tripId;
      const trip = tripId === null ? null : trips[tripId];
      if (trip === undefined) return Promise.resolve({ status: 'no_such_trip' });
      if (trip && trip.memberId !== current.memberId) {
        return Promise.resolve({ status: 'other_member' });
      }
      const pinned = !('byDate' in choice);
      expenses[i] = { ...current, tripId, tripName: trip?.name ?? null, tripPinned: pinned };
      return Promise.resolve({ status: 'set', tripId, pinned });
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
  return { call, expenses, receipt, reviews, filters, edits };
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
        trip: null,
        tripFiledBy: 'date',
        matchesReceipt: true,
      }),
      expect.objectContaining({ id: TYPED, receiptId: null, matchesReceipt: null }),
    ]);
  });

  it('searches by merchant, dates, amount in any currency, and trip (FR-INS-02)', async () => {
    const { call, filters } = setup();
    const res = await call(
      'GET',
      `/v1/expenses?q=bottle&from=2026-09-01&to=2026-09-30&amount=18.92&tripId=${TRIP}`,
      'riley',
    );
    expect(res.status).toBe(200);
    expect(filters.at(-1)).toMatchObject({
      q: 'bottle',
      from: '2026-09-01',
      to: '2026-09-30',
      tripId: TRIP,
    });
    const amounts = filters.at(-1)!.amounts!;
    expect(amounts.find((m) => m.currencies.includes('USD'))?.amountMinor).toBe(1892);
    expect(amounts.find((m) => m.currencies.includes('KWD'))?.amountMinor).toBe(18920);
    expect(amounts.some((m) => m.currencies.includes('JPY'))).toBe(false);

    await call('GET', '/v1/expenses', 'riley');
    expect(filters.at(-1)).toEqual({ amounts: undefined });
  });

  it('finds the expenses on no trip, or on some trip (Home’s figures open them)', async () => {
    const { call, filters } = setup();
    await call('GET', '/v1/expenses?onTrip=no&from=2026-10-01&to=2026-10-31', 'riley');
    expect(filters.at(-1)).toMatchObject({ onTrip: false, from: '2026-10-01' });
    await call('GET', '/v1/expenses?onTrip=yes', 'riley');
    expect(filters.at(-1)).toMatchObject({ onTrip: true });
  });

  it.each([
    'amount=1,000',
    'amount=-5',
    'amount=12.3456',
    'from=2026-02-30',
    'to=yesterday',
    'tripId=houston',
    'onTrip=maybe',
  ])('refuses the search %s', async (query) => {
    const { call } = setup();
    expect(await call('GET', `/v1/expenses?${query}`, 'riley')).toMatchObject({
      status: 400,
      body: { code: 'invalid_request' },
    });
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

  it('edits when and where it was bought, working out the time zone from the place', async () => {
    const { call, edits } = setup();
    const res = await call('PATCH', `/v1/expenses/${EXPENSE}`, 'riley', {
      time: '6:42',
      city: 'Omaha',
      region: 'NE',
      country: 'us',
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      time: '06:42',
      timeZone: 'America/Chicago',
      city: 'Omaha',
      region: 'NE',
      country: 'US',
      editedAt: NOW.toISOString(),
    });
    expect(edits.at(-1)).toEqual({
      details: {
        time: '6:42',
        city: 'Omaha',
        region: 'NE',
        country: 'us',
        timeZone: 'America/Chicago',
      },
    });

    // A time zone the person sets stays; a place that pins no zone clears it (the US has many).
    const set = await call('PATCH', `/v1/expenses/${EXPENSE}`, 'riley', {
      city: 'Denver',
      timeZone: 'America/Denver',
    });
    expect(set.body).toMatchObject({ city: 'Denver', timeZone: 'America/Denver' });
    const unknown = await call('PATCH', `/v1/expenses/${EXPENSE}`, 'riley', {
      city: 'Nowhereville',
      region: '',
    });
    expect(unknown.body).toMatchObject({ city: 'Nowhereville', region: null, timeZone: null });
    // A blank time zone asks for it from the place again.
    const fromPlace = await call('PATCH', `/v1/expenses/${EXPENSE}`, 'riley', {
      region: 'CO',
      timeZone: 'America/New_York',
    });
    expect(fromPlace.body).toMatchObject({ timeZone: 'America/New_York' });
    expect(
      (await call('PATCH', `/v1/expenses/${EXPENSE}`, 'riley', { timeZone: ' ' })).body,
    ).toMatchObject({ city: 'Nowhereville', region: 'CO', timeZone: 'America/Denver' });
    expect(
      await call('PATCH', `/v1/expenses/${EXPENSE}`, 'riley', { time: '25:00' }),
    ).toMatchObject({ status: 422, body: { code: 'invalid_value', field: 'time' } });
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

  it('puts an expense on a trip a person chose, on none, or back to filing by date', async () => {
    const { call } = setup();
    const put = (body: unknown) => call('PUT', `/v1/expenses/${EXPENSE}/trip`, 'riley', body);
    expect(await put({ tripId: TRIP })).toMatchObject({
      status: 200,
      body: {
        id: EXPENSE,
        trip: { id: TRIP, name: 'Houston · Acme onsite' },
        tripFiledBy: 'person',
      },
    });
    expect((await put({ tripId: null })).body).toMatchObject({ trip: null, tripFiledBy: 'person' });
    expect((await put({ byDate: true })).body).toMatchObject({ trip: null, tripFiledBy: 'date' });
  });

  it('refuses another member’s trip, a trip that doesn’t exist, and a submitted expense', async () => {
    const { call, expenses } = setup();
    const put = (body: unknown) => call('PUT', `/v1/expenses/${EXPENSE}/trip`, 'riley', body);
    expect(await put({ tripId: THEIR_TRIP })).toMatchObject({
      status: 422,
      body: { code: 'other_members_trip', field: 'tripId' },
    });
    expect(await put({ tripId: '0192f7a0-0000-7000-8000-0000000000c9' })).toMatchObject({
      status: 422,
      body: { code: 'no_such_trip' },
    });
    for (const body of [{}, { byDate: false }, { tripId: TRIP, byDate: true }, { tripId: 'x' }]) {
      expect((await put(body)).status).toBe(400);
    }
    expenses[0] = { ...expenses[0]!, status: 'submitted' };
    expect(await put({ tripId: TRIP })).toMatchObject({ status: 409, body: { code: 'locked' } });
    const missing = '0192f7a0-0000-7000-8000-0000000000e9';
    expect(
      (await call('PUT', `/v1/expenses/${missing}/trip`, 'riley', { tripId: null })).status,
    ).toBe(404);
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
