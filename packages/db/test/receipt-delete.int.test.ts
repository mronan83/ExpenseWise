/**
 * Deleting a receipt filed by mistake, such as a forwarded booking confirmation with no
 * amounts, on a real database as expensewise_app (FR-CAP-11, US-CAP-09, ADR-0028). Run with
 * `pnpm test:integration`.
 */
import { money, newId, type MemberRole } from '@expensewise/domain';
import { and, eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { fileCardStatement, missingReceipts, settleCardStatement } from '../src/card-statements.ts';
import { isOwnRecordsRefusal, withMember, withOrg } from '../src/client.ts';
import { deleteReceipt } from '../src/duplicates.ts';
import type { ReceiptOffer } from '../src/expenses.ts';
import { fileReceipt, settleReceipt } from '../src/receipts.ts';
import { auditEvents, expenses, members, receipts } from '../src/schema.ts';
import { connectAs, seedOrg } from './helpers.ts';

const app = connectAs('app');
afterAll(async () => {
  await app.pool.end();
});

type Org = Awaited<ReturnType<typeof seedOrg>>;
type Who = { orgId: string; memberId: string; role: MemberRole; userId: string };
const self = (org: Org): Who => ({ ...org, role: 'owner' });
let files = 0x100_0000;
const sha = () => (++files).toString(16).padStart(64, 'b');

async function addMember(org: Org, name: string, role: MemberRole): Promise<Who> {
  const memberId = newId();
  await withOrg(app.db, org.orgId, (tx) =>
    tx.insert(members).values({
      id: memberId,
      orgId: org.orgId,
      userId: `user_${memberId}`,
      email: `${name}@example.com`,
      displayName: name,
      role,
    }),
  );
  return { orgId: org.orgId, memberId, role, userId: `user_${memberId}` };
}

/** Files a receipt for a member; settled with these values unless it is left being read. */
async function receiptOf(
  org: Org,
  memberId: string,
  values: ReceiptOffer | null,
): Promise<{ receiptId: string; expenseId: string | null }> {
  const receiptId = newId();
  const requestId = await withOrg(app.db, org.orgId, async (tx) => {
    const filed = await fileReceipt(
      tx,
      org.orgId,
      {
        id: receiptId,
        memberId,
        source: 'email',
        storageKey: `orgs/${org.orgId}/receipts/${receiptId}`,
        contentType: 'application/pdf',
        byteSize: 4000,
        sha256: sha(),
      },
      org.userId,
    );
    if (filed.status !== 'filed') throw new Error('not filed');
    return filed.event.outboxId;
  });
  if (values) {
    await withOrg(app.db, org.orgId, (tx) =>
      settleReceipt(tx, org.orgId, receiptId, {
        // With no amount, a reading needs a look, as a confirmation's does.
        status: values.amountMinor === null ? 'needs_review' : 'extracted',
        requestId,
        detail: {},
        values,
      }),
    );
  }
  const [r] = await withOrg(app.db, org.orgId, (tx) =>
    tx.select({ expenseId: receipts.expenseId }).from(receipts).where(eq(receipts.id, receiptId)),
  );
  return { receiptId, expenseId: r!.expenseId };
}

/** A flight confirmation as a reading finds it: an airline and a day, and no amounts. */
const CONFIRMATION: ReceiptOffer = {
  merchant: 'Delta Air Lines',
  transactionDate: '2026-10-14',
  currency: null,
  amountMinor: null,
};

describe('deleting a receipt filed by mistake (FR-CAP-11, US-CAP-09)', () => {
  it('deletes the member’s own receipt with its expense, and the audit trail keeps what it was', async () => {
    const org = await seedOrg(app.db, 'delete-receipt-own');
    const { receiptId, expenseId } = await receiptOf(org, org.memberId, CONFIRMATION);
    expect(expenseId).not.toBeNull();
    const result = await withMember(app.db, self(org), (tx) =>
      deleteReceipt(tx, org.orgId, receiptId, org.userId),
    );
    expect(result).toEqual({
      status: 'deleted',
      storageKey: `orgs/${org.orgId}/receipts/${receiptId}`,
    });
    const [left] = await withOrg(app.db, org.orgId, async (tx) => [
      {
        receipts: await tx.select().from(receipts).where(eq(receipts.id, receiptId)),
        expenses: await tx.select().from(expenses).where(eq(expenses.id, expenseId!)),
        audit: await tx
          .select({ actor: auditEvents.actorId, payload: auditEvents.payload })
          .from(auditEvents)
          .where(
            and(eq(auditEvents.action, 'receipt.deleted'), eq(auditEvents.entityId, receiptId)),
          ),
      },
    ]);
    expect(left.receipts).toEqual([]);
    expect(left.expenses).toEqual([]);
    expect(left.audit.map((e) => e.actor)).toEqual([org.userId]);
    expect(left.audit[0]?.payload).toMatchObject({
      filedByMistake: true,
      merchant: 'Delta Air Lines',
      date: '2026-10-14',
      expenseId,
    });
    // Deleted already, there is nothing to delete.
    expect(
      await withMember(app.db, self(org), (tx) =>
        deleteReceipt(tx, org.orgId, receiptId, org.userId),
      ),
    ).toEqual({ status: 'missing' });
  });

  it('refuses a submitted claim, and a receipt still being read', async () => {
    const org = await seedOrg(app.db, 'delete-receipt-refused');
    const submitted = await receiptOf(org, org.memberId, {
      ...CONFIRMATION,
      currency: 'USD',
      amountMinor: 40_220,
    });
    await withOrg(app.db, org.orgId, (tx) =>
      tx.update(expenses).set({ status: 'submitted' }).where(eq(expenses.id, submitted.expenseId!)),
    );
    const reading = await receiptOf(org, org.memberId, null);
    const attempt = (receiptId: string) =>
      withMember(app.db, self(org), (tx) => deleteReceipt(tx, org.orgId, receiptId, org.userId));
    expect(await attempt(submitted.receiptId)).toEqual({ status: 'locked' });
    expect(await attempt(reading.receiptId)).toEqual({ status: 'being_read' });
  });

  it('lets only the receipt’s own member delete it, never an auditor', async () => {
    const org = await seedOrg(app.db, 'delete-receipt-whose');
    const sam = await addMember(org, 'sam', 'member');
    const audrey = await addMember(org, 'audrey', 'auditor');
    const { receiptId } = await receiptOf(org, sam.memberId, CONFIRMATION);
    // The owner sees Sam's receipt, but it is Sam's own to delete; an auditor changes nothing.
    for (const who of [self(org), audrey]) {
      const refused = await withMember(app.db, who, (tx) =>
        deleteReceipt(tx, org.orgId, receiptId, who.userId),
      ).catch((error: unknown) => error);
      expect(isOwnRecordsRefusal(refused), who.role).toBe(true);
    }
    expect(
      await withMember(app.db, sam, (tx) => deleteReceipt(tx, org.orgId, receiptId, sam.userId)),
    ).toMatchObject({ status: 'deleted' });
  });

  it('makes a card charge its expense documented a missing receipt again (AC5)', async () => {
    const org = await seedOrg(app.db, 'delete-receipt-card');
    const fare = await receiptOf(org, org.memberId, {
      merchant: 'Delta',
      transactionDate: '2026-09-12',
      currency: 'USD',
      amountMinor: 40_220,
    });
    const statementId = newId();
    await withOrg(app.db, org.orgId, async (tx) => {
      await fileCardStatement(
        tx,
        org.orgId,
        {
          id: statementId,
          memberId: org.memberId,
          source: 'upload',
          storageKey: `orgs/${org.orgId}/statements/${statementId}`,
          contentType: 'application/pdf',
          byteSize: 52_000,
          sha256: sha(),
        },
        { type: 'user', id: org.userId },
      );
      await settleCardStatement(tx, org.orgId, statementId, {
        status: 'read',
        problem: null,
        cardLastFour: '4417',
        periodStart: '2026-08-29',
        periodEnd: '2026-09-28',
        currency: 'USD',
        charges: null,
        credits: null,
        transactions: [
          {
            transactionDate: '2026-09-12',
            postedOn: null,
            merchant: 'DELTA AIR 0062345678901',
            amount: money(40_220, 'USD'),
            cardLastFour: '4417',
            reference: null,
          },
        ],
        model: null,
        version: null,
        costNanoUsd: null,
      });
    });
    const missing = () => withMember(app.db, self(org), (tx) => missingReceipts(tx, org.memberId));
    expect(await missing()).toEqual([]);
    await withMember(app.db, self(org), (tx) =>
      deleteReceipt(tx, org.orgId, fare.receiptId, org.userId),
    );
    expect((await missing()).map((t) => t.merchant)).toEqual(['DELTA AIR 0062345678901']);
  });
});
