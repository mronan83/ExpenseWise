/**
 * Card statements by API on a real database as expensewise_app: a downloaded list brought in
 * and matched, missing receipts in Needs you, set aside, matched by hand, a PDF filed to be read
 * and a statement that needs a look (FR-CAP-10, FR-INT-24, US-CAP-07, ADR-0046). Run with
 * `pnpm test:integration`.
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  createDatabase,
  settleCardStatement,
  settleReceipt,
  withOrg,
  type CommittedEvent,
} from '@expensewise/db';
import { money, newId } from '@expensewise/domain';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createApi } from '../src/app.ts';
import { dbCardStore } from '../src/card-statements.ts';
import { dbExpenseStore } from '../src/expenses.ts';
import { dbOrganizationStore } from '../src/organization.ts';
import { dbPeopleStore } from '../src/people.ts';
import { dbReceiptStore } from '../src/receipts.ts';
import { dbReportStore } from '../src/reports.ts';
import { dbWorkspaceStore } from '../src/workspace.ts';

const { db, pool } = createDatabase(inject('appUrl'));
afterAll(async () => {
  await pool.end();
});

const removed: string[] = [];
const files = {
  signedUpload: (path: string) => Promise.resolve({ path, token: 'test' }),
  signedDownloadUrl: (path: string) => Promise.resolve(`https://files.test/${path}`),
  download: () => Promise.resolve(null),
  save: () => Promise.resolve(),
  remove: (path: string) => {
    removed.push(path);
    return Promise.resolve();
  },
};
const dispatched: CommittedEvent[] = [];

const stores = {
  workspace: dbWorkspaceStore(db),
  organization: dbOrganizationStore(db),
  receipts: dbReceiptStore(db),
  expenses: dbExpenseStore(db),
  reports: dbReportStore(db),
  people: dbPeopleStore(db),
  cards: dbCardStore(db),
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
    dispatch: (events) => {
      dispatched.push(...events);
      return Promise.resolve();
    },
    flagOverrides,
  });
const on = apiWith('team.invites=on,expenses.card-statements=on');
const paidOn = apiWith('team.invites=on,expenses.card-statements=on,expenses.company-paid=on');
const off = apiWith('team.invites=on');

const run = randomBytes(3).toString('hex');
const user = (name: string) => `${name}-${run}`;

interface Amount {
  readonly amountMinor: number;
  readonly currency: string;
  readonly decimal: string;
}
interface Transaction {
  readonly id: string;
  readonly statementId: string;
  readonly transactionDate: string;
  readonly merchant: string;
  readonly amount: Amount;
  readonly state: string;
  readonly expense: { readonly id: string } | null;
  readonly matchedBy: string | null;
  readonly setAside: { readonly reason: string; readonly note: string | null } | null;
}
/** The parts of the answers these checks read. */
interface Body {
  readonly code?: string;
  readonly field?: string;
  readonly token: string;
  readonly organization: { readonly id: string };
  readonly expenseId: string;
  readonly statementId: string;
  readonly path: string;
  readonly added: number;
  readonly matched: number;
  readonly skipped: number;
  readonly statements: {
    readonly id: string;
    readonly source: string;
    readonly status: string;
    readonly problem: string | null;
  }[];
  readonly transactions: Transaction[];
  readonly missing: number;
  readonly expenses: { readonly id: string; readonly merchant: string | null }[];
  readonly items: {
    readonly kind: string;
    readonly transaction?: { readonly id: string };
    readonly statement?: { readonly id: string };
  }[];
  readonly url?: string;
  readonly paidBy?: string;
  readonly paidByPinned?: boolean;
  readonly cardCharges?: {
    readonly id: string;
    readonly amount: Amount;
    readonly matchedBy: string;
  }[];
  readonly amount: Amount | null;
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
  return { status: res.status, body: (text && json ? JSON.parse(text) : null) as Body };
}

let orgId = '';
/** A receipt filed the way the app files one, then read as the workflow reads it. */
async function expenseFor(
  who: string,
  offer: { merchant: string; transactionDate: string; amountMinor: number; currency?: string },
): Promise<string> {
  const bytes = `${run} ${who} ${offer.merchant} ${offer.amountMinor}`;
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
  const receiptId = (filed.body as unknown as { id: string }).id;
  await withOrg(db, orgId, (tx) =>
    settleReceipt(tx, orgId, receiptId, {
      status: 'extracted',
      requestId: newId(),
      detail: {},
      values: { currency: 'USD', ...offer },
    }),
  );
  return (await call(who, 'GET', `/v1/receipts/${receiptId}`)).body.expenseId;
}

const owner = user('riley');
const sam = user('sam');
const audrey = user('audrey');

/** U.S. Bank's transaction list, as Access Online downloads it. */
const LIST = [
  'Transaction Date,Posting Date,Merchant Name,Amount,Card Number',
  '09/12/2026,09/14/2026,DELTA AIR 0062345678901 ATLANTA GA,402.20,XXXXXXXXXXXX4417',
  '09/27/2026,09/28/2026,LYFT *RIDE SUN 8AM,18.40,XXXXXXXXXXXX4417',
  '09/20/2026,09/21/2026,DELTA AIR CREDIT,-25.00,XXXXXXXXXXXX4417',
  '09/25/2026,09/25/2026,PAYMENT - THANK YOU,-1000.00,XXXXXXXXXXXX4417',
].join('\n');

let lyft = '';
beforeAll(async () => {
  const made = await call(owner, 'POST', '/v1/me/organization');
  orgId = made.body.organization.id;
  for (const [who, role] of [
    [sam, 'member'],
    [audrey, 'auditor'],
  ] as const) {
    const invite = await call(owner, 'POST', '/v1/settings/people/invites', { role });
    expect(
      (await call(who, 'POST', '/v1/invites/accept', { token: invite.body.token })).status,
    ).toBe(200);
  }
  lyft = await expenseFor(owner, {
    merchant: 'Lyft',
    transactionDate: '2026-09-27',
    amountMinor: 1840,
  });
});

const charge = (body: Body, merchant: string) =>
  body.transactions.find((t) => t.merchant.startsWith(merchant))!;

describe('with card statements off (US-CAP-07 AC9)', () => {
  it('answers feature_off on every route, and Needs you and expenses read as before', async () => {
    const id = newId();
    const attempts: [string, string, unknown?][] = [
      ['POST', '/v1/card-statements/uploads', { byteSize: 10, sha256: 'a'.repeat(64) }],
      ['POST', '/v1/card-statements', { id, byteSize: 10, sha256: 'a'.repeat(64) }],
      ['POST', '/v1/card-statements/lists', { text: LIST }],
      ['GET', '/v1/card-statements'],
      ['POST', `/v1/card-statements/${id}/confirm`],
      ['DELETE', `/v1/card-statements/${id}`],
      ['POST', '/v1/card-statements/match'],
      ['PUT', `/v1/card-transactions/${id}/set-aside`, { reason: 'personal' }],
      ['DELETE', `/v1/card-transactions/${id}/set-aside`],
      ['PUT', `/v1/card-transactions/${id}/expense`, { expenseId: lyft }],
      ['DELETE', `/v1/card-transactions/${id}/expense`],
      ['GET', `/v1/card-transactions/${id}/expenses`],
    ];
    for (const [method, path, body] of attempts) {
      expect(await call(owner, method, path, body, off), `${method} ${path}`).toMatchObject({
        status: 404,
        body: { code: 'feature_off' },
      });
    }
  });
});

describe('a downloaded list (US-CAP-07 AC6, AC2, AC3)', () => {
  it('keeps each charge and credit, leaves the payment out, and matches the charge it can', async () => {
    const brought = await call(owner, 'POST', '/v1/card-statements/lists', { text: LIST });
    expect(brought).toMatchObject({ status: 201, body: { added: 3, matched: 1, skipped: 1 } });

    const shown = (await call(owner, 'GET', '/v1/card-statements')).body;
    expect(shown.statements).toMatchObject([{ source: 'list', status: 'read', problem: null }]);
    expect(shown.missing).toBe(1);
    expect(charge(shown, 'LYFT')).toMatchObject({
      state: 'matched',
      matchedBy: 'auto',
      expense: { id: lyft },
      amount: { amountMinor: 1840, currency: 'USD', decimal: '18.40' },
    });
    expect(charge(shown, 'DELTA AIR 006')).toMatchObject({ state: 'missing', expense: null });
    expect(charge(shown, 'DELTA AIR CREDIT')).toMatchObject({ state: 'credit' });

    // The company's card paid it, so it is the company's and never claimed (FR-INT-25).
    expect(
      (await call(owner, 'GET', `/v1/expenses/${lyft}`, undefined, paidOn)).body,
    ).toMatchObject({ paidBy: 'company', paidByPinned: false });

    // The expense shows the charge that paid for it; with the feature off, it doesn't.
    expect((await call(owner, 'GET', `/v1/expenses/${lyft}`)).body.cardCharges).toMatchObject([
      { matchedBy: 'auto', amount: { amountMinor: 1840 } },
    ]);
    expect(
      (await call(owner, 'GET', `/v1/expenses/${lyft}`, undefined, off)).body,
    ).not.toHaveProperty('cardCharges');

    // The missing receipt is in Needs you, and only while the feature is on.
    const delta = charge(shown, 'DELTA AIR 006').id;
    const inbox = (await call(owner, 'GET', '/v1/inbox')).body.items;
    expect(inbox.filter((i) => i.kind === 'card').map((i) => i.transaction?.id)).toEqual([delta]);
    expect(
      (await call(owner, 'GET', '/v1/inbox', undefined, off)).body.items.some(
        (i) => i.kind === 'card',
      ),
    ).toBe(false);

    // The same list again changes nothing (AC4).
    expect(await call(owner, 'POST', '/v1/card-statements/lists', { text: LIST })).toMatchObject({
      status: 200,
      body: { statementId: brought.body.statementId, added: 0 },
    });
  });

  it('says plainly when a file isn’t a transaction list', async () => {
    expect(
      await call(owner, 'POST', '/v1/card-statements/lists', { text: 'Name,Email\nRiley,r@x.com' }),
    ).toMatchObject({ status: 422, body: { code: 'no_columns' } });
  });
});

describe('a charge with no expense (US-CAP-07 AC3)', () => {
  it('is set aside with a reason, which other needs a note for, and brought back', async () => {
    const delta = charge((await call(owner, 'GET', '/v1/card-statements')).body, 'DELTA AIR 006');
    const path = `/v1/card-transactions/${delta.id}/set-aside`;
    expect(await call(owner, 'PUT', path, { reason: 'other' })).toMatchObject({
      status: 422,
      body: { code: 'note_needed', field: 'note' },
    });
    const aside = await call(owner, 'PUT', path, { reason: 'personal' });
    expect(aside.status).toBe(200);
    expect(charge(aside.body, 'DELTA AIR 006')).toMatchObject({
      state: 'set_aside',
      setAside: { reason: 'personal', note: null },
    });
    expect(aside.body.missing).toBe(0);
    expect((await call(owner, 'GET', '/v1/inbox')).body.items.some((i) => i.kind === 'card')).toBe(
      false,
    );
    // Set aside, it can't be matched until it is brought back.
    expect(
      await call(owner, 'PUT', `/v1/card-transactions/${delta.id}/expense`, { expenseId: lyft }),
    ).toMatchObject({ status: 409, body: { code: 'set_aside' } });
    const back = await call(owner, 'DELETE', path);
    expect(charge(back.body, 'DELTA AIR 006').state).toBe('missing');
  });

  it('is matched by hand to an expense for another amount, and let go again', async () => {
    const fare = await expenseFor(owner, {
      merchant: 'Delta',
      transactionDate: '2026-09-12',
      amountMinor: 39_420,
    });
    const delta = charge((await call(owner, 'GET', '/v1/card-statements')).body, 'DELTA AIR 006');
    // Different amounts never match on their own.
    expect(
      charge((await call(owner, 'GET', '/v1/card-statements')).body, 'DELTA AIR 006').state,
    ).toBe('missing');
    const offered = await call(owner, 'GET', `/v1/card-transactions/${delta.id}/expenses`);
    expect(offered.body.expenses.map((e) => e.id)).toContain(fare);
    expect(offered.body.expenses.map((e) => e.id)).not.toContain(lyft);
    expect(offered.body.expenses.find((e) => e.id === fare)).toMatchObject({ charged: null });

    const path = `/v1/card-transactions/${delta.id}/expense`;
    const matched = await call(owner, 'PUT', path, { expenseId: fare });
    expect(charge(matched.body, 'DELTA AIR 006')).toMatchObject({
      state: 'matched',
      matchedBy: 'person',
      expense: { id: fare },
    });
    expect((await call(owner, 'GET', `/v1/expenses/${fare}`)).body.cardCharges).toMatchObject([
      { matchedBy: 'person', amount: { amountMinor: 40_220 } },
    ]);
    // Still offered, with what its charges now come to, so another can join it (AC12).
    expect(
      (await call(owner, 'GET', `/v1/card-transactions/${delta.id}/expenses`)).body.expenses.find(
        (e) => e.id === fare,
      ),
    ).toMatchObject({ charged: { amountMinor: 40_220, currency: 'USD' } });
    const let_go = await call(owner, 'DELETE', path);
    expect(charge(let_go.body, 'DELTA AIR 006')).toMatchObject({ state: 'missing', expense: null });
  });
});

describe('a ride and its tip, charged apart (US-CAP-07 AC13)', () => {
  it('matches both to the one receipt on its own, and shows each on the expense', async () => {
    const ride = await expenseFor(owner, {
      merchant: 'Uber',
      transactionDate: '2026-09-29',
      amountMinor: 2411,
    });
    const list = [
      'Date,Description,Amount',
      '2026-09-29,UBER *TRIP HELP.UBER.COM CA,21.11',
      '2026-09-29,UBER *TRIP HELP.UBER.COM CA,3.00',
    ].join('\n');
    expect(await call(owner, 'POST', '/v1/card-statements/lists', { text: list })).toMatchObject({
      status: 201,
      body: { added: 2, matched: 2 },
    });
    const shown = (await call(owner, 'GET', `/v1/expenses/${ride}`)).body;
    expect(shown.cardCharges?.map((c) => [c.amount.amountMinor, c.matchedBy])).toEqual([
      [2111, 'auto'],
      [300, 'auto'],
    ]);
  });
});

describe('a charge abroad (US-CAP-07 AC7)', () => {
  it('shows the dollars the card was charged on an expense in euros, whose own amount stays', async () => {
    const fare = await expenseFor(owner, {
      merchant: 'Lufthansa',
      transactionDate: '2026-09-27',
      amountMinor: 41_280,
      currency: 'EUR',
    });
    const list = [
      'Date,Description,Amount',
      '2026-09-27,LUFTHANSA 2201234567890 FRANKFURT,483.94',
    ].join('\n');
    // A charge in dollars never matches an expense in euros on its own.
    expect(await call(owner, 'POST', '/v1/card-statements/lists', { text: list })).toMatchObject({
      status: 201,
      body: { added: 1, matched: 0 },
    });
    const charge = (await call(owner, 'GET', '/v1/card-statements')).body.transactions.find((t) =>
      t.merchant.startsWith('LUFTHANSA'),
    )!;
    await call(owner, 'PUT', `/v1/card-transactions/${charge.id}/expense`, { expenseId: fare });
    const shown = (await call(owner, 'GET', `/v1/expenses/${fare}`)).body;
    expect(shown.cardCharges).toMatchObject([
      { amount: { amountMinor: 48_394, currency: 'USD', decimal: '483.94' }, matchedBy: 'person' },
    ]);
    expect(shown.amount).toMatchObject({ amountMinor: 41_280, currency: 'EUR' });
  });
});

describe('whose statements they are (US-CAP-07 AC8, ADR-0035)', () => {
  it('shows each member only their own, and an auditor brings none in', async () => {
    expect((await call(sam, 'GET', '/v1/card-statements')).body).toMatchObject({
      statements: [],
      transactions: [],
      missing: 0,
    });
    const delta = charge((await call(owner, 'GET', '/v1/card-statements')).body, 'DELTA AIR 006');
    expect(
      await call(sam, 'PUT', `/v1/card-transactions/${delta.id}/set-aside`, { reason: 'personal' }),
    ).toMatchObject({ status: 404 });
    expect(await call(audrey, 'POST', '/v1/card-statements/lists', { text: LIST })).toMatchObject({
      status: 403,
      body: { code: 'not_yours' },
    });
    expect(
      await call(audrey, 'POST', '/v1/card-statements/uploads', {
        byteSize: 10,
        sha256: 'b'.repeat(64),
      }),
    ).toMatchObject({ status: 403 });
  });
});

describe('a statement PDF (US-CAP-07 AC1, AC5)', () => {
  const pdf = { byteSize: 52_000, sha256: createHash('sha256').update(`${run} pdf`).digest('hex') };

  it('is uploaded beside receipts, filed, and handed on to be read', async () => {
    const ticket = await call(owner, 'POST', '/v1/card-statements/uploads', pdf);
    expect(ticket.status).toBe(201);
    expect(ticket.body.path).toBe(`orgs/${orgId}/statements/${ticket.body.statementId}`);
    const filed = await call(owner, 'POST', '/v1/card-statements', {
      id: ticket.body.statementId,
      ...pdf,
    });
    expect(filed.status).toBe(202);
    expect(filed.body.statements[0]).toMatchObject({
      id: ticket.body.statementId,
      source: 'upload',
      status: 'reading',
    });
    expect(dispatched.at(-1)).toMatchObject({
      topic: 'card_statement.filed',
      payload: { statementId: ticket.body.statementId },
    });
    // Retried, it is the same statement; the same PDF under another upload is too, and that
    // copy's file is removed.
    expect(
      (await call(owner, 'POST', '/v1/card-statements', { id: ticket.body.statementId, ...pdf }))
        .status,
    ).toBe(200);
    const again = await call(owner, 'POST', '/v1/card-statements/uploads', pdf);
    expect(
      (await call(owner, 'POST', '/v1/card-statements', { id: again.body.statementId, ...pdf }))
        .status,
    ).toBe(200);
    expect(removed).toContain(`orgs/${orgId}/statements/${again.body.statementId}`);
  });

  it('holds a statement whose lines miss its totals until it is confirmed, then matches it', async () => {
    const statementId = (await call(owner, 'GET', '/v1/card-statements')).body.statements.find(
      (s) => s.source === 'upload',
    )!.id;
    const hotel = await expenseFor(owner, {
      merchant: 'Hotel Lindley',
      transactionDate: '2026-10-01',
      amountMinor: 110_400,
    });
    const usd = (cents: number) => money(cents, 'USD');
    await withOrg(db, orgId, (tx) =>
      settleCardStatement(tx, orgId, statementId, {
        status: 'needs_look',
        problem: 'Its charges come to $1,104.00, but it prints $1,204.00.',
        cardLastFour: '4417',
        periodStart: '2026-09-29',
        periodEnd: '2026-10-28',
        currency: 'USD',
        charges: usd(120_400),
        credits: null,
        transactions: [
          {
            transactionDate: '2026-10-01',
            postedOn: '2026-10-02',
            merchant: 'HOTEL LINDLEY CHICAGO IL',
            amount: usd(110_400),
            cardLastFour: '4417',
            reference: null,
          },
        ],
        model: 'claude-sonnet-5-5',
        version: 'statement-v1',
        costNanoUsd: 41_000_000,
      }),
    );
    const held = (await call(owner, 'GET', '/v1/card-statements')).body;
    expect(held.statements.find((s) => s.id === statementId)).toMatchObject({
      status: 'needs_look',
      problem: 'Its charges come to $1,104.00, but it prints $1,204.00.',
    });
    expect(charge(held, 'HOTEL')).toMatchObject({ state: 'waiting', expense: null });

    // It waits in Needs you, saying what doesn't add up (AC14).
    expect(
      (await call(owner, 'GET', '/v1/inbox')).body.items.find((i) => i.kind === 'card_statement'),
    ).toMatchObject({
      statement: {
        id: statementId,
        problem: 'Its charges come to $1,104.00, but it prints $1,204.00.',
      },
      reason: { code: 'statement_needs_look' },
    });
    // Its PDF opens by a short-lived link to check its lines against (AC15); a list keeps none.
    expect(await call(owner, 'GET', `/v1/card-statements/${statementId}/file`)).toMatchObject({
      status: 200,
      body: {
        url: `https://files.test/orgs/${orgId}/statements/${statementId}`,
        expiresInSeconds: 300,
      },
    });
    const brought = await call(owner, 'POST', '/v1/card-statements/lists', {
      text: 'Date,Description,Amount\n2026-10-03,PARKING OMAHA NE,7.00',
    });
    expect(brought.status).toBe(201);
    const listId = (brought.body as unknown as { statementId: string }).statementId;
    expect(await call(owner, 'GET', `/v1/card-statements/${listId}/file`)).toMatchObject({
      status: 404,
      body: { code: 'no_file' },
    });

    const confirmed = await call(owner, 'POST', `/v1/card-statements/${statementId}/confirm`);
    expect(charge(confirmed.body, 'HOTEL')).toMatchObject({
      state: 'matched',
      matchedBy: 'auto',
      expense: { id: hotel },
    });
    expect(await call(owner, 'POST', `/v1/card-statements/${statementId}/confirm`)).toMatchObject({
      status: 409,
      body: { code: 'not_waiting' },
    });
    // Looked at, it leaves Needs you.
    expect(
      (await call(owner, 'GET', '/v1/inbox')).body.items.some((i) => i.kind === 'card_statement'),
    ).toBe(false);

    // Deleted as brought in by mistake: its transactions go, and its file.
    const gone = await call(owner, 'DELETE', `/v1/card-statements/${statementId}`);
    expect(gone.body.statements.some((s) => s.id === statementId)).toBe(false);
    expect(gone.body.transactions.some((t) => t.statementId === statementId)).toBe(false);
    expect(removed).toContain(`orgs/${orgId}/statements/${statementId}`);
    expect((await call(owner, 'GET', `/v1/expenses/${hotel}`)).body).not.toHaveProperty(
      'cardCharges',
    );
  });
});
