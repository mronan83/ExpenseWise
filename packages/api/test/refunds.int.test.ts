/**
 * Refunds by API, on a real database as expensewise_app (FR-EXP-21, Q59, Q60, ADR-0054): a
 * receipt read below zero is confirmed with Looks right, waits in Needs you counting in no
 * claim, and is paired with the purchase it refunds. A bearer token signs in as the person it
 * names. Run with `pnpm test:integration`.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createDatabase, recordExtractionRun, settleReceipt, withOrg } from '@expensewise/db';
import { newId } from '@expensewise/domain';
import { COMPARISON_MODELS } from '@expensewise/extraction';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createApi } from '../src/app.ts';
import { dbExpenseStore } from '../src/expenses.ts';
import { dbReceiptStore } from '../src/receipts.ts';
import { dbRefundStore } from '../src/refunds.ts';
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

const api = createApi({
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
  refunds: dbRefundStore(db),
  files,
});

const run = randomBytes(3).toString('hex');
const riley = `riley-${run}`;
const MODEL = COMPARISON_MODELS[1];

interface Link {
  readonly id: string;
  readonly amount: { readonly decimal: string } | null;
}
/** The parts of the answers these checks read. */
interface Body {
  readonly id: string;
  readonly code?: string;
  readonly status: string;
  readonly expenseId: string;
  readonly organization: { readonly id: string };
  readonly refund?: { readonly of: Link | null; readonly refunds: Link[] };
  readonly candidates: (Link & { readonly left: { readonly decimal: string } })[];
  readonly items: {
    readonly kind: string;
    readonly expense?: { readonly id: string };
    readonly reason: { readonly code: string };
  }[];
}

async function call(method: string, path: string, body?: unknown) {
  const res = await api.request(path, {
    method,
    headers: {
      authorization: `Bearer ${riley}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as Body };
}

let orgId = '';
/** A receipt filed as the app files one, then read as this total: Ready, or a refund's look. */
async function readReceipt(merchant: string, date: string, total: string, currency = 'USD') {
  const bytes = `${run} ${merchant} ${date} ${total} ${currency}`;
  const described = {
    contentType: 'image/png',
    byteSize: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
  const ticket = await call('POST', '/v1/receipts/uploads', described);
  const filed = await call('POST', '/v1/receipts', {
    id: (ticket.body as unknown as { receiptId: string }).receiptId,
    source: 'upload',
    ...described,
  });
  expect(filed.status).toBe(202);
  const receiptId = filed.body.id;
  const requestId = newId();
  const amountMinor = Math.round(Number(total) * 100);
  await withOrg(db, orgId, async (tx) => {
    await recordExtractionRun(tx, orgId, {
      receiptId,
      requestId,
      extractor: 'claude',
      model: MODEL,
      promptVersion: 'extract-v3',
      schemaVersion: 'receipt-v3',
      outcome: 'confident',
      output: {
        documentType: 'receipt',
        merchant: { name: merchant, confidence: 'high' },
        date: { value: date, confidence: 'high' },
        currency: { code: currency, confidence: 'high' },
        total: { value: total, confidence: 'high' },
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
      status: amountMinor < 0 ? 'needs_review' : 'extracted',
      requestId,
      detail: {},
      values: { merchant, transactionDate: date, currency, amountMinor },
    });
  });
  const shown = await call('GET', `/v1/receipts/${receiptId}`);
  return { receiptId, expenseId: shown.body.expenseId };
}

beforeAll(async () => {
  orgId = (await call('POST', '/v1/me/organization')).body.organization.id;
});

describe('a refund by API (FR-EXP-21)', () => {
  it('confirms a refund with Looks right, and pairs it with the purchase it refunds', async () => {
    const order = await readReceipt('Amazon.com', '2026-09-24', '54.20');
    await readReceipt('Amazon.com', '2026-09-25', '54.20', 'EUR');
    const refund = await readReceipt('Amazon.com', '2026-10-02', '-54.20');

    // Looks right on a reading below zero was refused as "zero or more"; it files a refund.
    const confirmed = await call('POST', `/v1/receipts/${refund.receiptId}/confirm`, {
      model: MODEL,
    });
    expect(confirmed.status).toBe(200);
    const waiting = await call('GET', `/v1/expenses/${refund.expenseId}`);
    expect(waiting.body).toMatchObject({ status: 'needs_review', refund: { of: null } });
    const inbox = await call('GET', '/v1/inbox');
    expect(inbox.body.items.find((i) => i.expense?.id === refund.expenseId)?.reason.code).toBe(
      'refund',
    );

    const offered = await call('GET', `/v1/expenses/${refund.expenseId}/refund-candidates`);
    expect(offered.body.candidates.map((c) => [c.id, c.left.decimal])).toEqual([
      [order.expenseId, '54.20'],
    ]);
    const paired = await call('PUT', `/v1/expenses/${refund.expenseId}/refund-of`, {
      purchaseId: order.expenseId,
    });
    expect(paired.status).toBe(200);
    expect(paired.body).toMatchObject({ status: 'ready', refund: { of: { id: order.expenseId } } });
    const purchase = await call('GET', `/v1/expenses/${order.expenseId}`);
    expect(purchase.body.refund?.refunds.map((r) => r.amount?.decimal)).toEqual(['-54.20']);

    const unpaired = await call('PUT', `/v1/expenses/${refund.expenseId}/refund-of`, {
      purchaseId: null,
    });
    expect(unpaired.body).toMatchObject({ status: 'needs_review', refund: { of: null } });
  });

  it('refuses a purchase the refund doesn’t fit, saying why', async () => {
    const euro = await readReceipt('Lufthansa', '2026-09-20', '120.00', 'EUR');
    const refund = await readReceipt('Lufthansa', '2026-10-01', '-120.00');
    await call('POST', `/v1/receipts/${refund.receiptId}/confirm`, { model: MODEL });
    expect(
      await call('PUT', `/v1/expenses/${refund.expenseId}/refund-of`, {
        purchaseId: euro.expenseId,
      }),
    ).toMatchObject({ status: 422, body: { code: 'currency' } });
    expect(
      await call('PUT', `/v1/expenses/${refund.expenseId}/refund-of`, { purchaseId: newId() }),
    ).toMatchObject({ status: 404 });
  });
});
