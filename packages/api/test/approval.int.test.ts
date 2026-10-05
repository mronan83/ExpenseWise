/**
 * Single-step approval by API, on a real database as expensewise_app (FR-GOV-02, FR-GOV-03,
 * FR-GOV-04, FR-GOV-10 to FR-GOV-13, FR-EXP-10, NFR-DAT-04, Q29, #24, #70, ADR-0043). A bearer
 * token signs in as the person it names; one ending in "@aal2" is a session that passed the
 * second factor. Run with `pnpm test:integration`.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createDatabase, recordExtractionRun, settleReceipt, withOrg } from '@expensewise/db';
import { newId } from '@expensewise/domain';
import { COMPARISON_MODELS } from '@expensewise/extraction';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createApi } from '../src/app.ts';
import { dbApprovalStore } from '../src/approval.ts';
import { dbCategoryStore } from '../src/categories.ts';
import { dbExpenseStore } from '../src/expenses.ts';
import { dbHomeStore } from '../src/home.ts';
import { dbMileageStore } from '../src/mileage.ts';
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
    categories: dbCategoryStore(db),
    home: dbHomeStore(db),
    mileage: dbMileageStore(db),
    reports: dbReportStore(db),
    approvals: dbApprovalStore(db),
    people: dbPeopleStore(db),
    files,
    flagOverrides,
  });
const BASE = 'team.invites=on,reports.export=on,expenses.mileage=on,expenses.categories=on';
const on = apiWith(`${BASE},reports.approval=on`);
const off = apiWith(BASE);

const run = randomBytes(3).toString('hex');
const user = (name: string) => `${name}-${run}`;

interface Amount {
  readonly amountMinor: number;
  readonly decimal: string;
}
interface Check {
  readonly state: string;
  readonly needsReason: boolean;
  readonly over: boolean;
  readonly explainedBy: string | null;
  readonly text: string | null;
}
/** The parts of the answers these checks read. */
interface Body {
  readonly id: string;
  readonly code?: string;
  readonly detail?: string;
  readonly token: string;
  readonly expenseId: string;
  readonly reportId: string;
  readonly reason: string | null;
  readonly organization: { readonly id: string };
  readonly amount: Amount | null;
  readonly status: string;
  readonly claim?: { readonly reason: string | null; readonly check: Check };
  readonly expenses: {
    readonly id: string;
    readonly check: Check;
    readonly rejection: { readonly reason: string; readonly automatic: boolean } | null;
  }[];
  readonly approver: { readonly name: string } | null;
  readonly selfAttests: boolean;
  readonly can: { readonly submit: boolean; readonly approve: boolean; readonly return: boolean };
  readonly why: { readonly code: string } | null;
  readonly secondFactor: string;
  readonly steps: { readonly decision: string; readonly comment: string | null }[];
  readonly returned: { readonly comment: string; readonly by: string } | null;
  readonly reports: { readonly id: string }[];
  readonly categories: { readonly id: string; readonly name: string }[];
  readonly types: { readonly id: string; readonly name: string }[];
  readonly items: {
    readonly kind: string;
    readonly expense?: { readonly id: string };
    readonly report?: { readonly id: string };
    readonly reason: {
      readonly code: string;
      readonly why?: string;
      readonly comment?: string;
      readonly by?: string;
    };
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

let orgId = '';
/** A receipt filed the way the app files one, then read as $44.00 at Verve on Sep 28. */
async function readReceipt(who: string, name: string): Promise<string> {
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
        merchant: { name: 'Verve Coffee', confidence: 'high' },
        date: { value: '2026-09-28', confidence: 'high' },
        currency: { code: 'USD', confidence: 'high' },
        total: { value: '44.00', confidence: 'high' },
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
      values: {
        merchant: 'Verve Coffee',
        transactionDate: '2026-09-28',
        currency: 'USD',
        amountMinor: 4400,
      },
    });
  });
  return (await call(who, 'GET', `/v1/receipts/${receiptId}`)).body.expenseId;
}

/** A drive on no trip: a local expense with its purpose, and no receipt to differ from. */
async function drive(who: string, date: string, api = on): Promise<string> {
  const logged = await call(
    who,
    'POST',
    '/v1/mileage',
    { date, destination: 'Acme HQ', purpose: 'Client visit at Acme', miles: '12' },
    api,
  );
  expect(logged.status).toBe(201);
  return logged.body.id;
}

/** Puts a local expense on a report of its own, says why it was for business, and closes it. */
async function closedReportOf(who: string, expenseId: string, api = on): Promise<string> {
  const moved = await call(
    who,
    'PUT',
    `/v1/expenses/${expenseId}/report`,
    { newReport: true },
    api,
  );
  expect(moved.status).toBe(200);
  await call(
    who,
    'PUT',
    `/v1/expenses/${expenseId}/justification`,
    { justification: 'Coffee with the Acme team' },
    api,
  );
  const closed = await call(
    who,
    'POST',
    `/v1/reports/${moved.body.reportId}/close`,
    undefined,
    api,
  );
  expect(closed.status).toBe(200);
  return moved.body.reportId;
}

const riley = user('riley');
const sam = user('sam');
const casey = user('casey');

beforeAll(async () => {
  const made = await call(riley, 'POST', '/v1/me/organization');
  orgId = made.body.organization.id;
  for (const [who, role] of [
    [sam, 'member'],
    [casey, 'approver'],
  ] as const) {
    const invite = await call(riley, 'POST', '/v1/settings/people/invites', { role });
    expect(
      (await call(who, 'POST', '/v1/invites/accept', { token: invite.body.token })).status,
    ).toBe(200);
  }
});

describe('with approval off (ADR-0032)', () => {
  it('answers 404 feature_off on every route, and leaves reports, export and Needs you as they were', async () => {
    const reportId = await closedReportOf(sam, await drive(sam, '2026-09-14', off), off);
    const expenseId = newId();
    for (const [method, path, body] of [
      ['GET', `/v1/reports/${reportId}/approval`],
      ['POST', `/v1/reports/${reportId}/submit`],
      ['POST', `/v1/reports/${reportId}/approve`],
      ['POST', `/v1/reports/${reportId}/return`, { comment: 'No', rejections: [] }],
      ['GET', '/v1/approvals'],
      ['PUT', `/v1/expenses/${expenseId}/claim-reason`, { reason: 'Less' }],
    ] as const) {
      const answer = await call(sam, method, path, body, off);
      expect(answer, `${method} ${path}`).toMatchObject({
        status: 404,
        body: { code: 'feature_off' },
      });
    }
    // A closed report exports, as before approval.
    expect(
      (await call(sam, 'GET', `/v1/reports/${reportId}/export.csv`, undefined, off)).status,
    ).toBe(200);
    const inbox = await call(sam, 'GET', '/v1/inbox', undefined, off);
    expect(inbox.body.items.map((i) => i.reason.code)).not.toContain('to_approve');
    // An amount above the receipt is an edit like any other.
    const coffee = await readReceipt(sam, 'off coffee');
    const edited = await call(sam, 'PATCH', `/v1/expenses/${coffee}`, { amount: '50.00' }, off);
    expect(edited.status).toBe(200);
    expect(edited.body.claim).toBeUndefined();
  });
});

describe('submitting a report (FR-GOV-13, FR-EXP-10, Q29)', () => {
  let reportId = '';
  let coffee = '';

  it('refuses an amount above the receipt, and a submission while a lower one says nothing of why', async () => {
    coffee = await readReceipt(sam, 'coffee');
    const over = await call(sam, 'PATCH', `/v1/expenses/${coffee}`, { amount: '50.00' });
    expect(over).toMatchObject({ status: 422, body: { code: 'over_receipt' } });
    const lower = await call(sam, 'PATCH', `/v1/expenses/${coffee}`, { amount: '30.00' });
    expect(lower.status).toBe(200);
    expect(lower.body.claim).toEqual({
      reason: null,
      check: expect.objectContaining({ state: 'differs', needsReason: true, over: false }) as Check,
    });
    reportId = await closedReportOf(sam, coffee);
    const view = await call(sam, 'GET', `/v1/reports/${reportId}/approval`);
    expect(view.body).toMatchObject({
      can: { submit: false },
      why: { code: 'differs' },
      approver: { name: casey },
    });
    const refused = await call(sam, 'POST', `/v1/reports/${reportId}/submit`);
    expect(refused).toMatchObject({
      status: 409,
      body: {
        code: 'differs_from_receipt',
        expenses: [
          { expenseId: coffee, reason: 'It claims less than its receipt, and doesn’t say why.' },
        ],
      },
    });
    // Only a submitted report exports once approval exists (Q29).
    const early = await call(sam, 'GET', `/v1/reports/${reportId}/export.csv`);
    expect(early).toMatchObject({ status: 409, body: { code: 'not_submitted' } });
  });

  it('submits once the lower claim says why, keeping its category’s name as it went in', async () => {
    const reason = await call(sam, 'PUT', `/v1/expenses/${coffee}/claim-reason`, {
      reason: 'The second coffee was mine',
    });
    expect(reason).toMatchObject({ status: 200, body: { reason: 'The second coffee was mine' } });
    const catalog = (await call(sam, 'GET', '/v1/categories')).body;
    const meals = catalog.categories.find((c) => c.name === 'Meals')!.id;
    const meal = catalog.types.find((t) => t.name === 'Business meal')!.id;
    await call(sam, 'PUT', `/v1/expenses/${coffee}/category`, { categoryId: meals, typeId: meal });
    // Both changes reopened it: it closes again before it goes.
    expect((await call(sam, 'POST', `/v1/reports/${reportId}/close`)).status).toBe(200);
    const submitted = await call(sam, 'POST', `/v1/reports/${reportId}/submit`);
    expect(submitted).toMatchObject({
      status: 200,
      body: {
        status: 'in_approval',
        approver: { name: casey },
        selfAttests: false,
        expenses: [
          { id: coffee, check: { state: 'explained', explainedBy: 'reason' }, rejection: null },
        ],
      },
    });
    const renamed = await call(riley, 'PATCH', `/v1/settings/categories/${meals}`, {
      name: 'Food and drink',
    });
    expect(renamed.status).toBe(200);
    const csv = await call(sam, 'GET', `/v1/reports/${reportId}/export.csv`);
    expect(csv.status).toBe(200);
    expect(csv.text).toContain('Meals');
    expect(csv.text).not.toContain('Food and drink');
    const locked = await call(sam, 'PUT', `/v1/expenses/${coffee}/claim-reason`, { reason: 'x' });
    expect(locked).toMatchObject({ status: 409, body: { code: 'not_editable' } });
  });

  it('shows the approver what is routed to them, and asks for the second factor to approve it', async () => {
    const listed = await call(casey, 'GET', '/v1/approvals');
    expect(listed.body.reports.map((r) => r.id)).toEqual([reportId]);
    expect((await call(sam, 'GET', '/v1/approvals')).body.reports).toEqual([]);
    expect((await call(casey, 'GET', `/v1/reports/${reportId}`)).status).toBe(200);
    expect((await call(casey, 'GET', `/v1/expenses/${coffee}`)).status).toBe(200);
    const inbox = await call(casey, 'GET', '/v1/inbox');
    expect(inbox.body.items).toContainEqual(
      expect.objectContaining({ kind: 'report', reason: { code: 'to_approve' } }),
    );
    const view = await call(casey, 'GET', `/v1/reports/${reportId}/approval`);
    expect(view.body).toMatchObject({
      can: { approve: false, return: true },
      secondFactor: 'needed',
      why: { code: 'second_factor_required' },
    });
    for (const who of [casey, riley]) {
      const refused = await call(who, 'POST', `/v1/reports/${reportId}/approve`);
      expect(refused, who).toMatchObject({
        status: 403,
        body: { code: 'second_factor_required' },
      });
    }
    expect((await call(sam + AAL2, 'POST', `/v1/reports/${reportId}/approve`)).body).toMatchObject({
      code: 'not_an_approver',
    });
    const approved = await call(casey + AAL2, 'POST', `/v1/reports/${reportId}/approve`);
    expect(approved).toMatchObject({
      status: 200,
      body: { status: 'approved', steps: [{ decision: 'approved' }] },
    });
    // Approved expenses are locked.
    const edit = await call(sam, 'PATCH', `/v1/expenses/${coffee}`, { merchant: 'Changed' });
    expect(edit).toMatchObject({ status: 409, body: { code: 'locked' } });
  });
});

describe('returning a report (FR-GOV-11, FR-GOV-12)', () => {
  it('returns the whole report with a rejected expense, shown with why on it and in Needs you', async () => {
    const lunch = await drive(sam, '2026-09-15');
    const reportId = await closedReportOf(sam, lunch);
    expect((await call(sam, 'POST', `/v1/reports/${reportId}/submit`)).status).toBe(200);
    const incomplete = await call(casey, 'POST', `/v1/reports/${reportId}/return`, {
      comment: '',
      rejections: [],
    });
    expect(incomplete).toMatchObject({ status: 422, body: { code: 'invalid_value' } });
    const returned = await call(casey, 'POST', `/v1/reports/${reportId}/return`, {
      comment: 'One drive to fix, then send it again',
      rejections: [{ expenseId: lunch, reason: 'The office is not a client site' }],
    });
    expect(returned).toMatchObject({
      status: 200,
      body: {
        status: 'open',
        returned: { comment: 'One drive to fix, then send it again', by: casey },
        expenses: [
          {
            id: lunch,
            rejection: { reason: 'The office is not a client site', automatic: false },
          },
        ],
      },
    });
    const inbox = await call(sam, 'GET', '/v1/inbox');
    expect(inbox.body.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'report',
          report: expect.objectContaining({ id: reportId }) as unknown,
          reason: {
            code: 'returned',
            comment: 'One drive to fix, then send it again',
            by: casey,
          },
        }),
        expect.objectContaining({
          kind: 'expense',
          expense: expect.objectContaining({ id: lunch }) as unknown,
          reason: {
            code: 'rejected',
            why: 'The office is not a client site',
            automatic: false,
            reportId,
          },
        }),
      ]),
    );
    // Its member can change it again, and the approver waits for it to come back.
    expect((await call(casey, 'GET', '/v1/approvals')).body.reports).toEqual([]);
    const again = await call(sam, 'PUT', `/v1/expenses/${lunch}/justification`, {
      justification: 'Drive to the client site at Acme',
    });
    expect(again.status).toBe(200);
  });
});

describe('a one-person organization (FR-GOV-03)', () => {
  it('self-attests without the second factor, and says so', async () => {
    const solo = user('solo');
    expect((await call(solo, 'POST', '/v1/me/organization')).status).toBe(201);
    const reportId = await closedReportOf(solo, await drive(solo, '2026-09-16'));
    const view = await call(solo, 'GET', `/v1/reports/${reportId}/approval`);
    expect(view.body).toMatchObject({ can: { submit: true }, selfAttests: true });
    await call(solo, 'POST', `/v1/reports/${reportId}/submit`);
    const ready = await call(solo, 'GET', `/v1/reports/${reportId}/approval`);
    expect(ready.body).toMatchObject({
      can: { approve: true },
      secondFactor: 'not_needed',
      why: null,
    });
    const approved = await call(solo, 'POST', `/v1/reports/${reportId}/approve`);
    expect(approved).toMatchObject({
      status: 200,
      body: { status: 'approved', selfAttests: true },
    });
  });

  it('refuses a team member’s own report with no one else able to approve it', async () => {
    const pair = user('pair');
    expect((await call(pair, 'POST', '/v1/me/organization')).status).toBe(201);
    const partner = user('partner');
    const invite = await call(pair, 'POST', '/v1/settings/people/invites', { role: 'member' });
    await call(partner, 'POST', '/v1/invites/accept', { token: invite.body.token });
    const reportId = await closedReportOf(pair, await drive(pair, '2026-09-17'));
    const refused = await call(pair, 'POST', `/v1/reports/${reportId}/submit`);
    expect(refused).toMatchObject({ status: 409, body: { code: 'no_approver' } });
  });
});
