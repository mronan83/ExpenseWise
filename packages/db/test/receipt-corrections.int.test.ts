import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { newId } from '@expensewise/domain';
import { asc, eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { withOrg } from '../src/client.ts';
import { getExpense } from '../src/expenses.ts';
import { migrationsFolder } from '../src/migrate.ts';
import { correctReceipt } from '../src/receipt-corrections.ts';
import {
  fileReceipt,
  getReceipt,
  listReceiptReviews,
  recordExtractionRun,
  requestReceiptReading,
  settleReceipt,
  type NewReceiptReview,
} from '../src/receipts.ts';
import { auditEvents, expenses, receipts } from '../src/schema.ts';
import { connectAs, expectDbError, seedOrg } from './helpers.ts';

const app = connectAs('app');
const owner = connectAs('owner');
afterAll(async () => {
  await app.pool.end();
  await owner.pool.end();
});

const sha = (n: number) => (n + 900).toString(16).padStart(64, '0');

/** A receipt both models read alike, settled Ready, its expense filed with what they read. */
async function readyReceipt(name: string, n: number) {
  const org = await seedOrg(app.db, name);
  const id = newId();
  const filed = await withOrg(app.db, org.orgId, (tx) =>
    fileReceipt(
      tx,
      org.orgId,
      {
        id,
        memberId: org.memberId,
        source: 'camera',
        storageKey: `orgs/x/receipts/${id}`,
        contentType: 'image/jpeg',
        byteSize: 1234,
        sha256: sha(n),
      },
      org.userId,
    ),
  );
  if (filed.status !== 'filed') throw new Error('expected a new receipt');
  const requestId = filed.event.outboxId;
  const settle = (status: 'extracted' | 'needs_review', request = requestId) =>
    withOrg(app.db, org.orgId, async (tx) => {
      for (const model of ['claude-haiku-4-5', 'claude-sonnet-5-5']) {
        await recordExtractionRun(tx, org.orgId, {
          receiptId: id,
          requestId: request,
          extractor: 'claude',
          model,
          promptVersion: 'extract-v4',
          schemaVersion: 'receipt-v4',
          outcome: 'confident',
          output: { documentType: 'receipt' },
          fieldConfidence: null,
          error: null,
          latencyMs: 1200,
          inputTokens: 1500,
          outputTokens: 300,
          costMicroUsd: 4500,
        });
      }
      await settleReceipt(tx, org.orgId, id, {
        status,
        requestId: request,
        detail: {},
        values: {
          merchant: 'Blue Bottle',
          transactionDate: '2026-09-24',
          currency: 'USD',
          amountMinor: 650,
        },
      });
    });
  return { org, id, requestId, settle };
}

const review = (memberId: string, requestId: string, merchant: string): NewReceiptReview => ({
  memberId,
  requestId,
  model: 'claude-sonnet-5-5',
  merchant,
  transactionDate: '2026-09-24',
  currency: 'USD',
  totalMinor: 650,
  taxMinor: 0,
  tipMinor: 0,
  corrections: [{ field: 'merchant', read: 'Blue Bottle', corrected: merchant }],
});

const actions = (orgId: string) =>
  withOrg(app.db, orgId, async (tx) =>
    (await tx.select().from(auditEvents).orderBy(asc(auditEvents.sequence))).map((e) => e.action),
  );

describe('the time from capture to read', () => {
  it('keeps when the first reading settled, never before filing, and not a later one', async () => {
    const { org, id, settle } = await readyReceipt('acme-settled-at', 1);
    const before = await withOrg(app.db, org.orgId, (tx) => getReceipt(tx, id));
    expect(before?.settledAt).toBeNull();
    await settle('extracted');
    const first = await withOrg(app.db, org.orgId, (tx) => getReceipt(tx, id));
    expect(first?.settledAt).toBeInstanceOf(Date);
    expect(first!.settledAt!.getTime()).toBeGreaterThanOrEqual(first!.createdAt.getTime());

    const again = await withOrg(app.db, org.orgId, (tx) =>
      requestReceiptReading(tx, org.orgId, id, org.userId),
    );
    await settle('needs_review', again!.outboxId);
    const later = await withOrg(app.db, org.orgId, (tx) => getReceipt(tx, id));
    expect(later?.status).toBe('needs_review');
    expect(later?.settledAt).toEqual(first?.settledAt);
  });

  it('fills the time of receipts read before it was kept, from the audit trail, once', async () => {
    const { org, id, settle } = await readyReceipt('acme-settled-backfill', 2);
    await settle('extracted');
    const unread = await readyReceipt('acme-settled-unread', 3);
    const [read] = await withOrg(app.db, org.orgId, (tx) =>
      tx
        .select({ at: auditEvents.occurredAt })
        .from(auditEvents)
        .where(eq(auditEvents.action, 'receipt.read')),
    );
    // As it was before the column: no time kept.
    await owner.db.update(receipts).set({ settledAt: null }).where(eq(receipts.id, id));

    const file = readdirSync(migrationsFolder).find((f) =>
      f.endsWith('_receipt_settled_at_backfill.sql'),
    );
    const backfill = readFileSync(join(migrationsFolder, file!), 'utf8');
    await owner.pool.query(backfill);
    await owner.pool.query(backfill);
    const filled = await withOrg(app.db, org.orgId, (tx) => getReceipt(tx, id));
    const created = filled!.createdAt.getTime();
    expect(filled?.settledAt?.getTime()).toBe(Math.max(read!.at.getTime(), created));
    const stillUnread = await withOrg(app.db, unread.org.orgId, (tx) => getReceipt(tx, unread.id));
    expect(stillUnread?.settledAt).toBeNull();
  });

  it('refuses a settled time before the receipt was filed', async () => {
    const { org, id, settle } = await readyReceipt('acme-settled-check', 4);
    await settle('extracted');
    const receipt = await withOrg(app.db, org.orgId, (tx) => getReceipt(tx, id));
    await expectDbError(
      owner.db
        .update(receipts)
        .set({ settledAt: new Date(receipt!.createdAt.getTime() - 1000) })
        .where(eq(receipts.id, id)),
      /receipts_settled_after_capture/,
    );
  });
});

describe('correcting a Ready receipt', () => {
  it('files the correction, edits its expense and records both, together', async () => {
    const { org, id, requestId, settle } = await readyReceipt('acme-correct', 5);
    await settle('extracted');
    const result = await withOrg(app.db, org.orgId, (tx) =>
      correctReceipt(
        tx,
        org.orgId,
        id,
        {
          review: review(org.memberId, requestId, 'Blue Bottle — Oxbow'),
          expense: { merchant: 'Blue Bottle — Oxbow' },
          changes: [{ field: 'merchant', from: 'Blue Bottle', to: 'Blue Bottle — Oxbow' }],
        },
        org.userId,
      ),
    );
    expect(result).toEqual({ status: 'corrected' });
    const after = await withOrg(app.db, org.orgId, async (tx) => {
      const receipt = await getReceipt(tx, id);
      return {
        receipt,
        expense: await getExpense(tx, receipt!.expenseId!),
        reviews: await listReceiptReviews(tx, [id]),
        audit: await tx.select().from(auditEvents).orderBy(asc(auditEvents.sequence)),
      };
    });
    expect(after.receipt?.status).toBe('extracted');
    // The expense changed as an edit changes it: from now on a reading never overwrites it.
    expect(after.expense).toMatchObject({ merchant: 'Blue Bottle — Oxbow', status: 'ready' });
    expect(after.expense?.editedAt).toBeInstanceOf(Date);
    expect(after.reviews).toEqual([
      expect.objectContaining({
        requestId,
        model: 'claude-sonnet-5-5',
        merchant: 'Blue Bottle — Oxbow',
        corrections: [{ field: 'merchant', read: 'Blue Bottle', corrected: 'Blue Bottle — Oxbow' }],
      }),
    ]);
    expect(after.audit.map((e) => e.action).slice(-2)).toEqual([
      'expense.edited',
      'receipt.corrected',
    ]);
    expect(after.audit.at(-1)).toMatchObject({
      actorType: 'user',
      actorId: org.userId,
      payload: {
        requestId,
        model: 'claude-sonnet-5-5',
        changes: [{ field: 'merchant', from: 'Blue Bottle', to: 'Blue Bottle — Oxbow' }],
      },
    });
  });

  it('refuses one not Ready, read again since, or locked, and leaves nothing behind', async () => {
    const { org, id, requestId, settle } = await readyReceipt('acme-correct-guard', 6);
    const correct = (over: Partial<Parameters<typeof correctReceipt>[3]> = {}, receiptId = id) =>
      withOrg(app.db, org.orgId, (tx) =>
        correctReceipt(
          tx,
          org.orgId,
          receiptId,
          {
            review: review(org.memberId, requestId, 'Blue Bottle — Oxbow'),
            expense: { merchant: 'Blue Bottle — Oxbow' },
            changes: [],
            ...over,
          },
          org.userId,
        ),
      );
    expect(await correct()).toEqual({ status: 'not_ready' });
    await settle('extracted');
    const settled = await actions(org.orgId);
    expect(await correct({}, newId())).toEqual({ status: 'missing' });
    expect(await correct({ review: review(org.memberId, newId(), 'Blue Bottle — Oxbow') })).toEqual(
      { status: 'stale' },
    );
    // 6.50 can't be yen: the expense refuses, so nothing is kept.
    expect(await correct({ expense: { currency: 'JPY' } })).toMatchObject({
      status: 'invalid',
      problem: { field: 'amount' },
    });

    // Submitted: locked, until approval brings reversals (FR-EXP-03).
    const receipt = await withOrg(app.db, org.orgId, (tx) => getReceipt(tx, id));
    await owner.db
      .update(expenses)
      .set({ status: 'submitted' })
      .where(eq(expenses.id, receipt!.expenseId!));
    expect(await correct()).toEqual({ status: 'locked' });

    expect(await withOrg(app.db, org.orgId, (tx) => listReceiptReviews(tx, [id]))).toEqual([]);
    expect(await actions(org.orgId)).toEqual(settled);
  });
});
