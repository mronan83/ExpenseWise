import { newId } from '@expensewise/domain';
import { asc } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { withOrg } from '../src/client.ts';
import {
  confirmReceipt,
  fileReceipt,
  getReceipt,
  listExtractionRuns,
  listReceiptReviews,
  listReceipts,
  recordExtractionRun,
  requestReceiptReading,
  runsForRequest,
  settleReceipt,
  type NewExtractionRun,
  type NewReceiptReview,
} from '../src/receipts.ts';
import { auditEvents, outboxEvents, receiptReviews } from '../src/schema.ts';
import { connectAs, expectDbError, seedOrg } from './helpers.ts';

const app = connectAs('app');
afterAll(async () => {
  await app.pool.end();
});

const sha = (n: number) => n.toString(16).padStart(64, '0');
const receipt = (memberId: string, n: number, id = newId()) => ({
  id,
  memberId,
  source: 'camera' as const,
  storageKey: `orgs/x/receipts/${id}`,
  contentType: 'image/jpeg',
  byteSize: 1234,
  sha256: sha(n),
});
const run = (receiptId: string, requestId: string, model: string): NewExtractionRun => ({
  receiptId,
  requestId,
  extractor: 'claude',
  model,
  promptVersion: 'extract-v1',
  schemaVersion: 'v1',
  outcome: 'confident',
  output: { documentType: 'receipt' },
  fieldConfidence: { total: 'high' },
  error: null,
  latencyMs: 1200,
  inputTokens: 1500,
  outputTokens: 300,
  costMicroUsd: 4500,
});

describe('filing a receipt', () => {
  it('stores the row, the event that has it read, and an audit event, together', async () => {
    const acme = await seedOrg(app.db, 'acme-receipts');
    const input = receipt(acme.memberId, 1);
    const result = await withOrg(app.db, acme.orgId, (tx) =>
      fileReceipt(tx, acme.orgId, input, acme.userId),
    );
    expect(result).toMatchObject({
      status: 'filed',
      receipt: { id: input.id, status: 'processing', uploadedBy: 'acme-receipts' },
      event: { topic: 'receipt.uploaded', orgId: acme.orgId, payload: { receiptId: input.id } },
    });
    const [outbox] = await withOrg(app.db, acme.orgId, (tx) => tx.select().from(outboxEvents));
    expect(outbox).toMatchObject({ topic: 'receipt.uploaded', payload: { receiptId: input.id } });
    if (result.status === 'filed') expect(result.event.outboxId).toBe(outbox!.id);
  });

  it('treats a retried request as done, and a second copy of a file as a duplicate', async () => {
    const acme = await seedOrg(app.db, 'acme-receipt-dupes');
    const input = receipt(acme.memberId, 2);
    const file = (r: typeof input) =>
      withOrg(app.db, acme.orgId, (tx) => fileReceipt(tx, acme.orgId, r, acme.userId));
    await file(input);
    expect((await file(input)).status).toBe('exists');
    expect(await file({ ...input, id: newId() })).toEqual({
      status: 'duplicate',
      receiptId: input.id,
    });
    const events = await withOrg(app.db, acme.orgId, (tx) => tx.select().from(outboxEvents));
    expect(events).toHaveLength(1);
  });

  it('keeps receipts inside their organization', async () => {
    const acme = await seedOrg(app.db, 'acme-receipt-iso');
    const globex = await seedOrg(app.db, 'globex-receipt-iso');
    const input = receipt(acme.memberId, 3);
    await withOrg(app.db, acme.orgId, (tx) => fileReceipt(tx, acme.orgId, input, acme.userId));
    expect(await withOrg(app.db, globex.orgId, (tx) => getReceipt(tx, input.id))).toBeUndefined();
    expect(await withOrg(app.db, globex.orgId, (tx) => listReceipts(tx, 10))).toEqual([]);
    // The same file in another organization is not a duplicate.
    const theirs = await withOrg(app.db, globex.orgId, (tx) =>
      fileReceipt(tx, globex.orgId, receipt(globex.memberId, 3), globex.userId),
    );
    expect(theirs.status).toBe('filed');
  });
});

describe('reading a receipt', () => {
  it('records each model once per request, then settles once', async () => {
    const acme = await seedOrg(app.db, 'acme-readings');
    const input = receipt(acme.memberId, 4);
    const filed = await withOrg(app.db, acme.orgId, (tx) =>
      fileReceipt(tx, acme.orgId, input, acme.userId),
    );
    if (filed.status !== 'filed') throw new Error('expected a new receipt');
    const requestId = filed.event.outboxId;

    await withOrg(app.db, acme.orgId, async (tx) => {
      await recordExtractionRun(tx, acme.orgId, run(input.id, requestId, 'claude-haiku-4-5'));
      // A retried step writes the same reading again; it is ignored.
      await recordExtractionRun(tx, acme.orgId, run(input.id, requestId, 'claude-haiku-4-5'));
      await recordExtractionRun(tx, acme.orgId, run(input.id, requestId, 'claude-sonnet-5-5'));
    });
    const runs = await withOrg(app.db, acme.orgId, (tx) => runsForRequest(tx, input.id, requestId));
    expect(runs.map((r) => r.model).sort()).toEqual(['claude-haiku-4-5', 'claude-sonnet-5-5']);

    const settle = () =>
      withOrg(app.db, acme.orgId, (tx) =>
        settleReceipt(tx, acme.orgId, input.id, {
          status: 'extracted',
          requestId,
          detail: { differences: [] },
        }),
      );
    await settle();
    await settle();
    expect((await withOrg(app.db, acme.orgId, (tx) => getReceipt(tx, input.id)))?.status).toBe(
      'extracted',
    );
    const actions = await withOrg(app.db, acme.orgId, async (tx) =>
      (await tx.select().from(auditEvents).orderBy(asc(auditEvents.sequence))).map((e) => e.action),
    );
    expect(actions).toEqual([
      'receipt.captured',
      'expense.created',
      'receipt.read',
      'expense.filed',
    ]);
  });

  it('reads again on request, with a new request id', async () => {
    const acme = await seedOrg(app.db, 'acme-read-again');
    const input = receipt(acme.memberId, 5);
    await withOrg(app.db, acme.orgId, (tx) => fileReceipt(tx, acme.orgId, input, acme.userId));
    const again = await withOrg(app.db, acme.orgId, (tx) =>
      requestReceiptReading(tx, acme.orgId, input.id, acme.userId),
    );
    expect(again).toMatchObject({
      topic: 'receipt.read_requested',
      payload: { receiptId: input.id },
    });
    expect(
      await withOrg(app.db, acme.orgId, (tx) =>
        requestReceiptReading(tx, acme.orgId, newId(), acme.userId),
      ),
    ).toBeUndefined();

    await withOrg(app.db, acme.orgId, (tx) =>
      recordExtractionRun(tx, acme.orgId, run(input.id, again!.outboxId, 'claude-haiku-4-5')),
    );
    const all = await withOrg(app.db, acme.orgId, (tx) => listExtractionRuns(tx, [input.id]));
    expect(all.map((r) => r.requestId)).toEqual([again!.outboxId]);
  });
});

describe('confirming a reading that needs a look', () => {
  const review = (memberId: string, requestId: string): NewReceiptReview => ({
    memberId,
    requestId,
    model: 'gpt-5.6-luna',
    merchant: 'Blue Bottle',
    transactionDate: '2026-09-24',
    currency: 'USD',
    totalMinor: 6500,
    taxMinor: 0,
    tipMinor: 100,
    corrections: [{ field: 'total', read: '6.50', corrected: '65.00' }],
  });

  /** A filed receipt read once by the fallback and settled as needing a look. */
  async function needingALook(name: string, n: number) {
    const org = await seedOrg(app.db, name);
    const input = receipt(org.memberId, n);
    const filed = await withOrg(app.db, org.orgId, (tx) =>
      fileReceipt(tx, org.orgId, input, org.userId),
    );
    if (filed.status !== 'filed') throw new Error('expected a new receipt');
    const requestId = filed.event.outboxId;
    await withOrg(app.db, org.orgId, async (tx) => {
      await recordExtractionRun(tx, org.orgId, run(input.id, requestId, 'gpt-5.6-luna'));
      await settleReceipt(tx, org.orgId, input.id, {
        status: 'needs_review',
        requestId,
        detail: {},
      });
    });
    const confirm = (r: NewReceiptReview, receiptId = input.id) =>
      withOrg(app.db, org.orgId, (tx) => confirmReceipt(tx, org.orgId, receiptId, r, org.userId));
    return { org, receiptId: input.id, requestId, confirm };
  }

  it('makes it Ready with the values, the corrections and an audit event, together', async () => {
    const { org, receiptId, requestId, confirm } = await needingALook('acme-confirm', 10);
    expect(await confirm(review(org.memberId, requestId))).toBe('confirmed');

    const after = await withOrg(app.db, org.orgId, async (tx) => ({
      receipt: await getReceipt(tx, receiptId),
      reviews: await listReceiptReviews(tx, [receiptId]),
      audit: await tx.select().from(auditEvents).orderBy(asc(auditEvents.sequence)),
    }));
    expect(after.receipt?.status).toBe('extracted');
    expect(after.reviews).toEqual([
      expect.objectContaining({
        receiptId,
        requestId,
        model: 'gpt-5.6-luna',
        reviewedBy: 'acme-confirm',
        merchant: 'Blue Bottle',
        transactionDate: '2026-09-24',
        totalMinor: 6500,
        tipMinor: 100,
        corrections: [{ field: 'total', read: '6.50', corrected: '65.00' }],
      }),
    ]);
    expect(after.audit.map((e) => e.action)).toEqual([
      'receipt.captured',
      'expense.created',
      'receipt.read',
      'expense.filed',
      'receipt.confirmed',
      'expense.filed',
    ]);
    expect(after.audit.find((e) => e.action === 'receipt.confirmed')).toMatchObject({
      actorType: 'user',
      actorId: org.userId,
      payload: { requestId, model: 'gpt-5.6-luna' },
    });
  });

  it('refuses a receipt that is no longer waiting, or was read again since', async () => {
    const { org, receiptId, requestId, confirm } = await needingALook('acme-confirm-guard', 11);
    expect(await confirm(review(org.memberId, requestId), newId())).toBe('missing');
    expect(await confirm(review(org.memberId, newId()))).toBe('stale');

    expect(await confirm(review(org.memberId, requestId))).toBe('confirmed');
    // Confirmed once: a second tap changes nothing.
    expect(await confirm(review(org.memberId, requestId))).toBe('not_waiting');

    const again = await withOrg(app.db, org.orgId, (tx) =>
      requestReceiptReading(tx, org.orgId, receiptId, org.userId),
    );
    // Being read again: nothing to confirm until it settles.
    expect(await confirm(review(org.memberId, requestId))).toBe('not_waiting');
    await withOrg(app.db, org.orgId, async (tx) => {
      await recordExtractionRun(tx, org.orgId, run(receiptId, again!.outboxId, 'gpt-5.6-luna'));
      await settleReceipt(tx, org.orgId, receiptId, {
        status: 'needs_review',
        requestId: again!.outboxId,
        detail: {},
      });
    });
    // The readings shown before the read-again are stale; the new ones can be confirmed.
    expect(await confirm(review(org.memberId, requestId))).toBe('stale');
    expect(await confirm(review(org.memberId, again!.outboxId))).toBe('confirmed');
    const reviews = await withOrg(app.db, org.orgId, (tx) => listReceiptReviews(tx, [receiptId]));
    expect(reviews.map((r) => r.requestId)).toEqual([again!.outboxId, requestId]);
  });

  it('keeps reviews inside their organization, and never edits or deletes one', async () => {
    const { org, receiptId, requestId, confirm } = await needingALook('acme-confirm-rls', 12);
    await confirm(review(org.memberId, requestId));
    const other = await seedOrg(app.db, 'globex-confirm-rls');
    expect(await withOrg(app.db, other.orgId, (tx) => listReceiptReviews(tx, [receiptId]))).toEqual(
      [],
    );
    await expectDbError(
      withOrg(app.db, org.orgId, (tx) => tx.update(receiptReviews).set({ totalMinor: 1 })),
      /permission denied/,
    );
    await expectDbError(
      withOrg(app.db, org.orgId, (tx) => tx.delete(receiptReviews)),
      /permission denied/,
    );
  });
});
