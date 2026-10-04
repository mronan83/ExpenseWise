import { newId, type ExpenseDetails } from '@expensewise/domain';
import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { withOrg } from '../src/client.ts';
import { editExpense, getExpense, type ReceiptOffer } from '../src/expenses.ts';
import { fileReceipt, requestReceiptReading, settleReceipt } from '../src/receipts.ts';
import { expenses, receipts } from '../src/schema.ts';
import { connectAs, expectDbError, seedOrg } from './helpers.ts';

const app = connectAs('app');
afterAll(async () => {
  await app.pool.end();
});

const OMAHA: ExpenseDetails = {
  time: '18:42',
  timeZone: 'America/Chicago',
  address: 'Eppley Airfield, Omaha, NE',
  city: 'Omaha',
  region: 'NE',
  country: 'US',
};
const RIDE = {
  merchant: 'Uber',
  transactionDate: '2026-09-30',
  currency: 'USD',
  amountMinor: 3145,
};

type Org = Awaited<ReturnType<typeof seedOrg>>;
let files = 0;

/** Files a receipt and settles a reading of it, as the workflow does; returns the receipt. */
async function read(org: Org, offer: ReceiptOffer, receiptId = newId()): Promise<string> {
  const requestId = await withOrg(app.db, org.orgId, async (tx) => {
    const [known] = await tx.select().from(receipts).where(eq(receipts.id, receiptId));
    if (known) {
      const event = await requestReceiptReading(tx, org.orgId, receiptId, org.userId);
      return event!.outboxId;
    }
    const filed = await fileReceipt(
      tx,
      org.orgId,
      {
        id: receiptId,
        memberId: org.memberId,
        source: 'camera',
        storageKey: `orgs/${org.orgId}/receipts/${receiptId}`,
        contentType: 'image/jpeg',
        byteSize: 2000,
        sha256: (++files).toString(16).padStart(64, 'a'),
      },
      org.userId,
    );
    if (filed.status !== 'filed') throw new Error('not filed');
    return filed.event.outboxId;
  });
  await withOrg(app.db, org.orgId, (tx) =>
    settleReceipt(tx, org.orgId, receiptId, {
      status: 'extracted',
      requestId,
      detail: {},
      values: offer,
    }),
  );
  return receiptId;
}

const expenseOf = (org: Org, receiptId: string) =>
  withOrg(app.db, org.orgId, async (tx) => {
    const [receipt] = await tx.select().from(receipts).where(eq(receipts.id, receiptId));
    return getExpense(tx, receipt!.expenseId!);
  });

describe('the time and place a receipt prints (FR-INT-17)', () => {
  it('files them with the expense, and a later reading refreshes them', async () => {
    const org = await seedOrg(app.db, 'details-file');
    const receipt = await read(org, { ...RIDE, details: OMAHA });
    expect(await expenseOf(org, receipt)).toMatchObject({ ...OMAHA, status: 'ready' });

    await read(org, { ...RIDE, details: { ...OMAHA, time: '18:43' } }, receipt);
    expect((await expenseOf(org, receipt))?.time).toBe('18:43');
    // A reading that offers no time or place leaves them as they are.
    await read(org, RIDE, receipt);
    expect((await expenseOf(org, receipt))?.time).toBe('18:43');
  });

  it('keeps a person’s edit over any later reading, and refuses a malformed one', async () => {
    const org = await seedOrg(app.db, 'details-edit');
    const receipt = await read(org, { ...RIDE, details: OMAHA });
    const expense = (await expenseOf(org, receipt))!;
    const edit = (details: Parameters<typeof editExpense>[3]['details']) =>
      withOrg(app.db, org.orgId, (tx) =>
        editExpense(tx, org.orgId, expense.id, { details }, org.userId),
      );

    expect(await edit({ time: '7:05', timeZone: 'America/Denver' })).toEqual({
      status: 'edited',
      changes: [],
      detailChanges: [
        { field: 'time', from: '18:42', to: '07:05' },
        { field: 'timeZone', from: 'America/Chicago', to: 'America/Denver' },
      ],
    });
    expect(await edit({ time: '07:05' })).toEqual({ status: 'unchanged' });
    expect(await edit({ country: 'USA' })).toMatchObject({
      status: 'invalid',
      problem: { field: 'country' },
    });

    await read(org, { ...RIDE, details: { ...OMAHA, time: '20:00' } }, receipt);
    expect(await expenseOf(org, receipt)).toMatchObject({
      time: '07:05',
      timeZone: 'America/Denver',
      status: 'ready',
    });
  });

  it('stores a time of day and a two-letter country, and nothing else', async () => {
    const org = await seedOrg(app.db, 'details-checks');
    const receipt = await read(org, RIDE);
    const id = (await expenseOf(org, receipt))!.id;
    await expectDbError(
      withOrg(app.db, org.orgId, (tx) =>
        tx.update(expenses).set({ transactionTime: '25:00' }).where(eq(expenses.id, id)),
      ),
      /expenses_time_of_day/,
    );
    await expectDbError(
      withOrg(app.db, org.orgId, (tx) =>
        tx.update(expenses).set({ merchantCountry: 'us' }).where(eq(expenses.id, id)),
      ),
      /expenses_country_code/,
    );
  });
});
