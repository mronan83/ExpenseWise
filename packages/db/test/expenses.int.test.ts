import { newId } from '@expensewise/domain';
import { asc, eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { withOrg } from '../src/client.ts';
import { editExpense, getExpense, listExpenses } from '../src/expenses.ts';
import {
  confirmReceipt,
  fileMissingReceiptExpenses,
  fileReceipt,
  getReceipt,
  recordExtractionRun,
  requestReceiptReading,
  settleReceipt,
} from '../src/receipts.ts';
import { auditEvents, receipts } from '../src/schema.ts';
import { connectAs, seedOrg } from './helpers.ts';

const app = connectAs('app');
const owner = connectAs('owner');
afterAll(async () => {
  await app.pool.end();
  await owner.pool.end();
});

const coffee = {
  merchant: 'Blue Bottle Coffee',
  transactionDate: '2026-09-24',
  currency: 'USD',
  amountMinor: 650,
};
let n = 100;
const sha = () => (n++).toString(16).padStart(64, '0');

/** A receipt filed in a fresh organization, with helpers to read and settle it. */
async function filedReceipt(name: string) {
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
        sha256: sha(),
      },
      org.userId,
    ),
  );
  if (filed.status !== 'filed') throw new Error('expected a new receipt');
  const inOrg = <T>(work: Parameters<typeof withOrg<T>>[2]) => withOrg(app.db, org.orgId, work);
  const settle = (
    requestId: string,
    status: 'extracted' | 'needs_review' | 'failed',
    values: typeof coffee | null,
  ) =>
    inOrg(async (tx) => {
      await recordExtractionRun(tx, org.orgId, {
        receiptId: id,
        requestId,
        extractor: 'openai',
        model: 'gpt-5.6-luna',
        promptVersion: 'extract-v1',
        schemaVersion: 'v1',
        outcome: 'confident',
        output: { documentType: 'receipt' },
        fieldConfidence: {},
        error: null,
        latencyMs: 1,
        inputTokens: 1,
        outputTokens: 1,
        costMicroUsd: 1,
      });
      await settleReceipt(tx, org.orgId, id, { status, requestId, detail: {}, values });
    });
  const expense = async () => {
    const receipt = await inOrg((tx) => getReceipt(tx, id));
    return inOrg((tx) => getExpense(tx, receipt!.expenseId!));
  };
  const actions = () =>
    inOrg(async (tx) =>
      (await tx.select().from(auditEvents).orderBy(asc(auditEvents.sequence))).map((e) => e.action),
    );
  return { org, id, requestId: filed.event.outboxId, inOrg, settle, expense, actions };
}

describe('an expense made from a receipt', () => {
  it('exists from capture, processing and linked to its receipt as proof', async () => {
    const r = await filedReceipt('acme-expense-capture');
    expect(await r.expense()).toMatchObject({
      status: 'processing',
      source: 'camera',
      receiptId: r.id,
      owner: 'acme-expense-capture',
      merchant: null,
      editedAt: null,
    });
    expect(await r.actions()).toEqual(['receipt.captured', 'expense.created']);
  });

  it('is Ready with the reading when the receipt is Ready, together with its audit event', async () => {
    const r = await filedReceipt('acme-expense-ready');
    await r.settle(r.requestId, 'extracted', coffee);
    expect(await r.expense()).toMatchObject({ status: 'ready', ...coffee });
    expect(await r.actions()).toEqual([
      'receipt.captured',
      'expense.created',
      'receipt.read',
      'expense.filed',
    ]);
  });

  it('needs review, filled in as read, while its receipt needs a look; failed leaves it empty', async () => {
    const look = await filedReceipt('acme-expense-look');
    await look.settle(look.requestId, 'needs_review', coffee);
    expect(await look.expense()).toMatchObject({ status: 'needs_review', ...coffee });
    const failed = await filedReceipt('acme-expense-failed');
    await failed.settle(failed.requestId, 'failed', null);
    expect(await failed.expense()).toMatchObject({ status: 'needs_review', amountMinor: null });
  });

  it('becomes Ready with the confirmed values when its receipt is confirmed', async () => {
    const r = await filedReceipt('acme-expense-confirm');
    await r.settle(r.requestId, 'needs_review', coffee);
    const before = await r.expense();
    expect(
      await r.inOrg((tx) =>
        confirmReceipt(
          tx,
          r.org.orgId,
          r.id,
          {
            memberId: r.org.memberId,
            requestId: r.requestId,
            model: 'gpt-5.6-luna',
            merchant: 'Blue Bottle',
            transactionDate: '2026-09-24',
            currency: 'USD',
            totalMinor: 725,
            taxMinor: 0,
            tipMinor: 0,
            corrections: [{ field: 'total', read: '6.50', corrected: '7.25' }],
          },
          r.org.userId,
        ),
      ),
    ).toBe('confirmed');
    expect(await r.expense()).toMatchObject({
      id: before!.id,
      status: 'ready',
      merchant: 'Blue Bottle',
      amountMinor: 725,
    });
  });

  it('is Ready once a receipt no model could read is filled in by hand', async () => {
    const r = await filedReceipt('acme-expense-unread');
    await r.settle(r.requestId, 'failed', null);
    expect(
      await r.inOrg((tx) =>
        confirmReceipt(
          tx,
          r.org.orgId,
          r.id,
          {
            memberId: r.org.memberId,
            requestId: r.requestId,
            model: 'gpt-5.6-luna',
            ...coffee,
            totalMinor: coffee.amountMinor,
            taxMinor: null,
            tipMinor: null,
            corrections: [{ field: 'total', read: null, corrected: '6.50' }],
          },
          r.org.userId,
        ),
      ),
    ).toBe('confirmed');
    expect(await r.expense()).toMatchObject({ status: 'ready', ...coffee });
  });

  it('keeps a person’s edit over any later reading, and is Ready once the receipt is', async () => {
    const r = await filedReceipt('acme-expense-edit');
    await r.settle(r.requestId, 'needs_review', coffee);
    const { id } = (await r.expense())!;
    const edited = await r.inOrg((tx) =>
      editExpense(tx, r.org.orgId, id, { amount: '7.25' }, r.org.userId),
    );
    expect(edited).toEqual({
      status: 'edited',
      changes: [{ field: 'amount', from: '6.50', to: '7.25' }],
      detailChanges: [],
    });
    // The receipt still needs a look, so its expense isn't Ready yet.
    expect(await r.expense()).toMatchObject({ status: 'needs_review', amountMinor: 725 });

    const again = await r.inOrg((tx) => requestReceiptReading(tx, r.org.orgId, r.id, r.org.userId));
    expect(await r.expense()).toMatchObject({ status: 'processing', amountMinor: 725 });
    expect(
      await r.inOrg((tx) => editExpense(tx, r.org.orgId, id, { amount: '1.00' }, r.org.userId)),
    ).toEqual({ status: 'not_editable', current: 'processing' });

    await r.settle(again!.outboxId, 'extracted', coffee);
    const after = await r.expense();
    expect(after).toMatchObject({ status: 'ready', amountMinor: 725 });
    expect(after!.editedAt).toBeInstanceOf(Date);
    const audit = await r.inOrg((tx) =>
      tx.select().from(auditEvents).where(eq(auditEvents.action, 'expense.edited')),
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actorType: 'user',
      actorId: r.org.userId,
      entityId: id,
      payload: { changes: [{ field: 'amount', from: '6.50', to: '7.25' }] },
    });
  });

  it('refuses a value that is not valid, and records nothing for no change', async () => {
    const r = await filedReceipt('acme-expense-invalid');
    await r.settle(r.requestId, 'extracted', coffee);
    const { id } = (await r.expense())!;
    const edit = (e: Parameters<typeof editExpense>[3]) =>
      r.inOrg((tx) => editExpense(tx, r.org.orgId, id, e, r.org.userId));
    expect(await edit({ date: '2026-02-30' })).toMatchObject({
      status: 'invalid',
      problem: { field: 'date' },
    });
    expect(await edit({ amount: '6.50' })).toEqual({ status: 'unchanged' });
    expect(await edit({ amount: '1.00' })).toMatchObject({ status: 'edited' });
    expect(
      await r.inOrg((tx) => editExpense(tx, r.org.orgId, newId(), { amount: '1' }, r.org.userId)),
    ).toEqual({ status: 'missing' });
  });

  it('stays inside its organization', async () => {
    const r = await filedReceipt('acme-expense-rls');
    const other = await seedOrg(app.db, 'globex-expense-rls');
    const { id } = (await r.expense())!;
    expect(await withOrg(app.db, other.orgId, (tx) => getExpense(tx, id))).toBeUndefined();
    expect(await withOrg(app.db, other.orgId, (tx) => listExpenses(tx, 10))).toEqual([]);
    expect((await r.inOrg((tx) => listExpenses(tx, 10))).map((e) => e.id)).toEqual([id]);
  });
});

describe('receipts captured before expenses', () => {
  it('each get an expense once, confirmed ones Ready with what was confirmed', async () => {
    const r = await filedReceipt('acme-expense-backfill');
    await r.settle(r.requestId, 'needs_review', coffee);
    // Stand in for a receipt filed before #6: no expense yet.
    const { id: oldExpense } = (await r.expense())!;
    await owner.db.update(receipts).set({ expenseId: null }).where(eq(receipts.id, r.id));

    expect(await fileMissingReceiptExpenses(owner.db)).toBeGreaterThanOrEqual(1);
    const backfilled = await r.expense();
    expect(backfilled).toMatchObject({ status: 'needs_review', merchant: null, receiptId: r.id });
    expect(backfilled!.id).not.toBe(oldExpense);
    // Running it again files nothing more for this receipt.
    await fileMissingReceiptExpenses(owner.db);
    expect((await r.expense())!.id).toBe(backfilled!.id);
    expect((await r.actions()).filter((a) => a === 'expense.created')).toHaveLength(2);
  });
});
