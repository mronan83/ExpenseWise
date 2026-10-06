/**
 * Paid by the company by API, on a real database as expensewise_app (F-62, FR-EXP-17,
 * FR-EXP-18, Q46 to Q48, ADR-0045): the policy by type, a person's switch on each expense, and
 * what is left out of a claim and listed apart. A bearer token signs in as the person it names;
 * one ending in "@aal2" is a session that passed the second factor. Run with
 * `pnpm test:integration`.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createDatabase, recordExtractionRun, settleReceipt, withOrg } from '@expensewise/db';
import { newId, reportExportTable, type ExportExpense } from '@expensewise/domain';
import { COMPARISON_MODELS } from '@expensewise/extraction';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createApi } from '../src/app.ts';
import { dbCategoryStore } from '../src/categories.ts';
import { dbCompanyPaidStore } from '../src/company-paid.ts';
import { dbExpenseStore } from '../src/expenses.ts';
import { dbItemizedStore } from '../src/itemized.ts';
import { dbMileageStore } from '../src/mileage.ts';
import { dbPeopleStore } from '../src/people.ts';
import { reportPdfText } from '../src/report-pdf.ts';
import { dbReceiptStore } from '../src/receipts.ts';
import { dbReportStore } from '../src/reports.ts';
import { dbTripStore } from '../src/trips.ts';
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

const AAL2 = '@aal2';
const apiWith = (flagOverrides: string) =>
  createApi({
    version: 'int',
    verifyToken: (token) =>
      Promise.resolve({
        userId: token.replace(AAL2, ''),
        email: `${token.replace(AAL2, '')}@example.com`,
        assuranceLevel: token.endsWith(AAL2) ? 'aal2' : 'aal1',
        sessionId: 's',
        issuedAt: new Date(),
      }),
    workspace: dbWorkspaceStore(db),
    receipts: dbReceiptStore(db),
    expenses: dbExpenseStore(db),
    trips: dbTripStore(db),
    mileage: dbMileageStore(db),
    categories: dbCategoryStore(db),
    companyPaid: dbCompanyPaidStore(db),
    itemized: dbItemizedStore(db),
    reports: dbReportStore(db),
    people: dbPeopleStore(db),
    files,
    flagOverrides,
  });
const BASE =
  'team.invites=on,expenses.categories=on,expenses.mileage=on,reports.export=on,' +
  'reports.currency-conversion=on';
const on = apiWith(`${BASE},expenses.company-paid=on,expenses.split=on`);
const off = apiWith(BASE);

const run = randomBytes(3).toString('hex');
const user = (name: string) => `${name}-${run}`;

interface Amount {
  readonly amountMinor: number;
  readonly currency: string;
  readonly decimal: string;
}
/** The parts of the answers these checks read. */
interface Body {
  readonly id: string;
  readonly code?: string;
  readonly token: string;
  readonly expenseId: string;
  readonly reportId: string;
  readonly organization: { readonly id: string };
  readonly status: string;
  readonly paidBy?: string;
  readonly paidByPinned?: boolean;
  readonly companyPays?: boolean;
  readonly switched: number;
  readonly categories: { readonly id: string; readonly name: string; readonly typeIds: string[] }[];
  readonly types: { readonly id: string; readonly name: string; readonly companyPays?: boolean }[];
  readonly totals: Amount[];
  readonly cost?: { readonly claimed: Amount[]; readonly companyPaid: Amount[] };
  readonly expenses: { readonly id: string; readonly paidBy?: string }[];
  readonly reimbursement?: { readonly total: Amount };
  readonly tripItems: {
    readonly totals: Amount[];
    readonly cost?: { readonly claimed: Amount[]; readonly companyPaid: Amount[] };
    readonly reimbursement?: { readonly total: Amount };
  }[];
  readonly localItems: { readonly id: string; readonly paidBy?: string }[];
  readonly companyPaid?: {
    readonly expenses: { readonly id: string; readonly ready: boolean }[];
    readonly totals: Amount[];
    readonly fullCost: Amount[];
  };
  readonly reports: { readonly id: string; readonly totals: Amount[] }[];
  readonly rows: { readonly type: { readonly name: string } | null; readonly totals: Amount[] }[];
  readonly trips: {
    readonly id: string;
    readonly cost?: { readonly claimed: Amount[]; readonly companyPaid: Amount[] };
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
  return { status: res.status, body: (text && json ? JSON.parse(text) : null) as Body, text };
}

const decimals = (amounts: readonly Amount[] | undefined) =>
  (amounts ?? []).map((a) => `${a.decimal} ${a.currency}`);

let orgId = '';
/** A receipt filed the way the app files one, then read as these values, Ready. */
async function readReceipt(
  who: string,
  merchant: string,
  date: string,
  amountMinor: number,
): Promise<string> {
  const bytes = `${run} ${merchant} ${date}`;
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
  const decimal = (amountMinor / 100).toFixed(2);
  await withOrg(db, orgId, async (tx) => {
    await recordExtractionRun(tx, orgId, {
      receiptId,
      requestId,
      extractor: 'claude',
      model: COMPARISON_MODELS[1],
      promptVersion: 'extract-v3',
      schemaVersion: 'receipt-v3',
      outcome: 'confident',
      output: {
        documentType: 'receipt',
        merchant: { name: merchant, confidence: 'high' },
        date: { value: date, confidence: 'high' },
        currency: { code: 'USD', confidence: 'high' },
        total: { value: decimal, confidence: 'high' },
        subtotal: null,
        fees: [],
        taxes: [],
        tip: null,
        cardLastFour: null,
        time: null,
        address: null,
        lineItems: [],
      },
      fieldConfidence: null,
      error: null,
      latencyMs: 900,
      inputTokens: 100,
      outputTokens: 20,
      costMicroUsd: 10,
    });
    await settleReceipt(tx, orgId, receiptId, {
      status: 'extracted',
      requestId,
      detail: {},
      values: { merchant, transactionDate: date, currency: 'USD', amountMinor },
    });
  });
  return (await call(who, 'GET', `/v1/receipts/${receiptId}`)).body.expenseId;
}

const riley = user('riley');
const sam = user('sam');
const finn = user('finn');
let airfare = { categoryId: '', typeId: '' };

beforeAll(async () => {
  const made = await call(riley, 'POST', '/v1/me/organization');
  orgId = made.body.organization.id;
  for (const [who, role] of [
    [sam, 'member'],
    [finn, 'finance_admin'],
  ] as const) {
    const invite = await call(riley, 'POST', '/v1/settings/people/invites', { role });
    expect(
      (await call(who, 'POST', '/v1/invites/accept', { token: invite.body.token })).status,
    ).toBe(200);
  }
  const catalog = (await call(riley, 'GET', '/v1/categories')).body;
  const typeId = catalog.types.find((t) => t.name === 'Airfare')!.id;
  airfare = {
    typeId,
    categoryId: catalog.categories.find((c) => c.typeIds.includes(typeId))!.id,
  };
});

describe('with Paid by the company off (ADR-0032)', () => {
  it('answers 404 feature_off on both routes, and shows no one who paid', async () => {
    const expenseId = await readReceipt(sam, 'Delta Air Lines', '2026-08-03', 31_240);
    for (const [who, method, path, body] of [
      [sam, 'PUT', `/v1/expenses/${expenseId}/paid-by`, { paidBy: 'company' }],
      [
        riley,
        'PUT',
        `/v1/settings/expense-types/${airfare.typeId}/company-pays`,
        { companyPays: true },
      ],
    ] as const) {
      expect(await call(who, method, path, body, off), path).toMatchObject({
        status: 404,
        body: { code: 'feature_off' },
      });
    }
    const shown = await call(sam, 'GET', `/v1/expenses/${expenseId}`, undefined, off);
    expect(shown.body).not.toHaveProperty('paidBy');
    const catalog = await call(sam, 'GET', '/v1/categories', undefined, off);
    expect(catalog.body.types.every((t) => !('companyPays' in t))).toBe(true);
    // The types it goes by come with categories, so the policy needs them on too.
    const noCategories = apiWith('expenses.company-paid=on');
    expect(
      await call(
        riley,
        'PUT',
        `/v1/settings/expense-types/${airfare.typeId}/company-pays`,
        { companyPays: true },
        noCategories,
      ),
    ).toMatchObject({ status: 404, body: { code: 'feature_off' } });
  });
});

describe('the policy of the types the company pays (FR-EXP-18, Q46)', () => {
  it('lets only owners and finance admins change it, as an admin action past the second factor', async () => {
    const path = `/v1/settings/expense-types/${airfare.typeId}/company-pays`;
    expect(await call(sam, 'PUT', path, { companyPays: true })).toMatchObject({
      status: 403,
      body: { code: 'forbidden_role' },
    });
    const guarded = apiWith(`${BASE},expenses.company-paid=on,security.second-factor=on`);
    expect(await call(finn, 'PUT', path, { companyPays: true }, guarded)).toMatchObject({
      status: 403,
      body: { code: 'second_factor_required' },
    });
    const saved = await call(`${finn}${AAL2}`, 'PUT', path, { companyPays: true }, guarded);
    expect(saved).toMatchObject({
      status: 200,
      body: { id: airfare.typeId, name: 'Airfare', companyPays: true },
    });
    const catalog = await call(sam, 'GET', '/v1/categories');
    expect(catalog.body.types.find((t) => t.id === airfare.typeId)?.companyPays).toBe(true);
    expect(catalog.body.types.find((t) => t.name === 'Lodging')?.companyPays).toBe(false);
    expect(
      await call(riley, 'PUT', `/v1/settings/expense-types/${newId()}/company-pays`, {
        companyPays: true,
      }),
    ).toMatchObject({ status: 404, body: { code: 'not_found' } });
  });

  it('marks an airfare expense paid by the company once a person gives it its type', async () => {
    const fare = await readReceipt(sam, 'Alaska Airlines', '2026-08-10', 22_150);
    expect((await call(sam, 'GET', `/v1/expenses/${fare}`)).body).toMatchObject({
      paidBy: 'claimant',
      paidByPinned: false,
    });
    const classified = await call(sam, 'PUT', `/v1/expenses/${fare}/category`, airfare);
    expect(classified).toMatchObject({
      status: 200,
      body: { paidBy: 'company', paidByPinned: false },
    });
  });
});

describe('who paid one expense (FR-EXP-17, Q46)', () => {
  it('sets it by hand and keeps it whatever the policy says, until handed back', async () => {
    const fare = await readReceipt(sam, 'JetBlue', '2026-08-12', 19_480);
    await call(sam, 'PUT', `/v1/expenses/${fare}/category`, airfare);
    const mine = await call(sam, 'PUT', `/v1/expenses/${fare}/paid-by`, { paidBy: 'claimant' });
    expect(mine).toMatchObject({ status: 200, body: { paidBy: 'claimant', paidByPinned: true } });
    const policy = `/v1/settings/expense-types/${airfare.typeId}/company-pays`;
    expect((await call(riley, 'PUT', policy, { companyPays: false })).status).toBe(200);
    expect((await call(riley, 'PUT', policy, { companyPays: true })).status).toBe(200);
    expect((await call(sam, 'GET', `/v1/expenses/${fare}`)).body).toMatchObject({
      paidBy: 'claimant',
      paidByPinned: true,
    });
    const back = await call(sam, 'PUT', `/v1/expenses/${fare}/paid-by`, { byPolicy: true });
    expect(back).toMatchObject({ status: 200, body: { paidBy: 'company', paidByPinned: false } });
    expect(
      await call(sam, 'PUT', `/v1/expenses/${fare}/paid-by`, { paidBy: 'company', byPolicy: true }),
    ).toMatchObject({ status: 400 });
  });

  it('refuses another member’s expense, a drive, and one submitted, with 409 locked', async () => {
    const fare = await readReceipt(sam, 'Southwest Airlines', '2026-08-14', 15_600);
    expect(
      await call(riley, 'PUT', `/v1/expenses/${fare}/paid-by`, { paidBy: 'company' }),
    ).toMatchObject({ status: 403, body: { code: 'not_yours' } });
    const drive = await call(sam, 'POST', '/v1/mileage', {
      date: '2026-08-14',
      destination: 'Acme HQ',
      purpose: 'Client visit at Acme',
      miles: '12',
    });
    expect(drive.status).toBe(201);
    expect(
      await call(sam, 'PUT', `/v1/expenses/${drive.body.id}/paid-by`, { paidBy: 'company' }),
    ).toMatchObject({ status: 409, body: { code: 'mileage' } });
    // As its report's submission leaves it, for the system.
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(`select set_config('app.org_id', $1, true)`, [orgId]);
      await client.query(`update expenses set status = 'submitted' where id = $1`, [fare]);
      await client.query('commit');
    } finally {
      client.release();
    }
    expect(
      await call(sam, 'PUT', `/v1/expenses/${fare}/paid-by`, { paidBy: 'company' }),
    ).toMatchObject({ status: 409, body: { code: 'locked' } });
    expect(
      await call(sam, 'PUT', `/v1/expenses/${newId()}/paid-by`, { paidBy: 'company' }),
    ).toMatchObject({ status: 404, body: { code: 'not_found' } });
  });
});

describe('a trip and its report, by who paid (FR-EXP-17, Q47)', () => {
  let tripId = '';
  let reportId = '';
  let fare = '';
  let hotel = '';

  beforeAll(async () => {
    fare = await readReceipt(sam, 'United Airlines', '2026-09-22', 48_720);
    hotel = await readReceipt(sam, 'Hotel Lindley', '2026-09-23', 41_280);
    await call(sam, 'PUT', `/v1/expenses/${fare}/category`, airfare);
    const trip = await call(sam, 'POST', '/v1/trips', {
      name: 'Omaha · architecture review',
      purpose: 'Quarterly architecture review',
      startDate: '2026-09-21',
      endDate: '2026-09-24',
    });
    tripId = trip.body.id;
    const moved = await call(sam, 'PUT', `/v1/trips/${tripId}/report`, { newReport: true });
    reportId = moved.body.reportId;
  });

  it('shows a trip’s cost in full, split into claimed and paid by the company', async () => {
    const { body } = await call(sam, 'GET', `/v1/trips/${tripId}`);
    expect(decimals(body.totals)).toEqual(['900.00 USD']);
    expect(decimals(body.cost?.claimed)).toEqual(['412.80 USD']);
    expect(decimals(body.cost?.companyPaid)).toEqual(['487.20 USD']);
    expect(body.expenses.map((e) => [e.id, e.paidBy])).toEqual([
      [fare, 'company'],
      [hotel, 'claimant'],
    ]);
    const listed = await call(sam, 'GET', '/v1/trips');
    const inList = listed.body.trips.find((t) => t.id === tripId);
    expect(decimals(inList?.cost?.companyPaid)).toEqual(['487.20 USD']);
    const offView = await call(sam, 'GET', `/v1/trips/${tripId}`, undefined, off);
    expect(offView.body).not.toHaveProperty('cost');
  });

  it('leaves what the company paid out of the report’s claim and its conversion, and lists it apart with the full cost', async () => {
    const { body } = await call(sam, 'GET', `/v1/reports/${reportId}`);
    expect(decimals(body.totals)).toEqual(['412.80 USD']);
    expect(decimals(body.reimbursement ? [body.reimbursement.total] : [])).toEqual(['412.80 USD']);
    expect(decimals(body.tripItems[0]?.cost?.claimed)).toEqual(['412.80 USD']);
    expect(
      decimals(body.tripItems[0]?.reimbursement && [body.tripItems[0].reimbursement.total]),
    ).toEqual(['412.80 USD']);
    expect(body.companyPaid?.expenses.map((e) => [e.id, e.ready])).toEqual([[fare, true]]);
    expect(decimals(body.companyPaid?.totals)).toEqual(['487.20 USD']);
    expect(decimals(body.companyPaid?.fullCost)).toEqual(['900.00 USD']);
    // Its claim by category and type leaves it out too (FR-EXP-15).
    const byCategory = await call(sam, 'GET', `/v1/reports/${reportId}/categories`);
    expect(byCategory.body.rows.map((r) => [r.type?.name ?? null, decimals(r.totals)])).toEqual([
      [null, ['412.80 USD']],
    ]);
    const list = await call(sam, 'GET', '/v1/reports');
    expect(decimals(list.body.reports.find((r) => r.id === reportId)?.totals)).toEqual([
      '412.80 USD',
    ]);
    // Off, the report claims everything on it, as it always has.
    const offView = await call(sam, 'GET', `/v1/reports/${reportId}`, undefined, off);
    expect(decimals(offView.body.totals)).toEqual(['900.00 USD']);
    expect(offView.body).not.toHaveProperty('companyPaid');
  });

  it('exports the claim, then what the company paid apart, saying on each CSV row who paid', async () => {
    expect((await call(sam, 'POST', `/v1/reports/${reportId}/close`)).status).toBe(200);
    const csv = await call(sam, 'GET', `/v1/reports/${reportId}/export.csv`);
    expect(csv.status).toBe(200);
    // Read as text, the byte order mark is dropped.
    expect(csv.text.split('\r\n')).toEqual([
      'Date,Merchant,Category,Type,Trip,Purpose,Note,Amount,Currency,Paid by',
      '2026-09-23,Hotel Lindley,,,Omaha · architecture review,Quarterly architecture review,,412.80,USD,You',
      'Total,,,,,,,412.80,USD,',
      '2026-09-22,United Airlines,Travel,Airfare,Omaha · architecture review,Quarterly architecture review,,487.20,USD,The company',
      'Total paid by the company,,,,,,,487.20,USD,',
      'Full cost,,,,,,,900.00,USD,',
      '',
    ]);
    const pdf = await call(sam, 'GET', `/v1/reports/${reportId}/export.pdf`);
    expect(pdf.status).toBe(200);
    // Off, the export reads as it always has: one claim of everything.
    const offCsv = await call(sam, 'GET', `/v1/reports/${reportId}/export.csv`, undefined, off);
    expect(offCsv.text.split('\r\n')[0]).toBe(
      'Date,Merchant,Category,Type,Trip,Purpose,Note,Amount,Currency',
    );
    expect(offCsv.text).toContain('Total,,,,,,,900.00,USD');
  });

  it('writes a PDF section of what the company paid, after the claim, with its total and the full cost', async () => {
    const row = (over: Partial<ExportExpense>): ExportExpense => ({
      date: '2026-09-23',
      merchant: 'Hotel Lindley',
      category: null,
      type: null,
      trip: 'Omaha',
      purpose: 'Review',
      note: null,
      amountMinor: 41_280,
      currency: 'USD',
      ...over,
    });
    const table = reportExportTable([
      row({
        date: '2026-09-22',
        merchant: 'United Airlines',
        amountMinor: 48_720,
        paidBy: 'company',
      }),
      row({}),
    ]);
    const heading = {
      title: 'Omaha',
      person: 'Sam',
      organization: 'Acme',
      status: 'Closed',
      openedAt: new Date('2026-09-25T00:00:00Z'),
      closedAt: new Date('2026-09-26T00:00:00Z'),
      exportedAt: new Date('2026-09-27T00:00:00Z'),
    };
    const text = (await reportPdfText(heading, table)).flat();
    const at = (s: string) => text.indexOf(s);
    expect(at('Paid by the company, not claimed')).toBeGreaterThan(at('412.80'));
    expect(at('United Airlines')).toBeGreaterThan(at('Paid by the company, not claimed'));
    expect(at('Total paid by the company')).toBeGreaterThan(at('United Airlines'));
    expect(at('Full cost')).toBeGreaterThan(at('Total paid by the company'));
    expect(text).toContain('900.00');
  });
});

describe('closing a report with something the company paid (US-RPT-22 AC6)', () => {
  it('needs it Ready like any other: a local one the company paid needs its reason', async () => {
    const taxi = await readReceipt(sam, 'Yellow Cab', '2026-08-20', 3_450);
    expect(
      (await call(sam, 'PUT', `/v1/expenses/${taxi}/paid-by`, { paidBy: 'company' })).status,
    ).toBe(200);
    const moved = await call(sam, 'PUT', `/v1/expenses/${taxi}/report`, { newReport: true });
    const reportId = moved.body.reportId;
    const shown = await call(sam, 'GET', `/v1/reports/${reportId}`);
    expect(shown.body.totals).toEqual([]);
    expect(shown.body.localItems.map((e) => [e.id, e.paidBy])).toEqual([[taxi, 'company']]);
    expect(shown.body.companyPaid?.expenses.map((e) => [e.id, e.ready])).toEqual([[taxi, false]]);
    expect(await call(sam, 'POST', `/v1/reports/${reportId}/close`)).toMatchObject({
      status: 409,
      body: { code: 'needs_attention' },
    });
    await call(sam, 'PUT', `/v1/expenses/${taxi}/justification`, {
      justification: 'To the Acme office',
    });
    expect((await call(sam, 'POST', `/v1/reports/${reportId}/close`)).status).toBe(200);
  });
});
