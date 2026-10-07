/**
 * A receipt's itemized lines, excluding a line and splitting an expense, by API on a real
 * database as expensewise_app (FR-INT-22, FR-EXP-15, FR-EXP-16, ADR-0041). Run with
 * `pnpm test:integration`.
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  createDatabase,
  expenseConversions,
  recordExtractionRun,
  settleReceipt,
  withOrg,
} from '@expensewise/db';
import { money, newId, type Itemization, type LineKind } from '@expensewise/domain';
import { COMPARISON_MODELS } from '@expensewise/extraction';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createApi } from '../src/app.ts';
import { dbCategoryStore } from '../src/categories.ts';
import { dbExpenseStore } from '../src/expenses.ts';
import { dbItemizedStore } from '../src/itemized.ts';
import { dbPeopleStore } from '../src/people.ts';
import { dbReceiptStore } from '../src/receipts.ts';
import { dbReportStore } from '../src/reports.ts';
import { dbWorkspaceStore } from '../src/workspace.ts';

const { db, pool } = createDatabase(inject('appUrl'));
afterAll(async () => {
  await pool.end();
});

const files = {
  signedUpload: (path: string) => Promise.resolve({ path, token: 'test' }),
  signedDownloadUrl: (path: string) => Promise.resolve(`https://files.test/${path}`),
  download: () => Promise.resolve(null),
  save: () => Promise.resolve(),
  remove: () => Promise.resolve(),
};

const stores = {
  workspace: dbWorkspaceStore(db),
  receipts: dbReceiptStore(db),
  expenses: dbExpenseStore(db),
  categories: dbCategoryStore(db),
  itemized: dbItemizedStore(db),
  reports: dbReportStore(db),
  people: dbPeopleStore(db),
};
const apiWith = (flagOverrides: string) =>
  createApi({
    version: 'int',
    verifyToken: (token) =>
      Promise.resolve({
        userId: token,
        email: `${token}@example.com`,
        assuranceLevel: 'aal1',
        sessionId: 's',
        issuedAt: new Date(),
      }),
    ...stores,
    files,
    flagOverrides,
  });
const ON =
  'team.invites=on,expenses.categories=on,expenses.itemized=on,expenses.split=on,' +
  'reports.export=on,reports.currency-conversion=on';
const on = apiWith(ON);
const off = apiWith('team.invites=on,expenses.categories=on,reports.export=on');

const run = randomBytes(3).toString('hex');
const user = (name: string) => `${name}-${run}`;

interface Amount {
  readonly amountMinor: number;
  readonly decimal: string;
}
interface Line {
  readonly position: number;
  readonly kind: string;
  readonly description: string;
  readonly amount: Amount;
  readonly share: Amount | null;
  readonly claimed: Amount | null;
  readonly excluded: { readonly reason: string; readonly note: string | null } | null;
  readonly purchase?: number | null;
  readonly part: { readonly categoryId: string } | null;
}
interface Bought {
  readonly number: number;
  readonly description: string;
  readonly date: string | null;
  readonly cardLastFour: string | null;
  readonly total: Amount | null;
  readonly claimed: Amount | null;
  readonly lines: number[];
  readonly excluded: { readonly reason: string; readonly note: string | null } | null;
}
/** The parts of the answers these checks read. */
interface Body {
  readonly id: string;
  readonly code?: string;
  readonly detail?: string;
  readonly field?: string;
  readonly token: string;
  readonly expenseId: string;
  readonly reportId: string;
  readonly organization: { readonly id: string };
  readonly amount: Amount | null;
  readonly itemized?: {
    readonly lines: Line[];
    readonly purchases?: Bought[];
    readonly addsUp: boolean;
    readonly problem: { readonly code: string; readonly message: string } | null;
    readonly claim: {
      readonly receipt: Amount;
      readonly excluded: Amount;
      readonly claimed: Amount;
    } | null;
    readonly byLine: { readonly usable: boolean; readonly code: string | null };
  } | null;
  readonly split?: {
    readonly basis: string;
    readonly parts: {
      readonly own: boolean;
      readonly category: { readonly name: string } | null;
      readonly amount: Amount;
      readonly lines: number[];
    }[];
  } | null;
  readonly categories: { readonly id: string; readonly name: string; readonly typeIds: string[] }[];
  readonly types: { readonly id: string; readonly name: string }[];
  readonly currency: string;
  readonly rows: {
    readonly category: { readonly name: string } | null;
    readonly type: { readonly name: string } | null;
    readonly totals: Amount[];
    readonly reimbursed?: Amount | null;
    readonly converting?: number;
  }[];
}

async function call(
  who: string,
  method: string,
  path: string,
  body?: unknown,
  api: ReturnType<typeof createApi> = on,
) {
  const res = await api.request(path, {
    method,
    headers: {
      authorization: `Bearer ${who}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = res.headers.get('content-type')?.includes('json');
  return {
    status: res.status,
    body: (text && json ? JSON.parse(text) : null) as Body,
    text,
  };
}

const usd = (cents: number) => money(cents, 'USD');
const line = (kind: LineKind, description: string, cents: number) => ({
  kind,
  description,
  quantity: null,
  amount: usd(cents),
});
const FOLIO: Itemization = {
  currency: 'USD',
  subtotal: usd(96_150),
  total: usd(110_400),
  lines: [
    line('item', 'Room, 3 nights', 89_700),
    line('item', 'Minibar', 1850),
    line('item', 'Room service', 4600),
    line('tax', 'Occupancy tax', 12_495),
    line('fee', 'Resort fee', 1755),
  ],
};
/** The folio as a model reads it, for an expense filed before lines were copied on. */
const FOLIO_READING = {
  documentType: 'hotel_folio',
  merchant: { name: 'Hotel Lindley', confidence: 'high' },
  date: { value: '2026-10-01', confidence: 'high' },
  currency: { code: 'USD', confidence: 'high' },
  total: { value: '1104.00', confidence: 'high' },
  subtotal: { value: '961.50', confidence: 'high' },
  fees: [{ label: 'Resort fee', value: '17.55', confidence: 'high' }],
  taxes: [{ label: 'Occupancy tax', value: '124.95', confidence: 'high' }],
  tip: null,
  cardLastFour: null,
  time: null,
  address: null,
  lineItems: [
    { description: 'Room, 3 nights', quantity: null, amount: '897.00' },
    { description: 'Minibar', quantity: null, amount: '18.50' },
    { description: 'Room service', quantity: null, amount: '46.00' },
  ],
};
const STAY = {
  merchant: 'Hotel Lindley',
  transactionDate: '2026-10-01',
  currency: 'USD',
  amountMinor: 110_400,
};

let orgId = '';
/**
 * A receipt filed the way the app files one, then read as the workflow reads it: with `lines`
 * copied on, or, with `reading`, filed the way it was before lines were copied.
 */
async function readReceipt(
  who: string,
  name: string,
  lines: Itemization | null,
  reading?: Record<string, unknown>,
  offer: typeof STAY = STAY,
): Promise<string> {
  const bytes = `${run} ${name}`;
  const described = {
    contentType: 'image/png',
    byteSize: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
  const ticket = await call(who, 'POST', '/v1/receipts/uploads', described);
  const filed = await call(who, 'POST', '/v1/receipts', {
    id: (ticket.body as unknown as { receiptId: string }).receiptId,
    source: 'upload',
    ...described,
  });
  expect(filed.status).toBe(202);
  const receiptId = filed.body.id;
  const requestId = newId();
  await withOrg(db, orgId, async (tx) => {
    if (reading) {
      await recordExtractionRun(tx, orgId, {
        receiptId,
        requestId,
        extractor: 'claude',
        model: COMPARISON_MODELS[1],
        promptVersion: 'extract-v3',
        schemaVersion: 'receipt-v3',
        outcome: 'confident',
        output: reading,
        fieldConfidence: null,
        error: null,
        latencyMs: 900,
        inputTokens: 100,
        outputTokens: 20,
        costMicroUsd: 10,
      });
    }
    await settleReceipt(tx, orgId, receiptId, {
      status: 'extracted',
      requestId,
      detail: {},
      values: offer,
      ...(reading ? {} : { lines }),
    });
  });
  return (await call(who, 'GET', `/v1/receipts/${receiptId}`)).body.expenseId;
}

const owner = user('riley');
const sam = user('sam');
const finn = user('finn');
const alex = user('alex');
let meals = { categoryId: '', typeId: '' };
let lodging = { categoryId: '', typeId: '' };

beforeAll(async () => {
  const made = await call(owner, 'POST', '/v1/me/organization');
  orgId = made.body.organization.id;
  for (const [who, role] of [
    [sam, 'member'],
    [finn, 'finance_admin'],
    [alex, 'member'],
  ] as const) {
    const invite = await call(owner, 'POST', '/v1/settings/people/invites', { role });
    expect(
      (await call(who, 'POST', '/v1/invites/accept', { token: invite.body.token })).status,
    ).toBe(200);
  }
  const catalog = (await call(owner, 'GET', '/v1/categories')).body;
  const pick = (category: string, type: string) => ({
    categoryId: catalog.categories.find((c) => c.name === category)!.id,
    typeId: catalog.types.find((t) => t.name === type)!.id,
  });
  meals = pick('Meals', 'Business meal');
  lodging = pick('Travel', 'Lodging');
});

describe('with the features off (ADR-0032)', () => {
  it('reads an expense as before, and every route of lines and splits is absent', async () => {
    const expenseId = await readReceipt(owner, 'off', FOLIO);
    const shown = await call(owner, 'GET', `/v1/expenses/${expenseId}`, undefined, off);
    expect(shown.status).toBe(200);
    expect(shown.body).not.toHaveProperty('itemized');
    expect(shown.body).not.toHaveProperty('split');
    const attempts: [string, string, unknown?][] = [
      ['PUT', `/v1/expenses/${expenseId}/lines/2/exclusion`, { reason: 'personal' }],
      ['DELETE', `/v1/expenses/${expenseId}/lines/2/exclusion`],
      [
        'PUT',
        `/v1/expenses/${expenseId}/split`,
        { basis: 'lines', lines: [{ position: 3, ...meals }] },
      ],
      ['DELETE', `/v1/expenses/${expenseId}/split`],
      ['GET', `/v1/reports/${newId()}/categories`],
    ];
    for (const [method, path, body] of attempts) {
      expect(await call(owner, method, path, body, off), `${method} ${path}`).toMatchObject({
        status: 404,
        body: { code: 'feature_off' },
      });
    }
    // Split needs categories on too.
    const noCategories = apiWith('expenses.itemized=on,expenses.split=on');
    expect(
      await call(owner, 'DELETE', `/v1/expenses/${expenseId}/split`, undefined, noCategories),
    ).toMatchObject({ status: 404, body: { code: 'feature_off' } });
    expect(
      (await call(owner, 'GET', `/v1/expenses/${expenseId}`, undefined, noCategories)).body,
    ).not.toHaveProperty('split');
  });
});

describe('a receipt’s lines under the expense’s total (FR-INT-22)', () => {
  it('shows each line as read with its share of the tax, tip and fees, and none without lines', async () => {
    const expenseId = await readReceipt(owner, 'show', FOLIO);
    const { body } = await call(owner, 'GET', `/v1/expenses/${expenseId}`);
    expect(body.itemized?.addsUp).toBe(true);
    expect(
      body.itemized?.lines.map((l) => [
        l.position,
        l.kind,
        l.description,
        l.amount.decimal,
        l.share?.decimal ?? null,
      ]),
    ).toEqual([
      [1, 'item', 'Room, 3 nights', '897.00', '132.95'],
      [2, 'item', 'Minibar', '18.50', '2.74'],
      [3, 'item', 'Room service', '46.00', '6.81'],
      [4, 'tax', 'Occupancy tax', '124.95', null],
      [5, 'fee', 'Resort fee', '17.55', null],
    ]);
    expect(body.itemized?.claim).toMatchObject({
      receipt: { decimal: '1104.00' },
      excluded: { decimal: '0.00' },
      claimed: { decimal: '1104.00' },
    });
    expect(body.itemized?.byLine).toEqual({ usable: true, code: null, message: null });
    expect(body.split).toBeNull();

    const plain = await readReceipt(owner, 'plain', null);
    expect((await call(owner, 'GET', `/v1/expenses/${plain}`)).body.itemized).toBeNull();
  });

  it('shows an expense filed before lines were copied its reading’s lines, taken on its first change', async () => {
    const expenseId = await readReceipt(owner, 'legacy', null, FOLIO_READING);
    const { body } = await call(owner, 'GET', `/v1/expenses/${expenseId}`);
    expect(body.itemized?.lines).toHaveLength(5);
    const excluded = await call(owner, 'PUT', `/v1/expenses/${expenseId}/lines/2/exclusion`, {
      reason: 'personal',
    });
    expect(excluded.status).toBe(200);
    expect(excluded.body.amount?.decimal).toBe('1082.76');
  });

  it('says plainly when the lines don’t add up, refusing exclusion and a split by line, and splits by amount', async () => {
    const short = { ...FOLIO, lines: FOLIO.lines.filter((l) => l.description !== 'Minibar') };
    const expenseId = await readReceipt(owner, 'short', short);
    const { body } = await call(owner, 'GET', `/v1/expenses/${expenseId}`);
    expect(body.itemized).toMatchObject({
      addsUp: false,
      problem: {
        code: 'subtotal',
        message: 'These lines come to $943.00, but the receipt’s subtotal is $961.50.',
      },
      claim: null,
      byLine: { usable: false, code: 'lines_dont_add_up' },
    });
    expect(body.itemized?.lines.every((l) => l.share === null)).toBe(true);
    expect(
      await call(owner, 'PUT', `/v1/expenses/${expenseId}/lines/1/exclusion`, {
        reason: 'personal',
      }),
    ).toMatchObject({ status: 409, body: { code: 'lines_dont_add_up' } });
    expect(
      await call(owner, 'PUT', `/v1/expenses/${expenseId}/split`, {
        basis: 'lines',
        lines: [{ position: 2, ...meals }],
      }),
    ).toMatchObject({ status: 409, body: { code: 'lines_dont_add_up' } });
    const split = await call(owner, 'PUT', `/v1/expenses/${expenseId}/split`, {
      basis: 'amounts',
      parts: [
        { ...lodging, amount: '1050.00' },
        { ...meals, amount: '54.00' },
      ],
    });
    expect(split.status).toBe(200);
    expect(split.body.split?.parts.map((p) => [p.category?.name, p.amount.decimal])).toEqual([
      ['Travel', '1050.00'],
      ['Meals', '54.00'],
    ]);
  });
});

describe('excluding a line (FR-EXP-16)', () => {
  it('drops the claim by the line and its share, with its reason, and includes it again', async () => {
    const expenseId = await readReceipt(owner, 'exclude', FOLIO);
    const path = `/v1/expenses/${expenseId}/lines/2/exclusion`;
    expect(await call(owner, 'PUT', path, { reason: 'other' })).toMatchObject({
      status: 422,
      body: { code: 'note_needed', field: 'note' },
    });
    expect(
      await call(owner, 'PUT', `/v1/expenses/${expenseId}/lines/4/exclusion`, {
        reason: 'personal',
      }),
    ).toMatchObject({
      status: 422,
      body: { code: 'not_an_item' },
    });
    const excluded = await call(owner, 'PUT', path, {
      reason: 'other',
      note: 'Snacks for the drive',
    });
    expect(excluded.status).toBe(200);
    expect(excluded.body.amount?.decimal).toBe('1082.76');
    expect(excluded.body.itemized?.lines[1]?.excluded).toMatchObject({
      reason: 'other',
      note: 'Snacks for the drive',
    });
    expect(excluded.body.itemized?.claim).toMatchObject({
      receipt: { decimal: '1104.00' },
      excluded: { decimal: '21.24' },
      claimed: { decimal: '1082.76' },
    });
    // Its amount is made of its lines now.
    expect(
      await call(owner, 'PATCH', `/v1/expenses/${expenseId}`, { amount: '1104.00' }),
    ).toMatchObject({
      status: 409,
      body: { code: 'itemized' },
    });
    const included = await call(owner, 'DELETE', path);
    expect(included.status).toBe(200);
    expect(included.body.amount?.decimal).toBe('1104.00');
    expect(included.body.itemized?.lines[1]?.excluded).toBeNull();
  });

  it('shows a member’s lines to finance, who can’t change them, and nothing to another member', async () => {
    const expenseId = await readReceipt(sam, 'sams', FOLIO);
    const path = `/v1/expenses/${expenseId}/lines/2/exclusion`;
    expect((await call(sam, 'PUT', path, { reason: 'personal' })).status).toBe(200);
    const seen = await call(finn, 'GET', `/v1/expenses/${expenseId}`);
    expect(seen.body.itemized?.lines[1]?.excluded).toMatchObject({ reason: 'personal' });
    expect(await call(finn, 'DELETE', path)).toMatchObject({
      status: 403,
      body: { code: 'not_yours' },
    });
    expect((await call(alex, 'GET', `/v1/expenses/${expenseId}`)).status).toBe(404);
    expect((await call(alex, 'DELETE', path)).status).toBe(404);
    expect((await call(sam, 'GET', `/v1/expenses/${expenseId}`)).body.amount?.decimal).toBe(
      '1082.76',
    );
  });
});

describe('splitting an expense into parts (FR-EXP-15)', () => {
  it('splits by line, the rest keeping the expense’s own, and by amount only when the parts add up', async () => {
    const expenseId = await readReceipt(owner, 'split', FOLIO);
    const path = `/v1/expenses/${expenseId}/split`;
    const byLine = await call(owner, 'PUT', path, {
      basis: 'lines',
      lines: [{ position: 3, ...meals }],
    });
    expect(byLine.status).toBe(200);
    expect(byLine.body.split).toMatchObject({ basis: 'lines' });
    expect(
      byLine.body.split?.parts.map((p) => [
        p.own,
        p.category?.name ?? null,
        p.amount.decimal,
        p.lines,
      ]),
    ).toEqual([
      [true, null, '1051.19', [1, 2]],
      [false, 'Meals', '52.81', [3]],
    ]);
    expect(byLine.body.itemized?.lines[2]?.part).toMatchObject({ categoryId: meals.categoryId });

    expect(
      await call(owner, 'PUT', path, {
        basis: 'amounts',
        parts: [
          { ...lodging, amount: '1000.00' },
          { ...meals, amount: '100.00' },
        ],
      }),
    ).toMatchObject({
      status: 422,
      body: { code: 'parts_dont_add_up', detail: 'The parts must add up to $1,104.00 exactly.' },
    });
    expect(
      await call(owner, 'PUT', path, {
        basis: 'amounts',
        parts: [
          { ...lodging, amount: '1104.00' },
          { ...meals, typeId: lodging.typeId, amount: '0.00' },
        ],
      }),
    ).toMatchObject({ status: 422, body: { code: 'type_not_allowed', field: 'parts[1]' } });
    const byAmount = await call(owner, 'PUT', path, {
      basis: 'amounts',
      parts: [
        { ...lodging, amount: '1000.00' },
        { ...meals, amount: '104.00' },
      ],
    });
    expect(byAmount.body.split?.parts.map((p) => p.amount.decimal)).toEqual(['1000.00', '104.00']);
    expect(byAmount.body.itemized?.lines.every((l) => l.part === null)).toBe(true);
    expect(
      await call(owner, 'PUT', `/v1/expenses/${expenseId}/lines/2/exclusion`, {
        reason: 'personal',
      }),
    ).toMatchObject({ status: 409, body: { code: 'split_by_amount' } });
    const removed = await call(owner, 'DELETE', path);
    expect(removed.body.split).toBeNull();
  });

  it('totals a report by category and type, its conversion following the claim, and exports a row per part', async () => {
    // A folio in euros, on a report reimbursed in dollars.
    const euros = (m: { amountMinor: number } | null) => m && money(m.amountMinor, 'EUR');
    const inEuros: Itemization = {
      currency: 'EUR',
      total: euros(FOLIO.total),
      subtotal: euros(FOLIO.subtotal),
      lines: FOLIO.lines.map((l) => ({ ...l, amount: money(l.amount.amountMinor, 'EUR') })),
    };
    const expenseId = await readReceipt(owner, 'report', inEuros, undefined, {
      ...STAY,
      currency: 'EUR',
    });
    await call(owner, 'PUT', `/v1/expenses/${expenseId}/split`, {
      basis: 'lines',
      lines: [{ position: 3, ...meals }],
    });
    await call(owner, 'PUT', `/v1/expenses/${expenseId}/lines/2/exclusion`, { reason: 'personal' });
    await call(owner, 'PUT', `/v1/expenses/${expenseId}/category`, lodging);
    await call(owner, 'PUT', `/v1/expenses/${expenseId}/justification`, {
      justification: 'Partner summit',
    });
    const moved = await call(owner, 'PUT', `/v1/expenses/${expenseId}/report`, { newReport: true });
    expect(moved.status).toBe(200);
    const reportId = moved.body.reportId;
    // A rate recorded for the amount before its minibar was left out: the claim converts at it.
    await withOrg(db, orgId, (tx) =>
      tx.insert(expenseConversions).values({
        orgId,
        expenseId,
        amountMinor: 110_400,
        currency: 'EUR',
        purchaseDate: '2026-10-01',
        reimbursementCurrency: 'USD',
        outcome: 'converted',
        convertedMinor: 121_440,
        rate: '1.1',
        rateDate: '2026-10-01',
        source: 'ECB',
      }),
    );
    const totals = await call(owner, 'GET', `/v1/reports/${reportId}/categories`);
    expect(totals.status).toBe(200);
    expect(totals.body.currency).toBe('USD');
    // 1,082.76 euros at 1.1 is 1,191.04 dollars, split in proportion across its parts.
    expect(
      totals.body.rows.map((r) => [
        r.category?.name,
        r.type?.name,
        r.totals.map((t) => `${t.decimal}`),
        r.reimbursed?.decimal,
        r.converting,
      ]),
    ).toEqual([
      ['Meals', 'Business meal', ['52.81'], '58.09', 0],
      ['Travel', 'Lodging', ['1029.95'], '1132.95', 0],
    ]);
    expect(await call(alex, 'GET', `/v1/reports/${reportId}/categories`)).toMatchObject({
      status: 404,
    });

    expect((await call(owner, 'POST', `/v1/reports/${reportId}/close`)).status).toBe(200);
    const csv = await call(owner, 'GET', `/v1/reports/${reportId}/export.csv`);
    expect(csv.status).toBe(200);
    const rows = csv.text.split('\r\n');
    // The byte order mark is read away with the text.
    expect(rows[0]).toBe(
      'Date,Merchant,Part,Category,Type,Trip,Purpose,Note,Excluded,Amount,Currency',
    );
    expect(rows.slice(1, 3)).toEqual([
      '2026-10-01,Hotel Lindley,1 of 2,Travel,Lodging,,Partner summit,,"Minibar: 21.24, Personal",1029.95,EUR',
      '2026-10-01,Hotel Lindley,2 of 2,Meals,Business meal,,Partner summit,,,52.81,EUR',
    ]);
    const plain = await call(owner, 'GET', `/v1/reports/${reportId}/export.csv`, undefined, off);
    expect(plain.text.split('\r\n')[1]).toBe(
      '2026-10-01,Hotel Lindley,Travel,Lodging,,Partner summit,,1082.76,EUR',
    );
  });
});

/**
 * An airline receipt of two purchases (FR-INT-23, Q49): the ticket, bought Sep 12 on one card,
 * and a seat upgrade bought Sep 30 on a personal card, each with its own taxes and fees.
 */
const of = (purchase: number, l: ReturnType<typeof line>) => ({ ...l, purchase });
const AIRFARE: Itemization = {
  currency: 'USD',
  subtotal: null,
  total: usd(48_713),
  purchases: [
    { description: 'Ticket', date: '2026-09-12', cardLastFour: '4417', total: usd(40_220) },
    { description: 'Seat upgrade', date: '2026-09-30', cardLastFour: '9921', total: usd(8493) },
  ],
  lines: [
    of(1, line('item', 'Airfare', 36_000)),
    of(1, line('tax', 'US transportation tax', 2700)),
    of(1, line('fee', 'September 11 security fee', 560)),
    of(1, line('fee', 'Passenger facility charge', 960)),
    of(2, line('item', 'Economy Plus', 7900)),
    of(2, line('tax', 'US transportation tax', 593)),
  ],
};
const FLIGHT = {
  merchant: 'Example Air',
  transactionDate: '2026-09-12',
  currency: 'USD',
  amountMinor: 48_713,
};
const PURCHASES_ON = apiWith(`${ON},receipts.purchases=on`);

describe('a receipt of several purchases (FR-INT-23, FR-EXP-20)', () => {
  it('shows each purchase with its lines, and leaves out the seat upgrade with its own taxes', async () => {
    const expenseId = await readReceipt(owner, 'airfare', AIRFARE, undefined, FLIGHT);
    const shown = await call(owner, 'GET', `/v1/expenses/${expenseId}`, undefined, PURCHASES_ON);
    expect(shown.body.itemized?.purchases).toEqual([
      {
        number: 1,
        description: 'Ticket',
        date: '2026-09-12',
        cardLastFour: '4417',
        total: { amountMinor: 40_220, currency: 'USD', decimal: '402.20' },
        claimed: { amountMinor: 40_220, currency: 'USD', decimal: '402.20' },
        lines: [1, 2, 3, 4],
        excluded: null,
      },
      {
        number: 2,
        description: 'Seat upgrade',
        date: '2026-09-30',
        cardLastFour: '9921',
        total: { amountMinor: 8493, currency: 'USD', decimal: '84.93' },
        claimed: { amountMinor: 8493, currency: 'USD', decimal: '84.93' },
        lines: [5, 6],
        excluded: null,
      },
    ]);
    expect(shown.body.itemized?.lines.map((l) => [l.purchase, l.share?.decimal ?? null])).toEqual([
      [1, '42.20'],
      [1, null],
      [1, null],
      [1, null],
      [2, '5.93'],
      [2, null],
    ]);

    const path = `/v1/expenses/${expenseId}/purchases/2/exclusion`;
    expect(
      await call(
        owner,
        'PUT',
        `/v1/expenses/${expenseId}/purchases/3/exclusion`,
        {
          reason: 'personal',
        },
        PURCHASES_ON,
      ),
    ).toMatchObject({ status: 422, body: { code: 'no_such_purchase', field: 'purchase' } });
    const left = await call(owner, 'PUT', path, { reason: 'personal' }, PURCHASES_ON);
    expect(left.status).toBe(200);
    expect(left.body.amount?.decimal).toBe('402.20');
    expect(left.body.itemized?.claim).toMatchObject({
      receipt: { decimal: '487.13' },
      excluded: { decimal: '84.93' },
      claimed: { decimal: '402.20' },
    });
    expect(left.body.itemized?.purchases?.[1]?.excluded).toEqual({
      reason: 'personal',
      note: null,
    });
    // Finance sees it left out and why, and can't include it again.
    const seen = await call(finn, 'GET', `/v1/expenses/${expenseId}`, undefined, PURCHASES_ON);
    expect(seen.body.itemized?.purchases?.[1]?.excluded).toMatchObject({ reason: 'personal' });
    expect(await call(finn, 'DELETE', path, undefined, PURCHASES_ON)).toMatchObject({
      status: 403,
      body: { code: 'not_yours' },
    });
    const back = await call(owner, 'DELETE', path, undefined, PURCHASES_ON);
    expect(back.status).toBe(200);
    expect(back.body.amount?.decimal).toBe('487.13');
    expect(back.body.itemized?.purchases?.[1]?.excluded).toBeNull();
  });

  it('answers that the feature is off while several purchases are, and shows a receipt of one none', async () => {
    const expenseId = await readReceipt(owner, 'airfare-off', AIRFARE, undefined, FLIGHT);
    const path = `/v1/expenses/${expenseId}/purchases/2/exclusion`;
    expect(await call(owner, 'PUT', path, { reason: 'personal' })).toMatchObject({
      status: 404,
      body: { code: 'feature_off' },
    });
    expect(await call(owner, 'DELETE', path)).toMatchObject({
      status: 404,
      body: { code: 'feature_off' },
    });
    const folio = await readReceipt(owner, 'folio-one', FOLIO);
    const shown = await call(owner, 'GET', `/v1/expenses/${folio}`, undefined, PURCHASES_ON);
    expect(shown.body.itemized?.purchases).toEqual([]);
    expect(shown.body.itemized?.lines.every((l) => l.purchase === null)).toBe(true);
  });
});
