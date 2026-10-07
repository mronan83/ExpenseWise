/**
 * Deleting a receipt filed by mistake by API, on a real database as expensewise_app
 * (FR-CAP-11, US-CAP-09, ADR-0028). Run with `pnpm test:integration`.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createDatabase, settleReceipt, withOrg } from '@expensewise/db';
import { newId } from '@expensewise/domain';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createApi } from '../src/app.ts';
import { dbAuditStore } from '../src/audit.ts';
import { dbExpenseStore } from '../src/expenses.ts';
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
    workspace: dbWorkspaceStore(db),
    receipts: dbReceiptStore(db),
    expenses: dbExpenseStore(db),
    reports: dbReportStore(db),
    people: dbPeopleStore(db),
    audit: dbAuditStore(db),
    files,
    flagOverrides,
  });
const on = apiWith('team.invites=on,receipts.delete=on,governance.audit-trail=on');
const off = apiWith('team.invites=on');

const run = randomBytes(3).toString('hex');
const user = (name: string) => `${name}-${run}`;

interface Body {
  readonly id: string;
  readonly code?: string;
  readonly token: string;
  readonly organization: { readonly id: string };
  readonly expenseId: string;
  readonly receiptId: string;
  readonly deleted: string;
  readonly items: { readonly kind: string; readonly receipt?: { readonly id: string } }[];
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
/** A flight confirmation forwarded as a receipt: read, with no amounts, so it needs a look. */
async function confirmationFor(who: string): Promise<{ receiptId: string; expenseId: string }> {
  const bytes = `${run} ${who} ${newId()}`;
  const described = {
    contentType: 'application/pdf',
    byteSize: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
  const ticket = await call(who, 'POST', '/v1/receipts/uploads', described);
  const filed = await call(who, 'POST', '/v1/receipts', {
    id: ticket.body.receiptId,
    source: 'upload',
    ...described,
  });
  expect(filed.status).toBe(202);
  const receiptId = filed.body.id;
  await withOrg(db, orgId, (tx) =>
    settleReceipt(tx, orgId, receiptId, {
      status: 'needs_review',
      requestId: newId(),
      detail: {},
      values: {
        merchant: 'Delta Air Lines',
        transactionDate: '2026-10-14',
        currency: null,
        amountMinor: null,
      },
    }),
  );
  const { expenseId } = (await call(who, 'GET', `/v1/receipts/${receiptId}`)).body;
  return { receiptId, expenseId };
}

const owner = user('riley');
const sam = user('sam');
const audrey = user('audrey');

beforeAll(async () => {
  orgId = (await call(owner, 'POST', '/v1/me/organization')).body.organization.id;
  for (const [who, role] of [
    [sam, 'member'],
    [audrey, 'auditor'],
  ] as const) {
    const invite = await call(owner, 'POST', '/v1/settings/people/invites', { role });
    expect(
      (await call(who, 'POST', '/v1/invites/accept', { token: invite.body.token })).status,
    ).toBe(200);
  }
});

describe('deleting a receipt filed by mistake (FR-CAP-11, US-CAP-09)', () => {
  it('is off until switched on', async () => {
    const { receiptId } = await confirmationFor(owner);
    expect(await call(owner, 'DELETE', `/v1/receipts/${receiptId}`, undefined, off)).toMatchObject({
      status: 404,
      body: { code: 'feature_off' },
    });
  });

  it('deletes the person’s own receipt, its expense and its file, and Needs you lets it go (AC1)', async () => {
    const { receiptId, expenseId } = await confirmationFor(owner);
    const inbox = async () =>
      (await call(owner, 'GET', '/v1/inbox')).body.items.map((i) => i.receipt?.id);
    expect(await inbox()).toContain(receiptId);

    expect(await call(owner, 'DELETE', `/v1/receipts/${receiptId}`)).toEqual({
      status: 200,
      body: { deleted: receiptId },
    });
    expect(removed).toContain(`orgs/${orgId}/receipts/${receiptId}`);
    expect((await call(owner, 'GET', `/v1/receipts/${receiptId}`)).status).toBe(404);
    expect((await call(owner, 'GET', `/v1/expenses/${expenseId}`)).status).toBe(404);
    expect(await inbox()).not.toContain(receiptId);
    expect((await call(owner, 'DELETE', `/v1/receipts/${receiptId}`)).status).toBe(404);
  });

  it('lets only its own member delete it, never an auditor (AC3)', async () => {
    const { receiptId } = await confirmationFor(sam);
    // The owner sees Sam's receipt but doesn't change it; an auditor changes nothing.
    for (const who of [owner, audrey]) {
      expect(await call(who, 'DELETE', `/v1/receipts/${receiptId}`), who).toMatchObject({
        status: 403,
        body: { code: 'not_yours' },
      });
    }
    expect((await call(sam, 'DELETE', `/v1/receipts/${receiptId}`)).status).toBe(200);
  });

  it('keeps the deletion in the audit trail, with what it was (AC4)', async () => {
    const { receiptId } = await confirmationFor(owner);
    await call(owner, 'DELETE', `/v1/receipts/${receiptId}`);
    const trail = await call(owner, 'GET', `/v1/audit/events?entityId=${receiptId}`);
    expect(JSON.stringify(trail.body)).toContain('receipt.deleted');
    expect(JSON.stringify(trail.body)).toContain('Delta Air Lines');
  });
});
