import type {
  CategoryRecord,
  ExpenseClassification,
  ExpenseRecord,
  ExtractionRunRecord,
  Membership,
  MemberChoice,
  ReceiptRecord,
  ReportContents,
  TypeRecord,
} from '@expensewise/db';
import { catalogName, checkChoice } from '@expensewise/domain';
import { FALLBACK_MODEL, type ReceiptExtraction } from '@expensewise/extraction';
import { describe, expect, it } from 'vitest';
import { createApi } from '../src/app.ts';
import type { Identity } from '../src/auth.ts';
import type { CategoryStore, UncodedNeedingYou } from '../src/categories.ts';
import type { ExpenseStore } from '../src/expenses.ts';
import type { HomeStore } from '../src/home.ts';
import type { ReceiptStore } from '../src/receipts.ts';
import type { NeedsYouOptions, ReportStore } from '../src/reports.ts';
import type { WorkspaceStore } from '../src/workspace.ts';

const ORG = '0192f7a0-0000-7000-8000-0000000000a1';
const RILEY = '0192f7a0-0000-7000-8000-0000000000b1';
const SAM = '0192f7a0-0000-7000-8000-0000000000b2';
const FLIGHT = '0192f7a0-0000-7000-8000-0000000000e1';
const COFFEE = '0192f7a0-0000-7000-8000-0000000000e2';
const DINNER = '0192f7a0-0000-7000-8000-0000000000e3';
const RECEIPT = '0192f7a0-0000-7000-8000-0000000000d1';
const NOW = new Date('2026-10-04T12:00:00.000Z');

const id = (n: number) => `0192f7a0-0000-7000-8000-${n.toString().padStart(12, '0')}`;
const TRAVEL = id(1);
const MEALS = id(2);
const AIRFARE = id(11);
const LODGING = id(12);
const MEAL = id(13);
const TAXI = id(14);

const identity = (userId: string): Identity => ({
  userId,
  email: `${userId}@example.com`,
  assuranceLevel: 'aal1',
  sessionId: 's',
  issuedAt: NOW,
});

const reading: ReceiptExtraction = {
  documentType: 'airline_ticket',
  merchant: { name: 'Lufthansa', confidence: 'high' },
  date: { value: '2026-09-28', confidence: 'high' },
  currency: { code: 'EUR', confidence: 'high' },
  total: { value: '412.80', confidence: 'high' },
  subtotal: null,
  fees: [],
  taxes: [],
  tip: null,
  cardLastFour: null,
  time: null,
  address: null,
  lineItems: [],
};

const expense = (over: Partial<ExpenseRecord>): ExpenseRecord => ({
  id: FLIGHT,
  memberId: RILEY,
  owner: 'riley',
  status: 'ready',
  source: 'upload',
  merchant: 'LH 0412 FRA-ORD',
  transactionDate: '2026-09-28',
  currency: 'EUR',
  amountMinor: 41280,
  receiptId: null,
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

const node = (nodeId: string, name: string, over: Partial<TypeRecord> = {}): TypeRecord => ({
  id: nodeId,
  parentId: null,
  name,
  active: true,
  starterKey: null,
  inUse: false,
  ...over,
});

function setup(flagOverrides = 'expenses.categories=on') {
  const receipt: ReceiptRecord = {
    id: RECEIPT,
    memberId: RILEY,
    uploadedBy: 'riley',
    source: 'upload',
    storageKey: `orgs/${ORG}/receipts/${RECEIPT}`,
    contentType: 'application/pdf',
    byteSize: 40_000,
    sha256: 'b'.repeat(64),
    status: 'extracted',
    expenseId: FLIGHT,
    createdAt: NOW,
  };
  const runs: ExtractionRunRecord[] = [
    {
      id: 'run-1',
      receiptId: RECEIPT,
      requestId: 'request-1',
      model: FALLBACK_MODEL,
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
  const expenses: ExpenseRecord[] = [
    expense({ receiptId: RECEIPT }),
    expense({ id: COFFEE, source: 'manual', merchant: 'Blue Bottle Coffee', amountMinor: 650 }),
    expense({ id: DINNER, source: 'manual', merchant: 'Juniper & Rye', status: 'submitted' }),
  ];
  const expenseStore = {
    list: () => Promise.resolve({ expenses, receipts: [receipt], runs, reviews: [] }),
    get: (_org: string, expenseId: string) => {
      const found = expenses.find((e) => e.id === expenseId);
      return Promise.resolve(
        found
          ? { expense: found, proof: found.receiptId ? { receipt, runs, reviews: [] } : null }
          : undefined,
      );
    },
  } as unknown as ExpenseStore;

  const categories: CategoryRecord[] = [
    {
      ...node(TRAVEL, 'Travel', { starterKey: 'travel' }),
      glCode: '6100',
      taxCode: null,
      typeIds: [AIRFARE, LODGING, TAXI],
    },
    {
      ...node(MEALS, 'Meals', { starterKey: 'meals' }),
      glCode: null,
      taxCode: null,
      typeIds: [MEAL],
    },
  ];
  const types: TypeRecord[] = [
    node(AIRFARE, 'Airfare', { starterKey: 'airfare' }),
    node(LODGING, 'Lodging', { starterKey: 'lodging' }),
    node(MEAL, 'Business meal', { starterKey: 'business_meal' }),
    node(TAXI, 'Taxi', { parentId: LODGING }),
  ];
  const chosen: ExpenseClassification[] = [];
  const history: MemberChoice[] = [];
  const saved: unknown[] = [];
  let next = 100;
  const catalogStore: CategoryStore = {
    catalog: () => Promise.resolve({ categories, types }),
    saveCategory: (_org, categoryId, change) => {
      if (change.name !== undefined && catalogName(change.name) === null) {
        return Promise.resolve({ status: 'invalid', problem: 'invalid_name', field: 'name' });
      }
      saved.push(change);
      const i = categoryId === null ? -1 : categories.findIndex((c) => c.id === categoryId);
      if (categoryId !== null && i === -1) return Promise.resolve({ status: 'missing' });
      const before = i === -1 ? undefined : categories[i];
      const record: CategoryRecord = {
        ...(before ?? { ...node(id(next++), ''), glCode: null, taxCode: null, typeIds: [] }),
        ...Object.fromEntries(Object.entries(change).filter(([, v]) => v !== undefined)),
      };
      if (i === -1) categories.push(record);
      else categories[i] = record;
      return Promise.resolve({ status: 'saved', record });
    },
    saveType: (_org, typeId, change) => {
      saved.push(change);
      const i = typeId === null ? -1 : types.findIndex((t) => t.id === typeId);
      if (typeId !== null && i === -1) return Promise.resolve({ status: 'missing' });
      const record: TypeRecord = { ...(types[i] ?? node(id(next++), '')), ...change };
      if (i === -1) types.push(record);
      else types[i] = record;
      return Promise.resolve({ status: 'saved', record });
    },
    deleteCategory: (_org, categoryId) =>
      Promise.resolve(
        categoryId === TRAVEL ? 'in_use' : categoryId === MEALS ? 'has_children' : 'missing',
      ),
    deleteType: (_org, typeId) => {
      const i = types.findIndex((t) => t.id === typeId);
      if (i === -1) return Promise.resolve('missing');
      types.splice(i, 1);
      return Promise.resolve('deleted');
    },
    classify: (_org, expenseId, choice) => {
      const found = expenses.find((e) => e.id === expenseId);
      if (!found) return Promise.resolve({ status: 'missing' });
      if (found.status === 'submitted') {
        return Promise.resolve({ status: 'not_editable', current: found.status });
      }
      const checked = checkChoice({ categories, types }, choice.categoryId, choice.typeId);
      if (!checked.ok) return Promise.resolve({ status: 'invalid', problem: checked.error });
      chosen.push({ expenseId, ...choice, classifiedAt: NOW });
      return Promise.resolve({ status: 'classified' });
    },
    classifying: () => Promise.resolve({ catalog: { categories, types }, chosen, history }),
  };

  const memberships: Record<string, Membership> = {
    riley: { orgId: ORG, memberId: RILEY, role: 'owner' },
    sam: { orgId: ORG, memberId: SAM, role: 'member' },
  };
  const api = createApi({
    version: 't',
    verifyToken: (token) => Promise.resolve(identity(token)),
    workspace: {
      findMembership: (userId: string) => Promise.resolve(memberships[userId]),
      featureOn: () => Promise.resolve(false),
    } as unknown as WorkspaceStore,
    expenses: expenseStore,
    categories: catalogStore,
    flagOverrides,
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
    return {
      status: res.status,
      body: (await res.json().catch(() => null)) as Record<string, unknown>,
    };
  };
  return { call, chosen, history, saved, types };
}

describe('categories and types (FR-EXP-11, Q7)', () => {
  it('lists both trees in order, with the types each category allows, for everyone', async () => {
    const { call } = setup();
    const res = await call('GET', '/v1/categories', 'sam');
    expect(res.status).toBe(200);
    expect(res.body.canManage).toBe(false);
    expect(res.body.categories).toEqual([
      expect.objectContaining({ name: 'Meals', depth: 0, typeIds: [MEAL] }),
      expect.objectContaining({ name: 'Travel', depth: 0, glCode: '6100' }),
    ]);
    expect(
      (res.body.types as { name: string; depth: number }[]).map((t) => [t.name, t.depth]),
    ).toEqual([
      ['Airfare', 0],
      ['Business meal', 0],
      ['Lodging', 0],
      ['Taxi', 1],
    ]);
    expect((await call('GET', '/v1/categories', 'riley')).body.canManage).toBe(true);
  });

  it('lets only owners and finance admins add, change, retire or delete them', async () => {
    const { call, saved } = setup();
    for (const [method, path] of [
      ['POST', '/v1/settings/categories'],
      ['PATCH', `/v1/settings/categories/${TRAVEL}`],
      ['DELETE', `/v1/settings/categories/${TRAVEL}`],
      ['POST', '/v1/settings/expense-types'],
      ['PATCH', `/v1/settings/expense-types/${AIRFARE}`],
      ['DELETE', `/v1/settings/expense-types/${AIRFARE}`],
    ] as const) {
      const res = await call(method, path, 'sam', method === 'DELETE' ? undefined : { name: 'X' });
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(res.body.code).toBe('forbidden_role');
    }
    expect(saved).toEqual([]);

    const created = await call('POST', '/v1/settings/categories', 'riley', {
      name: 'Client costs',
      parentId: TRAVEL,
      glCode: '6150',
      typeIds: [MEAL],
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name: 'Client costs', depth: 1, typeIds: [MEAL] });
    const retired = await call('PATCH', `/v1/settings/categories/${MEALS}`, 'riley', {
      active: false,
    });
    expect(retired).toMatchObject({ status: 200, body: { id: MEALS, active: false } });
    const type = await call('POST', '/v1/settings/expense-types', 'riley', {
      name: 'Rail',
      parentId: null,
    });
    expect(type).toMatchObject({ status: 201, body: { name: 'Rail', depth: 0, active: true } });
    expect(
      await call('PATCH', `/v1/settings/expense-types/${AIRFARE}`, 'riley', { name: 'Flights' }),
    ).toMatchObject({ status: 200, body: { name: 'Flights' } });
    expect((await call('DELETE', `/v1/settings/expense-types/${TAXI}`, 'riley')).status).toBe(204);
  });

  it('says what is wrong with a change, and refuses to delete one in use', async () => {
    const { call } = setup();
    const blank = await call('POST', '/v1/settings/categories', 'riley', { name: '  ' });
    expect(blank).toMatchObject({ status: 422, body: { code: 'invalid_name', field: 'name' } });
    const inUse = await call('DELETE', `/v1/settings/categories/${TRAVEL}`, 'riley');
    expect(inUse).toMatchObject({ status: 409, body: { code: 'in_use' } });
    const parent = await call('DELETE', `/v1/settings/categories/${MEALS}`, 'riley');
    expect(parent).toMatchObject({ status: 409, body: { code: 'has_children' } });
    expect((await call('DELETE', `/v1/settings/categories/${id(999)}`, 'riley')).status).toBe(404);
    expect((await call('DELETE', `/v1/settings/expense-types/${id(999)}`, 'riley')).status).toBe(
      404,
    );
    expect(
      (await call('PATCH', `/v1/settings/expense-types/${id(999)}`, 'riley', { name: 'X' })).status,
    ).toBe(404);
  });
});

describe('a category and type on each expense (FR-EXP-11, FR-INT-10)', () => {
  it('suggests one from what the expense shows, marked as a suggestion, or says it has none', async () => {
    const { call } = setup();
    const list = await call('GET', '/v1/expenses', 'riley');
    expect(list.status).toBe(200);
    const shown = Object.fromEntries(
      (list.body.expenses as { id: string; category: unknown }[]).map((e) => [e.id, e.category]),
    );
    // Its receipt was read as an airline ticket, whatever the merchant says.
    expect(shown[FLIGHT]).toEqual({
      state: 'suggested',
      category: { id: TRAVEL, name: 'Travel', active: true },
      type: { id: AIRFARE, name: 'Airfare', active: true },
      basis: 'keywords',
    });
    expect(shown[COFFEE]).toMatchObject({
      state: 'suggested',
      type: { name: 'Business meal' },
    });
    expect(shown[DINNER]).toEqual({ state: 'missing', category: null, type: null, basis: null });
  });

  it('suggests what its owner last chose for the same merchant first', async () => {
    const { call, history } = setup();
    history.push({ memberId: SAM, merchant: 'Blue Bottle', categoryId: TRAVEL, typeId: LODGING });
    history.push({ memberId: RILEY, merchant: 'Blue Bottle', categoryId: TRAVEL, typeId: TAXI });
    const res = await call('GET', `/v1/expenses/${COFFEE}`, 'riley');
    expect(res.body.category).toMatchObject({
      state: 'suggested',
      type: { id: TAXI },
      basis: 'history',
    });
  });

  it('takes a type its category allows, confirmed from then on', async () => {
    const { call, chosen } = setup();
    const wrong = await call('PUT', `/v1/expenses/${COFFEE}/category`, 'riley', {
      categoryId: MEALS,
      typeId: AIRFARE,
    });
    expect(wrong).toMatchObject({
      status: 422,
      body: { code: 'type_not_allowed', field: 'typeId' },
    });
    const missing = await call('PUT', `/v1/expenses/${COFFEE}/category`, 'riley', {
      categoryId: id(999),
      typeId: AIRFARE,
    });
    expect(missing.body).toMatchObject({ code: 'no_such_category', field: 'categoryId' });

    const res = await call('PUT', `/v1/expenses/${COFFEE}/category`, 'riley', {
      categoryId: MEALS,
      typeId: MEAL,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: COFFEE,
      merchant: 'Blue Bottle Coffee',
      category: {
        state: 'confirmed',
        category: { id: MEALS, name: 'Meals' },
        type: { id: MEAL, name: 'Business meal' },
        basis: null,
      },
    });
    expect(chosen).toHaveLength(1);
  });

  it('leaves a submitted expense as it went in', async () => {
    const { call } = setup();
    const res = await call('PUT', `/v1/expenses/${DINNER}/category`, 'riley', {
      categoryId: MEALS,
      typeId: MEAL,
    });
    expect(res).toMatchObject({ status: 409, body: { code: 'locked' } });
    expect(
      (
        await call('PUT', `/v1/expenses/${id(999)}/category`, 'riley', {
          categoryId: MEALS,
          typeId: MEAL,
        })
      ).status,
    ).toBe(404);
  });

  it('keeps a retired type on the expense that has it, marked retired', async () => {
    const { call, types } = setup();
    await call('PUT', `/v1/expenses/${COFFEE}/category`, 'riley', {
      categoryId: MEALS,
      typeId: MEAL,
    });
    types[2] = { ...types[2]!, active: false };
    const res = await call('GET', `/v1/expenses/${COFFEE}`, 'riley');
    expect(res.body.category).toMatchObject({
      state: 'confirmed',
      type: { id: MEAL, active: false },
    });
  });
});

describe('with categories switched off (Q5, ADR-0032)', () => {
  it('answers 404 feature_off on every route, and shows expenses as before', async () => {
    const { call, saved, chosen } = setup('');
    for (const [method, path] of [
      ['GET', '/v1/categories'],
      ['POST', '/v1/settings/categories'],
      ['PATCH', `/v1/settings/categories/${TRAVEL}`],
      ['DELETE', `/v1/settings/categories/${TRAVEL}`],
      ['POST', '/v1/settings/expense-types'],
      ['PATCH', `/v1/settings/expense-types/${AIRFARE}`],
      ['DELETE', `/v1/settings/expense-types/${AIRFARE}`],
      ['PUT', `/v1/expenses/${COFFEE}/category`],
    ] as const) {
      const res = await call(
        method,
        path,
        'riley',
        method === 'GET' || method === 'DELETE'
          ? undefined
          : { name: 'X', categoryId: MEALS, typeId: MEAL },
      );
      expect(res.status, `${method} ${path}`).toBe(404);
      expect(res.body.code).toBe('feature_off');
    }
    expect(saved).toEqual([]);
    expect(chosen).toEqual([]);

    const list = await call('GET', '/v1/expenses', 'riley');
    expect((list.body.expenses as object[]).every((e) => !('category' in e))).toBe(true);
    const one = await call('GET', `/v1/expenses/${COFFEE}`, 'riley');
    expect(one.status).toBe(200);
    expect(one.body).not.toHaveProperty('category');
  });
});

/**
 * Needs you with the member's expenses that have no category and type (Q27): the flight, read
 * as an airline ticket, and a dinner nothing suggests anything for; beside a local coffee with
 * no reason yet and a report ready to close.
 */
function needsYouSetup(flagOverrides = 'expenses.categories=on') {
  const REPORT = id(30);
  const receipt: ReceiptRecord = {
    id: RECEIPT,
    memberId: RILEY,
    uploadedBy: 'riley',
    source: 'upload',
    storageKey: `orgs/${ORG}/receipts/${RECEIPT}`,
    contentType: 'application/pdf',
    byteSize: 40_000,
    sha256: 'b'.repeat(64),
    status: 'extracted',
    expenseId: FLIGHT,
    createdAt: NOW,
  };
  const runs: ExtractionRunRecord[] = [
    {
      id: 'run-1',
      receiptId: RECEIPT,
      requestId: 'request-1',
      model: FALLBACK_MODEL,
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
  const catalog = {
    categories: [
      {
        ...node(TRAVEL, 'Travel', { starterKey: 'travel' }),
        glCode: null,
        taxCode: null,
        typeIds: [AIRFARE],
      },
    ],
    types: [node(AIRFARE, 'Airfare', { starterKey: 'airfare' })],
  };
  const uncoded: UncodedNeedingYou = {
    expenses: [
      expense({ receiptId: RECEIPT }),
      expense({
        id: DINNER,
        source: 'manual',
        merchant: 'Juniper & Rye',
        transactionDate: '2026-09-30',
        currency: 'USD',
        amountMinor: 8640,
        tripId: id(40),
      }),
    ],
    receipts: [receipt],
    runs,
    reviews: [],
    classifying: { catalog, chosen: [], history: [] },
  };
  const coffee = expense({
    id: COFFEE,
    source: 'manual',
    merchant: 'Blue Bottle Coffee',
    currency: 'USD',
    amountMinor: 650,
  });
  const ready: ReportContents = {
    report: {
      id: REPORT,
      memberId: RILEY,
      owner: 'riley',
      title: 'Report from 3 Oct 2026',
      status: 'open',
      currency: 'USD',
      closesAt: new Date('2026-10-31T12:00:00.000Z'),
      closedAt: null,
      submittedAt: null,
      createdAt: new Date('2026-10-03T12:00:00.000Z'),
    },
    trips: [],
    tallies: [],
    counts: [],
    locals: [
      { ...coffee, id: id(31), justification: 'Client coffee', reportId: REPORT, held: false },
    ],
  };
  const asked: (NeedsYouOptions | undefined)[] = [];
  const answer = (options?: NeedsYouOptions) => {
    asked.push(options);
    return { reports: [ready], unjustified: [coffee], ...(options?.uncoded ? { uncoded } : {}) };
  };
  const reports = {
    needsYou: (_org: string, _member: string, _limit: number, options?: NeedsYouOptions) =>
      Promise.resolve(answer(options)),
  } as unknown as ReportStore;
  const home: HomeStore = {
    snapshot: (_org, _member, _day, _limit, options) =>
      Promise.resolve({
        home: {
          tripNow: null,
          tripNext: null,
          recentTrips: [],
          tallies: [],
          month: { from: '2026-10-01', until: '2026-11-01' },
          monthExpenses: [],
          monthTrips: 0,
          reading: 0,
        },
        receipts: [],
        runs: [],
        reviews: [],
        pairs: [],
        reports: answer(options),
      }),
  };
  const api = createApi({
    version: 't',
    verifyToken: (token) => Promise.resolve(identity(token)),
    workspace: {
      findMembership: () => Promise.resolve({ orgId: ORG, memberId: RILEY, role: 'owner' }),
      featureOn: () => Promise.resolve(false),
    } as unknown as WorkspaceStore,
    receipts: {
      list: () => Promise.resolve({ receipts: [], runs: [], reviews: [], pairs: [] }),
    } as unknown as ReceiptStore,
    reports,
    home,
    // Only its presence matters here: Needs you reads the expenses through the reports.
    categories: {} as CategoryStore,
    flagOverrides,
    now: () => NOW,
  });
  const call = async (path: string) => {
    const res = await api.request(path, { headers: { authorization: 'Bearer riley' } });
    return {
      status: res.status,
      body: (await res.json()) as {
        items?: InboxItem[];
        needsYou?: { count: number; items: InboxItem[] };
      },
    };
  };
  return { call, asked };
}

type InboxItem = {
  kind: string;
  reason: { code: string };
  expense?: { id: string };
  category?: unknown;
};

describe('an expense without a category and type in Needs you (Q27)', () => {
  it('asks for each of the member’s own, with its suggestion, after reasons and before reports to close', async () => {
    const { call, asked } = needsYouSetup();
    const { status, body } = await call('/v1/inbox');
    expect(status).toBe(200);
    expect(asked).toEqual([{ uncoded: true }]);
    expect(body.items?.map((i) => [i.kind, i.reason.code, i.expense?.id])).toEqual([
      ['expense', 'justification', COFFEE],
      ['expense', 'uncoded', FLIGHT],
      ['expense', 'uncoded', DINNER],
      ['report', 'ready_to_close', undefined],
    ]);
    const [, flight, dinner] = body.items ?? [];
    expect(flight).toEqual({
      kind: 'expense',
      expense: {
        id: FLIGHT,
        merchant: 'LH 0412 FRA-ORD',
        date: '2026-09-28',
        amount: { amountMinor: 41280, currency: 'EUR', decimal: '412.80' },
        receiptId: RECEIPT,
      },
      reason: { code: 'uncoded' },
      // Its receipt was read as an airline ticket.
      category: {
        state: 'suggested',
        category: { id: TRAVEL, name: 'Travel', active: true },
        type: { id: AIRFARE, name: 'Airfare', active: true },
        basis: 'keywords',
      },
    });
    expect(dinner?.category).toEqual({ state: 'missing', category: null, type: null, basis: null });
  });

  it('counts them on Home, as the inbox lists them', async () => {
    const { call } = needsYouSetup();
    const { status, body } = await call('/v1/home?day=2026-10-04');
    expect(status).toBe(200);
    expect(body.needsYou?.count).toBe(4);
    expect(body.needsYou?.items.map((i) => i.reason.code)).toEqual([
      'justification',
      'uncoded',
      'uncoded',
    ]);
  });

  it.each(['expenses.categories=off', ''])(
    'leaves Needs you as it was when categories are off (%s)',
    async (flags) => {
      const { call, asked } = needsYouSetup(flags);
      const inbox = await call('/v1/inbox');
      expect(inbox.body.items?.map((i) => i.reason.code)).toEqual([
        'justification',
        'ready_to_close',
      ]);
      expect(inbox.body.items?.every((i) => !('category' in i))).toBe(true);
      const home = await call('/v1/home?day=2026-10-04');
      expect(home.body.needsYou?.count).toBe(2);
      expect(asked).toEqual([{ uncoded: false }, { uncoded: false }]);
    },
  );
});
