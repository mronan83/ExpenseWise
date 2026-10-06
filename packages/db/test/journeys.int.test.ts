import { newId, NO_TRAVEL, type ExpenseTravel } from '@expensewise/domain';
import { and, eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { withOrg } from '../src/client.ts';
import { editExpense, getExpense, type ReceiptOffer } from '../src/expenses.ts';
import {
  confirmReceipt,
  fileReceipt,
  requestReceiptReading,
  settleReceipt,
} from '../src/receipts.ts';
import { auditEvents, expenses, receipts } from '../src/schema.ts';
import { createTrip } from '../src/trips.ts';
import { connectAs, seedOrg } from './helpers.ts';

const app = connectAs('app');
afterAll(async () => {
  await app.pool.end();
});

const FLIGHT: ExpenseTravel = { ...NO_TRAVEL, journeyFrom: 'SFO', journeyTo: 'ORD' };
const STAY: ExpenseTravel = { ...NO_TRAVEL, checkIn: '2026-09-29', checkOut: '2026-10-01' };
const TICKET = {
  merchant: 'United Airlines',
  transactionDate: '2026-09-28',
  currency: 'USD',
  amountMinor: 41_280,
};

type Org = Awaited<ReturnType<typeof seedOrg>>;
let files = 0;

/** Files a receipt and settles a reading of it, as the workflow does; returns the receipt. */
async function read(
  org: Org,
  offer: ReceiptOffer,
  receiptId = newId(),
  status: 'extracted' | 'needs_review' = 'extracted',
): Promise<{ receiptId: string; requestId: string }> {
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
        source: 'upload',
        storageKey: `orgs/${org.orgId}/receipts/${receiptId}`,
        contentType: 'application/pdf',
        byteSize: 2000,
        sha256: (++files).toString(16).padStart(64, 'b'),
      },
      org.userId,
    );
    if (filed.status !== 'filed') throw new Error('not filed');
    return filed.event.outboxId;
  });
  await withOrg(app.db, org.orgId, (tx) =>
    settleReceipt(tx, org.orgId, receiptId, { status, requestId, detail: {}, values: offer }),
  );
  return { receiptId, requestId };
}

const expenseOf = (org: Org, receiptId: string) =>
  withOrg(app.db, org.orgId, async (tx) => {
    const [receipt] = await tx.select().from(receipts).where(eq(receipts.id, receiptId));
    return getExpense(tx, receipt!.expenseId!);
  });

const travelOf = (e: Awaited<ReturnType<typeof expenseOf>>) => ({
  journeyFrom: e?.journeyFrom,
  journeyTo: e?.journeyTo,
  departsOn: e?.departsOn,
  checkIn: e?.checkIn,
  checkOut: e?.checkOut,
});

describe('a ticket read with the day it departs (FR-EXP-19, #94)', () => {
  it('files a fare read weeks before its trip to the trip it departs in, and a later reading moves it', async () => {
    const org = await seedOrg(app.db, 'journeys-departs');
    const trip = (name: string, startDate: string, endDate: string) =>
      withOrg(app.db, org.orgId, async (tx) => {
        const made = await createTrip(
          tx,
          org.orgId,
          org.memberId,
          { name, startDate, endDate },
          org.userId,
        );
        if (made.status !== 'saved') throw new Error('no trip');
        return made.tripId;
      });
    const chicago = await trip('Chicago', '2026-10-20', '2026-10-23');
    const denver = await trip('Denver', '2026-11-02', '2026-11-04');
    const fare = { ...TICKET, transactionDate: '2026-09-12' };
    const { receiptId } = await read(org, {
      ...fare,
      travel: { ...FLIGHT, departsOn: '2026-10-20' },
    });
    expect(await expenseOf(org, receiptId)).toMatchObject({
      transactionDate: '2026-09-12',
      departsOn: '2026-10-20',
      tripId: chicago,
    });
    await read(org, { ...fare, travel: { ...FLIGHT, departsOn: '2026-11-02' } }, receiptId);
    expect(await expenseOf(org, receiptId)).toMatchObject({ tripId: denver });
  });
});

describe('a journey and a stay on the expense (FR-INT-20, FR-INT-21)', () => {
  it('files them with the expense, a later reading refreshes them, and one not asked leaves them', async () => {
    const org = await seedOrg(app.db, 'journeys-file');
    const { receiptId } = await read(org, { ...TICKET, travel: FLIGHT });
    expect(await expenseOf(org, receiptId)).toMatchObject({ ...FLIGHT, status: 'ready' });

    await read(org, { ...TICKET, travel: { ...FLIGHT, journeyTo: 'MDW' } }, receiptId);
    expect(travelOf(await expenseOf(org, receiptId))).toEqual({ ...FLIGHT, journeyTo: 'MDW' });
    // A reading not asked for them, before the switch or with it off, leaves them as they are.
    await read(org, TICKET, receiptId);
    expect(travelOf(await expenseOf(org, receiptId))).toEqual({ ...FLIGHT, journeyTo: 'MDW' });

    // The two readings that changed them say so in the audit trail; the rest don't.
    const expenseId = (await expenseOf(org, receiptId))!.id;
    const filed = await withOrg(app.db, org.orgId, (tx) =>
      tx
        .select({ payload: auditEvents.payload })
        .from(auditEvents)
        .where(and(eq(auditEvents.entityId, expenseId), eq(auditEvents.action, 'expense.filed'))),
    );
    const travelled = filed.filter((e) => (e.payload as { travelled?: boolean }).travelled);
    expect([travelled.length, filed.length]).toEqual([2, 5]);
  });

  it('files none for a receipt read without them, as before', async () => {
    const org = await seedOrg(app.db, 'journeys-none');
    const { receiptId } = await read(org, TICKET);
    expect(travelOf(await expenseOf(org, receiptId))).toEqual(NO_TRAVEL);
  });

  it('files a stay as read, its dates as dates, and the stay of a reading confirmed', async () => {
    const org = await seedOrg(app.db, 'journeys-confirm');
    const folio = { ...TICKET, merchant: 'Hilton Omaha', transactionDate: '2026-10-01' };
    const { receiptId } = await read(org, folio, newId(), 'needs_review');
    expect(travelOf(await expenseOf(org, receiptId))).toEqual(NO_TRAVEL);
    const confirmed = await withOrg(app.db, org.orgId, (tx) =>
      confirmReceipt(
        tx,
        org.orgId,
        receiptId,
        {
          memberId: org.memberId,
          // Nothing read it here, so it is filled in by hand: the stay is the one confirmed.
          requestId: null,
          model: 'none',
          merchant: folio.merchant,
          transactionDate: folio.transactionDate,
          currency: 'USD',
          totalMinor: folio.amountMinor,
          taxMinor: null,
          tipMinor: null,
          corrections: [],
        },
        org.userId,
        undefined,
        STAY,
      ),
    );
    expect(confirmed).toBe('confirmed');
    expect(await expenseOf(org, receiptId)).toMatchObject({ ...STAY, status: 'ready' });
  });

  it('keeps a person’s edit over any later reading, records it, and refuses a stay that can’t be', async () => {
    const org = await seedOrg(app.db, 'journeys-edit');
    const { receiptId } = await read(org, { ...TICKET, travel: STAY });
    const expense = (await expenseOf(org, receiptId))!;
    const edit = (travel: Parameters<typeof editExpense>[3]['travel']) =>
      withOrg(app.db, org.orgId, (tx) =>
        editExpense(tx, org.orgId, expense.id, { travel }, org.userId),
      );

    expect(await edit({ checkOut: '2026-10-02', journeyTo: ' Hilton Omaha ' })).toEqual({
      status: 'edited',
      changes: [],
      detailChanges: [],
      travelChanges: [
        { field: 'journeyTo', from: null, to: 'Hilton Omaha' },
        { field: 'checkOut', from: '2026-10-01', to: '2026-10-02' },
      ],
    });
    expect(await edit({ checkOut: '2026-10-02' })).toEqual({ status: 'unchanged' });
    expect(await edit({ checkOut: '2026-09-28' })).toMatchObject({
      status: 'invalid',
      problem: { field: 'checkOut', message: 'Check-out is on or after check-in.' },
    });
    const [edited] = await withOrg(app.db, org.orgId, (tx) =>
      tx
        .select({ payload: auditEvents.payload })
        .from(auditEvents)
        .where(and(eq(auditEvents.entityId, expense.id), eq(auditEvents.action, 'expense.edited'))),
    );
    expect(edited?.payload).toMatchObject({
      travelChanges: [{ field: 'journeyTo' }, { field: 'checkOut', to: '2026-10-02' }],
    });

    await read(org, { ...TICKET, travel: STAY }, receiptId);
    expect(await expenseOf(org, receiptId)).toMatchObject({
      checkIn: '2026-09-29',
      checkOut: '2026-10-02',
      journeyTo: 'Hilton Omaha',
    });
  });

  it('keeps a stay’s days as dates, and no other kind of value', async () => {
    const org = await seedOrg(app.db, 'journeys-columns');
    const { receiptId } = await read(org, { ...TICKET, travel: STAY });
    const id = (await expenseOf(org, receiptId))!.id;
    await expect(
      withOrg(app.db, org.orgId, (tx) =>
        tx.update(expenses).set({ checkIn: 'Sep 29' }).where(eq(expenses.id, id)),
      ),
    ).rejects.toThrow();
  });
});
