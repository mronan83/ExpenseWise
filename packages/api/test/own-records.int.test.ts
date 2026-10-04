/**
 * The API on a real database, as expensewise_app (GAP-20, #50, #29, ADR-0035): people join an
 * organization by invite link, and each then sees and changes only what their role allows,
 * through every member-facing store. Run with `pnpm test:integration`.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createDatabase } from '@expensewise/db';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createApi } from '../src/app.ts';
import { dbExpenseStore } from '../src/expenses.ts';
import { dbHomeStore } from '../src/home.ts';
import { dbPeopleStore } from '../src/people.ts';
import { dbReceiptStore } from '../src/receipts.ts';
import { dbReportStore } from '../src/reports.ts';
import { dbTripStore } from '../src/trips.ts';
import { dbWorkspaceStore } from '../src/workspace.ts';

declare module 'vitest' {
  export interface ProvidedContext {
    ownerUrl: string;
    appUrl: string;
    relayUrl: string;
  }
}

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

const api = createApi({
  version: 'int',
  // Signs a request in as whoever its bearer token names.
  verifyToken: (token) =>
    Promise.resolve({
      userId: token,
      email: `${token}@example.com`,
      assuranceLevel: 'aal1',
      sessionId: 's',
      issuedAt: new Date(),
    }),
  workspace: dbWorkspaceStore(db),
  receipts: dbReceiptStore(db),
  expenses: dbExpenseStore(db),
  trips: dbTripStore(db),
  home: dbHomeStore(db),
  reports: dbReportStore(db),
  people: dbPeopleStore(db),
  files,
  flagOverrides: 'team.invites=on',
});

const run = randomBytes(3).toString('hex');
const user = (name: string) => `${name}-${run}`;

interface Listed {
  readonly id: string;
  readonly email: string;
}

/** The parts of the answers these checks read. */
interface Body {
  readonly id: string;
  readonly code?: string;
  readonly token: string;
  readonly expenseId: string;
  readonly receiptId: string;
  readonly receipts: Listed[];
  readonly expenses: Listed[];
  readonly trips: Listed[];
  readonly people: Listed[];
  readonly organization: { readonly id: string };
}

async function call(who: string, method: string, path: string, body?: unknown) {
  const res = await api.request(path, {
    method,
    headers: {
      authorization: `Bearer ${who}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as Body };
}

const ids = (listed: Listed[]) => listed.map((l) => l.id);

async function join(owner: string, who: string, role: string) {
  const made = await call(owner, 'POST', '/v1/settings/people/invites', { role });
  expect(made.status).toBe(201);
  const joined = await call(who, 'POST', '/v1/invites/accept', { token: made.body.token });
  expect(joined.status).toBe(200);
}

/** A receipt filed the way the app files one: an upload ticket, then filing it. */
async function capture(who: string, bytes: string) {
  const described = {
    contentType: 'image/png',
    byteSize: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
  const ticket = await call(who, 'POST', '/v1/receipts/uploads', described);
  if (ticket.status !== 201) return ticket;
  return call(who, 'POST', '/v1/receipts', {
    id: ticket.body.receiptId,
    source: 'upload',
    ...described,
  });
}

async function workOf(who: string, place: string) {
  const filed = await capture(who, `${run} ${place}`);
  expect(filed.status).toBe(202);
  const trip = await call(who, 'POST', '/v1/trips', {
    name: place,
    startDate: '2026-09-21',
    endDate: '2026-09-23',
  });
  expect(trip.status).toBe(201);
  const receipt = await call(who, 'GET', `/v1/receipts/${filed.body.id}`);
  return { receiptId: filed.body.id, expenseId: receipt.body.expenseId, tripId: trip.body.id };
}

describe('two members of one organization, by API (GAP-20)', () => {
  const owner = user('riley');
  const alex = user('alex');
  const blair = user('blair');
  const finn = user('finn');
  const audrey = user('audrey');
  let alexWork: Awaited<ReturnType<typeof workOf>>;
  let blairWork: Awaited<ReturnType<typeof workOf>>;

  beforeAll(async () => {
    expect((await call(owner, 'POST', '/v1/me/organization')).status).toBe(201);
    await join(owner, alex, 'member');
    await join(owner, blair, 'member');
    await join(owner, finn, 'finance_admin');
    await join(owner, audrey, 'auditor');
    alexWork = await workOf(alex, 'Omaha');
    blairWork = await workOf(blair, 'Houston');
  });

  it("can't see each other's receipts, expenses or trips", async () => {
    const receipts = await call(alex, 'GET', '/v1/receipts');
    expect(ids(receipts.body.receipts)).toEqual([alexWork.receiptId]);
    const expenses = await call(alex, 'GET', '/v1/expenses');
    expect(ids(expenses.body.expenses)).toEqual([alexWork.expenseId]);
    const trips = await call(alex, 'GET', '/v1/trips');
    expect(ids(trips.body.trips)).toEqual([alexWork.tripId]);
    for (const path of [
      `/v1/receipts/${blairWork.receiptId}`,
      `/v1/expenses/${blairWork.expenseId}`,
      `/v1/trips/${blairWork.tripId}`,
    ]) {
      expect((await call(alex, 'GET', path)).status, path).toBe(404);
    }
  });

  it("can't change each other's receipts, expenses or trips", async () => {
    const attempts: [string, string, unknown?][] = [
      ['PATCH', `/v1/trips/${blairWork.tripId}`, { name: 'Changed by alex' }],
      ['DELETE', `/v1/trips/${blairWork.tripId}`],
      ['PATCH', `/v1/expenses/${blairWork.expenseId}`, { merchant: 'Changed by alex' }],
      ['POST', `/v1/receipts/${blairWork.receiptId}/read`],
    ];
    for (const [method, path, body] of attempts) {
      expect((await call(alex, method, path, body)).status, `${method} ${path}`).toBe(404);
    }
    const trip = await call(blair, 'GET', `/v1/trips/${blairWork.tripId}`);
    expect(trip).toMatchObject({ status: 200, body: { name: 'Houston' } });
  });

  it('refuses the same file a colleague filed, without showing theirs', async () => {
    const again = await capture(blair, `${run} Omaha`);
    expect(again).toMatchObject({ status: 409, body: { code: 'duplicate_receipt' } });
    expect(again.body).not.toHaveProperty('receiptId');
    expect(removed).toHaveLength(1);
  });

  it("lets a finance admin open both members' records, and change neither", async () => {
    for (const path of [
      `/v1/receipts/${alexWork.receiptId}`,
      `/v1/expenses/${blairWork.expenseId}`,
      `/v1/trips/${alexWork.tripId}`,
      `/v1/trips/${blairWork.tripId}`,
    ]) {
      expect((await call(finn, 'GET', path)).status, path).toBe(200);
    }
    const edit = await call(finn, 'PATCH', `/v1/trips/${alexWork.tripId}`, { name: 'Fixed' });
    expect(edit).toMatchObject({ status: 403, body: { code: 'not_yours' } });
    const reread = await call(finn, 'POST', `/v1/receipts/${blairWork.receiptId}/read`);
    expect(reread).toMatchObject({ status: 403, body: { code: 'not_yours' } });
    // Their own lists are their own.
    expect((await call(finn, 'GET', '/v1/receipts')).body.receipts).toEqual([]);
  });

  it('lets an auditor read every record and change nothing', async () => {
    expect((await call(audrey, 'GET', `/v1/receipts/${blairWork.receiptId}`)).status).toBe(200);
    expect((await call(audrey, 'GET', `/v1/trips/${alexWork.tripId}`)).status).toBe(200);
    const trip = await call(audrey, 'POST', '/v1/trips', {
      name: 'Audit visit',
      startDate: '2026-10-01',
      endDate: '2026-10-02',
    });
    expect(trip).toMatchObject({ status: 403, body: { code: 'not_yours' } });
    const upload = await capture(audrey, `${run} audit`);
    expect(upload).toMatchObject({ status: 403, body: { code: 'not_yours' } });
    const remove = await call(audrey, 'DELETE', `/v1/trips/${blairWork.tripId}`);
    expect(remove).toMatchObject({ status: 403, body: { code: 'not_yours' } });
  });

  it('lets the owner remove a member, who then reaches nothing, with their records kept', async () => {
    const people = await call(owner, 'GET', '/v1/settings/people');
    const blairId = people.body.people.find((p) => p.email.startsWith(blair))?.id;
    expect((await call(owner, 'DELETE', `/v1/settings/people/${blairId}`)).status).toBe(204);
    expect((await call(blair, 'GET', '/v1/trips')).body).toMatchObject({
      code: 'no_organization',
    });
    expect((await call(owner, 'GET', `/v1/trips/${blairWork.tripId}`)).status).toBe(200);
  });
});

describe('a one-person organization, by API', () => {
  it('works for its owner as before, and joining another replaces it while it is empty', async () => {
    const solo = user('solo');
    expect((await call(solo, 'POST', '/v1/me/organization')).status).toBe(201);
    const work = await workOf(solo, 'Chicago');
    expect((await call(solo, 'GET', '/v1/receipts')).body.receipts).toHaveLength(1);
    const edited = await call(solo, 'PATCH', `/v1/trips/${work.tripId}`, { purpose: 'Visit' });
    expect(edited.status).toBe(200);
    expect((await call(solo, 'DELETE', `/v1/trips/${work.tripId}`)).status).toBe(204);

    // Someone whose first sign-in made an empty organization joins another by link.
    const newcomer = user('newcomer');
    expect((await call(newcomer, 'POST', '/v1/me/organization')).status).toBe(201);
    const made = await call(solo, 'POST', '/v1/settings/people/invites', { role: 'member' });
    const preview = await call(newcomer, 'POST', '/v1/invites/look-up', { token: made.body.token });
    expect(preview.body).toMatchObject({ state: 'pending', standing: 'empty', role: 'member' });
    expect(
      (await call(newcomer, 'POST', '/v1/invites/accept', { token: made.body.token })).status,
    ).toBe(200);
    const theirs = await call(newcomer, 'GET', `/v1/receipts/${work.receiptId}`);
    expect(theirs.status).toBe(404);
    const mine = await call(newcomer, 'POST', '/v1/me/organization');
    expect(mine.body.organization.id).toBe(preview.body.organization.id);

    // Someone with work of their own can't be pulled into another organization.
    const other = user('other');
    expect((await call(other, 'POST', '/v1/me/organization')).status).toBe(201);
    const made2 = await call(other, 'POST', '/v1/settings/people/invites', { role: 'member' });
    const refused = await call(solo, 'POST', '/v1/invites/accept', { token: made2.body.token });
    expect(refused).toMatchObject({ status: 409, body: { code: 'has_own_organization' } });
    expect((await call(solo, 'GET', '/v1/receipts')).body.receipts).toHaveLength(1);
  });
});
