/**
 * Refunds: money a merchant gave back counts only once it is paired with the purchase it
 * refunds, on a real database as expensewise_app (FR-EXP-21, Q59, Q60, ADR-0054). Run with
 * `pnpm test:integration`.
 */
import { newId } from '@expensewise/domain';
import { asc, eq, sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { withOrg } from '../src/client.ts';
import { setExpensePaidBy } from '../src/company-paid.ts';
import { editExpense, listUnpairedRefunds } from '../src/expenses.ts';
import { homeSnapshot } from '../src/home.ts';
import { splitExpense } from '../src/itemized.ts';
import { listReportAmounts } from '../src/report-amounts.ts';
import {
  confirmReceipt,
  fileReceipt,
  recordExtractionRun,
  settleReceipt,
} from '../src/receipts.ts';
import {
  holdUnpairedRefunds,
  listRefundCandidates,
  pairRefund,
  refundLinksOf,
  unpairRefund,
} from '../src/refunds.ts';
import { joinDueItems } from '../src/reports.ts';
import { auditEvents, expenses, members, receipts } from '../src/schema.ts';
import { createTrip, setExpenseTrip } from '../src/trips.ts';
import { connectAs, expectDbError, seedOrg } from './helpers.ts';

const app = connectAs('app');
const owner = connectAs('owner');
afterAll(async () => {
  await app.pool.end();
  await owner.pool.end();
});

/** An order of Sep 24, and its whole refund of Oct 2. */
const order = {
  merchant: 'Amazon.com',
  transactionDate: '2026-09-24',
  currency: 'USD',
  amountMinor: 5_420,
};
const refundOf = { ...order, merchant: 'Amazon.com Services', transactionDate: '2026-10-02' };
/** Both have ended everywhere by then, so each is due to join a report. */
const LATER = new Date('2026-10-20T12:00:00Z');

async function workspace(name: string) {
  const org = await seedOrg(app.db, name);
  const inOrg = <T>(work: Parameters<typeof withOrg<T>>[2]) => withOrg(app.db, org.orgId, work);
  const actor = { type: 'user', id: org.userId } as const;
  /** An expense typed in by hand, Ready unless it is a refund. */
  const expense = (
    values: Partial<typeof expenses.$inferInsert> = {},
    memberId = org.memberId,
  ): Promise<string> =>
    inOrg(async (tx) => {
      const id = newId();
      const amount = values.amountMinor ?? order.amountMinor;
      await tx.insert(expenses).values({
        id,
        orgId: org.orgId,
        memberId,
        status: amount < 0 ? 'needs_review' : 'ready',
        source: 'manual',
        justification: 'Team supplies',
        ...order,
        ...values,
      });
      return id;
    });
  const refund = (values: Partial<typeof expenses.$inferInsert> = {}) =>
    expense({ ...refundOf, amountMinor: -5_420, justification: null, ...values });
  const row = (id: string) =>
    inOrg(async (tx) => (await tx.select().from(expenses).where(eq(expenses.id, id)))[0]!);
  const pair = (refundId: string, purchaseId: string) =>
    inOrg((tx) => pairRefund(tx, org.orgId, refundId, purchaseId, org.userId));
  const actions = (entityId: string) =>
    inOrg(async (tx) =>
      (
        await tx
          .select({ action: auditEvents.action })
          .from(auditEvents)
          .where(eq(auditEvents.entityId, entityId))
          .orderBy(asc(auditEvents.sequence))
      ).map((e) => e.action),
    );
  const join = () => inOrg((tx) => joinDueItems(tx, org.orgId, LATER));
  return { org, inOrg, actor, expense, refund, row, pair, actions, join };
}

describe('a refund on its own (FR-EXP-21)', () => {
  it('counts in no claim: on no report or trip, never Ready, and the database refuses otherwise', async () => {
    const w = await workspace('refund-held');
    const purchase = await w.expense();
    const refund = await w.refund();
    await w.join();
    const [onReport, held] = [await w.row(purchase), await w.row(refund)];
    expect(onReport.reportId).not.toBeNull();
    expect(held).toMatchObject({ reportId: null, tripId: null, status: 'needs_review' });
    expect(await w.inOrg((tx) => listReportAmounts(tx, [onReport.reportId!]))).toHaveLength(1);
    // Every writer is held to it, not only the ones that know about refunds.
    await expectDbError(
      w.inOrg((tx) => tx.update(expenses).set({ status: 'ready' }).where(eq(expenses.id, refund))),
      /expenses_refund_unpaired_held/,
    );
    await expectDbError(
      w.inOrg((tx) =>
        tx.update(expenses).set({ reportId: onReport.reportId }).where(eq(expenses.id, refund)),
      ),
      /expenses_refund_unpaired_held/,
    );
  });

  it('waits in Needs you, and counts in no total on Home', async () => {
    const w = await workspace('refund-needs-you');
    await w.expense();
    const refund = await w.refund();
    const waiting = await w.inOrg((tx) => listUnpairedRefunds(tx, w.org.memberId, 10));
    expect(waiting.map((e) => e.id)).toEqual([refund]);
    // The refund is October's only expense: Home counts nothing for it until it is paired.
    const home = await w.inOrg((tx) => homeSnapshot(tx, w.org.memberId, '2026-10-05'));
    expect(home.monthExpenses).toEqual([]);
  });

  it('is filed from a receipt read below zero, and its confirmation is no longer refused', async () => {
    const w = await workspace('refund-receipt');
    const id = newId();
    const filed = await w.inOrg((tx) =>
      fileReceipt(
        tx,
        w.org.orgId,
        {
          id,
          memberId: w.org.memberId,
          source: 'camera',
          storageKey: `orgs/x/receipts/${id}`,
          contentType: 'image/jpeg',
          byteSize: 1234,
          sha256: newId().replaceAll('-', '').padEnd(64, '0'),
        },
        w.org.userId,
      ),
    );
    if (filed.status !== 'filed') throw new Error('expected a new receipt');
    const requestId = filed.event.outboxId;
    const values = { ...refundOf, amountMinor: -5_420 };
    await w.inOrg(async (tx) => {
      await recordExtractionRun(tx, w.org.orgId, {
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
      await settleReceipt(tx, w.org.orgId, id, {
        status: 'needs_review',
        requestId,
        detail: {},
        values,
      });
    });
    const confirmed = await w.inOrg((tx) =>
      confirmReceipt(
        tx,
        w.org.orgId,
        id,
        {
          memberId: w.org.memberId,
          requestId,
          model: 'gpt-5.6-luna',
          merchant: values.merchant,
          transactionDate: values.transactionDate,
          currency: values.currency,
          totalMinor: values.amountMinor,
          taxMinor: 0,
          tipMinor: 0,
          corrections: [],
        },
        w.org.userId,
      ),
    );
    expect(confirmed).toBe('confirmed');
    const [receipt] = await w.inOrg((tx) => tx.select().from(receipts).where(eq(receipts.id, id)));
    expect(receipt!.status).toBe('extracted');
    // Confirmed, it is still a refund on its own: it waits to be paired, in no claim.
    expect(await w.row(receipt!.expenseId!)).toMatchObject({
      amountMinor: -5_420,
      status: 'needs_review',
      reportId: null,
      tripId: null,
    });
  });
});

describe('pairing a refund with its purchase (FR-EXP-21)', () => {
  it('offers the purchases it fits, likeliest first, never another person’s', async () => {
    const w = await workspace('refund-candidates');
    const sam = newId();
    await w.inOrg((tx) =>
      tx.insert(members).values({
        id: sam,
        orgId: w.org.orgId,
        userId: `user_${sam}`,
        email: 'sam@example.com',
        displayName: 'Sam',
        role: 'member',
      }),
    );
    const lunch = await w.expense({ merchant: 'Pret', amountMinor: 9_000 });
    const purchase = await w.expense();
    await w.expense({ currency: 'EUR' });
    await w.expense({ transactionDate: '2026-10-03' });
    await w.expense({ transactionDate: '2026-03-01' });
    const samsOrder = await w.expense({}, sam);
    const refund = await w.refund();
    const offered = await w.inOrg((tx) => listRefundCandidates(tx, refund));
    expect(offered?.map((c) => c.id)).toEqual([purchase, lunch]);
    expect(await w.pair(refund, samsOrder)).toEqual({ status: 'missing' });
  });

  it('goes where its purchase is, Ready, so the two net to zero on one claim', async () => {
    const w = await workspace('refund-pair');
    const purchase = await w.expense();
    const refund = await w.refund();
    await w.join();
    const { reportId } = await w.row(purchase);
    expect(await w.pair(refund, purchase)).toEqual({ status: 'paired', purchaseId: purchase });
    expect(await w.row(refund)).toMatchObject({
      refundOfId: purchase,
      reportId,
      tripId: null,
      status: 'ready',
      justification: 'Refund of Amazon.com on 2026-09-24',
    });
    const amounts = await w.inOrg((tx) => listReportAmounts(tx, [reportId!]));
    expect(amounts.reduce((sum, a) => sum + a.amountMinor, 0)).toBe(0);
    expect(await w.actions(refund)).toEqual(['expense.refund_paired', 'expense.refund_filed']);
    expect(await w.inOrg((tx) => refundLinksOf(tx, purchase))).toMatchObject({
      of: null,
      refunds: [{ id: refund, amountMinor: -5_420 }],
    });
    expect(await w.pair(refund, purchase)).toEqual({ status: 'unchanged' });
  });

  it('nets a purchase down by partial refunds, never past what it cost', async () => {
    const w = await workspace('refund-partial');
    const purchase = await w.expense();
    const first = await w.refund({ amountMinor: -1_000 });
    const tooMuch = await w.refund({ amountMinor: -4_421 });
    const rest = await w.refund({ amountMinor: -4_420 });
    expect((await w.pair(first, purchase)).status).toBe('paired');
    expect(await w.pair(tooMuch, purchase)).toEqual({ status: 'invalid', problem: 'amount' });
    expect((await w.pair(rest, purchase)).status).toBe('paired');
    expect(await w.inOrg((tx) => listRefundCandidates(tx, tooMuch))).toEqual([]);
  });

  it('follows its purchase to another trip', async () => {
    const w = await workspace('refund-follows');
    const trip = async (name: string, startDate: string, endDate: string) => {
      const made = await w.inOrg((tx) =>
        createTrip(tx, w.org.orgId, w.org.memberId, { name, startDate, endDate }, w.org.userId),
      );
      if (made.status !== 'saved') throw new Error(made.status);
      return made.tripId;
    };
    const seattle = await trip('Seattle', '2026-09-23', '2026-09-25');
    const purchase = await w.expense();
    await w.inOrg((tx) =>
      setExpenseTrip(tx, w.org.orgId, purchase, { byDate: true }, w.org.userId),
    );
    expect((await w.row(purchase)).tripId).toBe(seattle);
    const refund = await w.refund();
    await w.pair(refund, purchase);
    expect((await w.row(refund)).tripId).toBe(seattle);
    const denver = await trip('Denver', '2026-09-26', '2026-09-28');
    await w.inOrg((tx) =>
      setExpenseTrip(tx, w.org.orgId, purchase, { tripId: denver }, w.org.userId),
    );
    expect((await w.row(refund)).tripId).toBe(denver);
    // A refund is never put on a trip of its own.
    expect(
      await w.inOrg((tx) =>
        setExpenseTrip(tx, w.org.orgId, refund, { tripId: seattle }, w.org.userId),
      ),
    ).toEqual({ status: 'refund' });
  });

  it('is paid back on the open report when its purchase was claimed already', async () => {
    const w = await workspace('refund-claimed');
    const purchase = await w.expense();
    await w.join();
    const claimed = (await w.row(purchase)).reportId!;
    await w.inOrg((tx) =>
      tx.execute(
        sql`update reports set status = 'approved', closed_at = now(), submitted_at = now(), approved_at = now() where id = ${claimed}`,
      ),
    );
    await w.inOrg((tx) =>
      tx.update(expenses).set({ status: 'approved' }).where(eq(expenses.id, purchase)),
    );
    const refund = await w.refund();
    expect((await w.pair(refund, purchase)).status).toBe('paired');
    const paidBack = await w.row(refund);
    expect(paidBack).toMatchObject({ status: 'ready', tripId: null });
    expect(paidBack.reportId).not.toBeNull();
    expect(paidBack.reportId).not.toBe(claimed);
    const amounts = await w.inOrg((tx) => listReportAmounts(tx, [paidBack.reportId!]));
    expect(amounts.map((a) => a.amountMinor)).toEqual([-5_420]);
  });

  it('is the company’s when its purchase is, and is set there, not on the refund', async () => {
    const w = await workspace('refund-company');
    const purchase = await w.expense();
    const refund = await w.refund();
    await w.pair(refund, purchase);
    expect((await w.row(refund)).companyPaid).toBe(false);
    await w.inOrg((tx) =>
      setExpensePaidBy(tx, w.org.orgId, purchase, { paidBy: 'company' }, w.org.userId),
    );
    expect((await w.row(refund)).companyPaid).toBe(true);
    expect(
      await w.inOrg((tx) =>
        setExpensePaidBy(tx, w.org.orgId, refund, { paidBy: 'claimant' }, w.org.userId),
      ),
    ).toMatchObject({ status: 'not_changeable', problem: 'refund' });
  });

  it('lets go when either changes so it no longer fits, or a person unpairs it', async () => {
    const w = await workspace('refund-let-go');
    const purchase = await w.expense();
    const refund = await w.refund();
    await w.join();
    await w.pair(refund, purchase);
    expect((await w.row(refund)).reportId).not.toBeNull();
    const edited = await w.inOrg((tx) =>
      editExpense(tx, w.org.orgId, purchase, { amount: '10.00' }, w.org.userId),
    );
    expect(edited.status).toBe('edited');
    expect(await w.row(refund)).toMatchObject({
      refundOfId: null,
      reportId: null,
      status: 'needs_review',
    });
    expect(await w.actions(refund)).toContain('expense.refund_unpaired');

    await w.inOrg((tx) =>
      editExpense(tx, w.org.orgId, purchase, { amount: '54.20' }, w.org.userId),
    );
    await w.pair(refund, purchase);
    // A refund edited to give back more than the purchase cost lets go too.
    await w.inOrg((tx) => editExpense(tx, w.org.orgId, refund, { amount: '-60.00' }, w.org.userId));
    expect(await w.row(refund)).toMatchObject({ refundOfId: null, reportId: null });

    await w.inOrg((tx) => editExpense(tx, w.org.orgId, refund, { amount: '-54.20' }, w.org.userId));
    await w.pair(refund, purchase);
    expect(await w.inOrg((tx) => unpairRefund(tx, w.org.orgId, refund, w.org.userId))).toEqual({
      status: 'unpaired',
      purchaseId: purchase,
    });
    expect(await w.row(refund)).toMatchObject({ refundOfId: null, reportId: null });
  });

  it('is not split or itemized: it gives back on its purchase as a whole', async () => {
    const w = await workspace('refund-split');
    const refund = await w.refund();
    expect(
      await w.inOrg((tx) =>
        splitExpense(tx, w.org.orgId, refund, { basis: 'amounts', parts: [] }, w.org.userId),
      ),
    ).toEqual({ status: 'refund' });
  });
});

describe('refunds filed before they were held (#114)', () => {
  it('leaves nothing to take out, and the check holds every writer once validated', async () => {
    expect(await holdUnpairedRefunds(owner.db)).toBe(0);
    const [check] = await owner.db
      .select({ valid: sql<boolean>`convalidated` })
      .from(sql`pg_constraint`)
      .where(sql`conname = 'expenses_refund_unpaired_held'`);
    expect(check?.valid).toBe(true);
  });
});
