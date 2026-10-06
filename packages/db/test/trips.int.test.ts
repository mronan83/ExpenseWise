import { amountMatches, newId, type ExpenseStatus } from '@expensewise/domain';
import { asc, eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { lockOrgWrites } from '../src/audit.ts';
import { withOrg } from '../src/client.ts';
import { editExpense, getExpense, listExpenses, listTripExpenses } from '../src/expenses.ts';
import { fileReceipt, getReceipt, recordExtractionRun, settleReceipt } from '../src/receipts.ts';
import { auditEvents, expenses, members, reports, trips } from '../src/schema.ts';
import {
  createTrip,
  deleteTrip,
  editTrip,
  fileExpenseToTrip,
  getTrip,
  listTrips,
  setExpenseTrip,
  tallyTrips,
} from '../src/trips.ts';
import { connectAs, seedOrg } from './helpers.ts';

const app = connectAs('app');
afterAll(async () => {
  await app.pool.end();
});

const houston = {
  name: 'Houston · Acme onsite',
  purpose: 'Client onsite',
  primaryCity: 'Houston',
  startDate: '2026-09-22',
  endDate: '2026-09-25',
};

/** A fresh organization, with helpers to make trips and expenses in it. */
async function workspace(name: string) {
  const org = await seedOrg(app.db, name);
  const inOrg = <T>(work: Parameters<typeof withOrg<T>>[2]) => withOrg(app.db, org.orgId, work);
  const actor = { type: 'user', id: org.userId } as const;

  const trip = async (input: Parameters<typeof createTrip>[3], memberId = org.memberId) => {
    const made = await inOrg((tx) => createTrip(tx, org.orgId, memberId, input, org.userId));
    if (made.status !== 'saved') throw new Error(`expected a trip, got ${made.status}`);
    return made.tripId;
  };
  /** An expense typed in by hand, filed by date as any expense is. */
  const expense = (
    date: string | null,
    over: {
      merchant?: string;
      amountMinor?: number;
      currency?: string;
      status?: ExpenseStatus;
      memberId?: string;
      departsOn?: string;
    } = {},
  ) =>
    inOrg(async (tx) => {
      const id = newId();
      await tx.insert(expenses).values({
        id,
        orgId: org.orgId,
        memberId: over.memberId ?? org.memberId,
        status: over.status ?? (date ? 'ready' : 'needs_review'),
        source: 'manual',
        merchant: over.merchant ?? 'Uber',
        transactionDate: date,
        departsOn: over.departsOn ?? null,
        currency: over.currency ?? 'USD',
        amountMinor: over.amountMinor ?? 3145,
      });
      await fileExpenseToTrip(tx, org.orgId, id, actor);
      return id;
    });
  const tripOf = async (expenseId: string) => {
    const e = await inOrg((tx) => getExpense(tx, expenseId));
    return { tripId: e!.tripId, tripName: e!.tripName, pinned: e!.tripPinned };
  };
  const audit = (action: string) =>
    inOrg((tx) =>
      tx
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.action, action))
        .orderBy(asc(auditEvents.sequence)),
    );
  const colleague = async (displayName: string) => {
    const id = newId();
    await inOrg((tx) =>
      tx.insert(members).values({
        id,
        orgId: org.orgId,
        userId: `user_${id}`,
        email: `${id}@example.com`,
        displayName,
        role: 'member',
      }),
    );
    return id;
  };
  return { org, inOrg, trip, expense, tripOf, audit, colleague };
}

const chicago = {
  name: 'Chicago · Client visit',
  purpose: 'Client visit',
  primaryCity: 'Chicago',
  startDate: '2026-10-20',
  endDate: '2026-10-23',
};

describe('a ticket files by the day it departs (FR-EXP-19, #94)', () => {
  it('files a fare bought weeks ahead to the trip it flies on, keeping the day it was charged', async () => {
    const w = await workspace('acme-fare-departs');
    const tripId = await w.trip(chicago);
    const fare = await w.expense('2026-09-12', { merchant: 'United', departsOn: '2026-10-20' });
    expect((await w.tripOf(fare)).tripId).toBe(tripId);
    const kept = await w.inOrg((tx) => getExpense(tx, fare));
    expect(kept).toMatchObject({ transactionDate: '2026-09-12', departsOn: '2026-10-20' });
    const [filed] = await w.audit('expense.trip_filed');
    expect(filed!.payload).toMatchObject({ tripId, date: '2026-10-20' });
    // With no departure, it files by the day it was charged, as any expense does.
    expect((await w.tripOf(await w.expense('2026-09-12'))).tripId).toBeNull();
  });

  it('files a fare when its trip is made, and moves it when its departure is corrected', async () => {
    const w = await workspace('acme-fare-later-trip');
    const fare = await w.expense('2026-09-12', { merchant: 'United', departsOn: '2026-10-20' });
    expect((await w.tripOf(fare)).tripId).toBeNull();
    const tripId = await w.trip(chicago);
    expect((await w.tripOf(fare)).tripId).toBe(tripId);
    const later = await w.trip({
      ...chicago,
      name: 'Denver · Offsite',
      startDate: '2026-11-02',
      endDate: '2026-11-04',
    });
    const moved = await w.inOrg((tx) =>
      editExpense(tx, w.org.orgId, fare, { travel: { departsOn: '2026-11-02' } }, w.org.userId),
    );
    expect(moved).toMatchObject({ status: 'edited' });
    expect((await w.tripOf(fare)).tripId).toBe(later);
  });

  it('keeps a fare a person put on a trip where they put it, whatever its departure', async () => {
    const w = await workspace('acme-fare-pinned');
    const houstonId = await w.trip(houston);
    const fare = await w.expense('2026-09-12', { merchant: 'United', departsOn: '2026-10-20' });
    await w.inOrg((tx) =>
      setExpenseTrip(tx, w.org.orgId, fare, { tripId: houstonId }, w.org.userId),
    );
    await w.trip(chicago);
    expect(await w.tripOf(fare)).toMatchObject({ tripId: houstonId, pinned: true });
  });
});

describe('filing expenses to trips by date (FR-EXP-04, ADR-0023)', () => {
  it('files the member’s expenses dated in a new trip, start and end days included', async () => {
    const w = await workspace('acme-trip-create');
    const first = await w.expense('2026-09-22');
    const last = await w.expense('2026-09-25');
    const before = await w.expense('2026-09-21');
    const undated = await w.expense(null);
    const theirs = await w.expense('2026-09-23', { memberId: await w.colleague('Jordan') });

    const tripId = await w.trip(houston);
    expect(await w.tripOf(first)).toEqual({ tripId, tripName: houston.name, pinned: false });
    expect((await w.tripOf(last)).tripId).toBe(tripId);
    expect((await w.tripOf(before)).tripId).toBeNull();
    expect((await w.tripOf(undated)).tripId).toBeNull();
    expect((await w.tripOf(theirs)).tripId).toBeNull();

    const [created] = await w.audit('trip.created');
    expect(created).toMatchObject({
      actorId: w.org.userId,
      entityId: tripId,
      payload: { memberId: w.org.memberId, name: { from: null, to: houston.name } },
    });
    const filed = await w.audit('expense.trip_filed');
    expect(filed.map((e) => e.entityId).sort()).toEqual([first, last].sort());
    expect(filed[0]!.payload).toMatchObject({ tripId, previous: null });
  });

  it('files a receipt read after the trip exists to it, with no human touch', async () => {
    const w = await workspace('acme-trip-receipt');
    const tripId = await w.trip(houston);
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
          byteSize: 1,
          sha256: id.replace(/-/g, '').padEnd(64, '0'),
        },
        w.org.userId,
      ),
    );
    if (filed.status !== 'filed') throw new Error('expected a new receipt');
    await w.inOrg(async (tx) => {
      await recordExtractionRun(tx, w.org.orgId, {
        receiptId: id,
        requestId: filed.event.outboxId,
        extractor: 'openai',
        model: 'gpt-5.6-luna',
        promptVersion: 'extract-v1',
        schemaVersion: 'v1',
        outcome: 'confident',
        output: {},
        fieldConfidence: {},
        error: null,
        latencyMs: 1,
        inputTokens: 1,
        outputTokens: 1,
        costMicroUsd: 1,
      });
      await settleReceipt(tx, w.org.orgId, id, {
        status: 'extracted',
        requestId: filed.event.outboxId,
        detail: {},
        values: {
          merchant: 'Hotel ZaZa',
          transactionDate: '2026-09-25',
          currency: 'USD',
          amountMinor: 49985,
        },
      });
    });
    const receipt = await w.inOrg((tx) => getReceipt(tx, id));
    const expense = await w.inOrg((tx) => getExpense(tx, receipt!.expenseId!));
    expect(expense).toMatchObject({ status: 'ready', tripId, tripName: houston.name });
    const [event] = await w.audit('expense.trip_filed');
    expect(event).toMatchObject({ actorType: 'system', actorId: 'receipt-workflow' });
  });

  it('files an expense whose date arrives while the trip is being made', async () => {
    const w = await workspace('acme-trip-race');
    const id = await w.expense(null);
    let made!: () => void;
    let commit!: () => void;
    const tripMade = new Promise<void>((resolve) => (made = resolve));
    const gate = new Promise<void>((resolve) => (commit = resolve));
    const creating = w.inOrg(async (tx) => {
      const result = await createTrip(tx, w.org.orgId, w.org.memberId, houston, w.org.userId);
      made();
      await gate;
      return result;
    });
    await tripMade;
    // The date arrives while the trip is still uncommitted; filing waits for it.
    const editing = w.inOrg((tx) =>
      editExpense(tx, w.org.orgId, id, { date: '2026-09-23' }, w.org.userId),
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    commit();
    const [created] = await Promise.all([creating, editing]);
    expect((await w.tripOf(id)).tripId).toBe(created.status === 'saved' ? created.tripId : 'none');
  });

  it('never deadlocks an edit to an expense against a trip filing it', async () => {
    const w = await workspace('acme-trip-deadlock');
    const id = await w.expense('2026-09-23');
    let holding!: () => void;
    let go!: () => void;
    const held = new Promise<void>((resolve) => (holding = resolve));
    const gate = new Promise<void>((resolve) => (go = resolve));
    // The trip's change holds the organization's write lock before it locks any expense.
    const creating = w.inOrg(async (tx) => {
      await lockOrgWrites(tx, w.org.orgId);
      holding();
      await gate;
      return createTrip(tx, w.org.orgId, w.org.memberId, houston, w.org.userId);
    });
    await held;
    // The edit must wait for that lock before it locks the expense, or each waits on the other.
    const editing = w.inOrg((tx) =>
      editExpense(tx, w.org.orgId, id, { amount: '1.00' }, w.org.userId),
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    go();
    const [created, edited] = await Promise.all([creating, editing]);
    expect(created).toMatchObject({ status: 'saved', refiled: 1 });
    expect(edited).toMatchObject({ status: 'edited' });
    expect((await w.tripOf(id)).tripId).toBe(created.status === 'saved' ? created.tripId : 'none');
  });

  it('moves an expense when its date is edited, onto a trip or off one', async () => {
    const w = await workspace('acme-trip-edit-date');
    const tripId = await w.trip(houston);
    const id = await w.expense('2026-09-20');
    const edit = (date: string) =>
      w.inOrg((tx) => editExpense(tx, w.org.orgId, id, { date }, w.org.userId));
    await edit('2026-09-24');
    expect((await w.tripOf(id)).tripId).toBe(tripId);
    await edit('2026-10-01');
    expect((await w.tripOf(id)).tripId).toBeNull();
    // An edit that leaves the date alone doesn't file again.
    const filed = (await w.audit('expense.trip_filed')).length;
    await w.inOrg((tx) => editExpense(tx, w.org.orgId, id, { amount: '1.00' }, w.org.userId));
    expect(await w.audit('expense.trip_filed')).toHaveLength(filed);
  });

  it('gives a day two trips share to the trip that ends first', async () => {
    const w = await workspace('acme-trip-shared-day');
    const checkout = await w.expense('2026-09-25', { merchant: 'Hotel ZaZa' });
    const houstonId = await w.trip(houston);
    const denverId = await w.trip({
      name: 'Denver',
      startDate: '2026-09-25',
      endDate: '2026-09-28',
    });
    const dinner = await w.expense('2026-09-26');
    expect((await w.tripOf(checkout)).tripId).toBe(houstonId);
    expect((await w.tripOf(dinner)).tripId).toBe(denverId);
    // A short trip inside a longer one keeps its own days.
    const dayTrip = await w.trip({
      name: 'Boulder',
      startDate: '2026-09-26',
      endDate: '2026-09-26',
    });
    expect((await w.tripOf(dinner)).tripId).toBe(dayTrip);
  });

  it('files again when a trip’s dates change, and records each change', async () => {
    const w = await workspace('acme-trip-redate');
    const tripId = await w.trip(houston);
    const early = await w.expense('2026-09-21');
    const late = await w.expense('2026-09-25');
    const save = (input: Parameters<typeof editTrip>[3]) =>
      w.inOrg((tx) => editTrip(tx, w.org.orgId, tripId, input, w.org.userId));

    expect(await save({ startDate: '2026-09-21', endDate: '2026-09-24' })).toEqual({
      status: 'saved',
      tripId,
      refiled: 2,
    });
    expect((await w.tripOf(early)).tripId).toBe(tripId);
    expect((await w.tripOf(late)).tripId).toBeNull();
    expect(await save({ name: 'Houston' })).toEqual({ status: 'saved', tripId, refiled: 0 });
    expect(await save({ name: 'Houston' })).toEqual({ status: 'unchanged', tripId });
    expect(await save({ endDate: '2026-09-01' })).toMatchObject({
      status: 'invalid',
      problem: { field: 'endDate' },
    });
    expect(
      await w.inOrg((tx) => editTrip(tx, w.org.orgId, newId(), { name: 'x' }, w.org.userId)),
    ).toEqual({ status: 'missing' });
    const edits = await w.audit('trip.edited');
    expect(edits.map((e) => e.payload)).toEqual([
      {
        startDate: { from: '2026-09-22', to: '2026-09-21' },
        endDate: { from: '2026-09-25', to: '2026-09-24' },
      },
      { name: { from: houston.name, to: 'Houston' } },
    ]);
  });
});

describe('a person choosing an expense’s trip (ADR-0023)', () => {
  it('keeps an expense on the trip a person chose, whatever its date', async () => {
    const w = await workspace('acme-trip-pin');
    const tripId = await w.trip(houston);
    const airfare = await w.expense('2026-08-30', { merchant: 'United' });
    const set = (choice: Parameters<typeof setExpenseTrip>[3], id = airfare) =>
      w.inOrg((tx) => setExpenseTrip(tx, w.org.orgId, id, choice, w.org.userId));

    expect(await set({ tripId })).toEqual({ status: 'set', tripId, pinned: true });
    expect(await set({ tripId })).toEqual({ status: 'unchanged' });
    await w.inOrg((tx) =>
      editExpense(tx, w.org.orgId, airfare, { date: '2026-08-31' }, w.org.userId),
    );
    await w.inOrg((tx) =>
      editTrip(tx, w.org.orgId, tripId, { startDate: '2026-09-21' }, w.org.userId),
    );
    expect(await w.tripOf(airfare)).toMatchObject({ tripId, pinned: true });

    // Handed back to filing by date, it leaves the trip its date isn't in.
    expect(await set({ byDate: true })).toEqual({ status: 'set', tripId: null, pinned: false });
    const [event] = (await w.audit('expense.trip_set')).slice(-1);
    expect(event!.payload).toEqual({ tripId: null, previous: tripId, byDate: true });
  });

  it('keeps an expense a person took off a trip off it', async () => {
    const w = await workspace('acme-trip-unpin');
    const tripId = await w.trip(houston);
    const personal = await w.expense('2026-09-23');
    expect((await w.tripOf(personal)).tripId).toBe(tripId);
    await w.inOrg((tx) =>
      setExpenseTrip(tx, w.org.orgId, personal, { tripId: null }, w.org.userId),
    );
    await w.inOrg((tx) =>
      editTrip(tx, w.org.orgId, tripId, { endDate: '2026-09-26' }, w.org.userId),
    );
    expect(await w.tripOf(personal)).toEqual({ tripId: null, tripName: null, pinned: true });
  });

  it('refuses a trip that is someone else’s or doesn’t exist, and a submitted expense', async () => {
    const w = await workspace('acme-trip-pin-refused');
    const jordan = await w.colleague('Jordan');
    const theirTrip = await w.trip(houston, jordan);
    const mine = await w.expense('2026-09-23');
    const submitted = await w.expense('2026-09-23', { status: 'submitted' });
    const set = (id: string, tripId: string | null) =>
      w.inOrg((tx) => setExpenseTrip(tx, w.org.orgId, id, { tripId }, w.org.userId));
    expect(await set(mine, theirTrip)).toEqual({ status: 'other_member' });
    expect(await set(mine, newId())).toEqual({ status: 'no_such_trip' });
    expect(await set(submitted, null)).toEqual({ status: 'not_movable', current: 'submitted' });
    expect(await set(newId(), null)).toEqual({ status: 'missing' });
  });

  it('never moves a submitted expense by date', async () => {
    const w = await workspace('acme-trip-submitted');
    const submitted = await w.expense('2026-09-23', { status: 'submitted' });
    await w.trip(houston);
    expect((await w.tripOf(submitted)).tripId).toBeNull();
  });
});

describe('deleting a trip', () => {
  it('files its expenses by date again, a person’s choice of it included', async () => {
    const w = await workspace('acme-trip-delete');
    const outer = await w.trip({ name: 'Texas', startDate: '2026-09-20', endDate: '2026-09-30' });
    const tripId = await w.trip(houston);
    const lunch = await w.expense('2026-09-23');
    const airfare = await w.expense('2026-08-30');
    await w.inOrg((tx) => setExpenseTrip(tx, w.org.orgId, airfare, { tripId }, w.org.userId));
    expect((await w.tripOf(lunch)).tripId).toBe(tripId);

    expect(await w.inOrg((tx) => deleteTrip(tx, w.org.orgId, tripId, w.org.userId))).toEqual({
      status: 'deleted',
      refiled: 1,
    });
    expect(await w.tripOf(lunch)).toMatchObject({ tripId: outer, pinned: false });
    expect(await w.tripOf(airfare)).toEqual({ tripId: null, tripName: null, pinned: false });
    expect(await w.inOrg((tx) => getTrip(tx, tripId))).toBeUndefined();
    const [deleted] = await w.audit('trip.deleted');
    expect(deleted).toMatchObject({ entityId: tripId, payload: { name: houston.name } });
    expect(await w.inOrg((tx) => deleteTrip(tx, w.org.orgId, tripId, w.org.userId))).toEqual({
      status: 'missing',
    });
  });

  it('refuses while a submitted expense rests on it, and reopens a closed report it was on', async () => {
    const w = await workspace('acme-trip-delete-refused');
    const tripId = await w.trip(houston);
    const id = await w.expense('2026-09-23');
    await w.inOrg((tx) =>
      tx.update(expenses).set({ status: 'submitted' }).where(eq(expenses.id, id)),
    );
    const remove = () => w.inOrg((tx) => deleteTrip(tx, w.org.orgId, tripId, w.org.userId));
    expect(await remove()).toEqual({ status: 'has_submitted', count: 1 });

    // A trip on a closed report can go: the report reopens, as for any change to it.
    const other = await w.trip({ name: 'Denver', startDate: '2026-10-05', endDate: '2026-10-07' });
    const [report] = await w.inOrg((tx) =>
      tx
        .insert(reports)
        .values({
          orgId: w.org.orgId,
          memberId: w.org.memberId,
          title: 'Denver',
          currency: 'USD',
          status: 'closed',
          closesAt: new Date('2026-11-01T12:00:00Z'),
          closedAt: new Date('2026-10-10T12:00:00Z'),
        })
        .returning({ id: reports.id }),
    );
    await w.inOrg((tx) =>
      tx.update(trips).set({ reportId: report!.id }).where(eq(trips.id, other)),
    );
    expect(await w.inOrg((tx) => deleteTrip(tx, w.org.orgId, other, w.org.userId))).toEqual({
      status: 'deleted',
      refiled: 0,
    });
    const [after] = await w.inOrg((tx) =>
      tx.select({ status: reports.status }).from(reports).where(eq(reports.id, report!.id)),
    );
    expect(after?.status).toBe('open');
  });
});

describe('trip history and search (FR-INS-02)', () => {
  it('finds trips by name, purpose, city or a merchant on them, and by dates', async () => {
    const w = await workspace('acme-trip-search');
    const h = await w.trip(houston);
    const d = await w.trip({
      name: 'Denver offsite',
      purpose: 'Team planning',
      primaryCity: 'Denver',
      startDate: '2026-10-05',
      endDate: '2026-10-07',
    });
    await w.expense('2026-09-24', { merchant: 'Pappas Bros. Steakhouse' });
    const find = (filter: Parameters<typeof listTrips>[2]) =>
      w.inOrg(async (tx) => (await listTrips(tx, 50, filter)).map((t) => t.id));

    expect(await find({})).toEqual([d, h]);
    expect(await find({ q: 'denver' })).toEqual([d]);
    expect(await find({ q: 'PLANNING' })).toEqual([d]);
    expect(await find({ q: 'onsite' })).toEqual([h]);
    expect(await find({ q: 'pappas' })).toEqual([h]);
    expect(await find({ q: '%' })).toEqual([]);
    expect(await find({ q: 'zzz' })).toEqual([]);
    expect(await find({ from: '2026-09-25' })).toEqual([d, h]);
    expect(await find({ from: '2026-09-26' })).toEqual([d]);
    expect(await find({ to: '2026-09-22' })).toEqual([h]);
    expect(await find({ from: '2026-09-26', to: '2026-10-04' })).toEqual([]);
    const [trip] = await w.inOrg((tx) => listTrips(tx, 1));
    expect(trip).toMatchObject({ owner: 'acme-trip-search', name: 'Denver offsite' });
  });

  it('finds expenses by merchant, dates, amount in any currency, trip, or on no trip', async () => {
    const w = await workspace('acme-expense-search');
    const tripId = await w.trip(houston);
    const lunch = await w.expense('2026-09-23', { merchant: 'Local Foods', amountMinor: 1892 });
    const dinar = await w.expense('2026-09-01', {
      merchant: 'Talabat',
      amountMinor: 18920,
      currency: 'KWD',
    });
    const yen = await w.expense('2026-08-01', {
      merchant: 'Lawson 100%',
      amountMinor: 1892,
      currency: 'JPY',
    });
    const find = (filter: Parameters<typeof listExpenses>[2]) =>
      w.inOrg(async (tx) => (await listExpenses(tx, 50, filter)).map((e) => e.id).sort());

    expect(await find({ q: 'local' })).toEqual([lunch]);
    expect(await find({ q: '100%' })).toEqual([yen]);
    expect(await find({ q: '%' })).toEqual([yen]);
    expect(await find({ from: '2026-09-01' })).toEqual([lunch, dinar].sort());
    expect(await find({ to: '2026-09-01' })).toEqual([dinar, yen].sort());
    expect(await find({ amounts: amountMatches('18.92')! })).toEqual([lunch, dinar].sort());
    expect(await find({ amounts: amountMatches('1892')! })).toEqual([yen]);
    expect(await find({ amounts: [] })).toEqual([]);
    expect(await find({ tripId })).toEqual([lunch]);
    expect(await find({ q: 'local', tripId, amounts: amountMatches('18.92')! })).toEqual([lunch]);
    expect(await find({ onTrip: true })).toEqual([lunch]);
    expect(await find({ onTrip: false })).toEqual([dinar, yen].sort());
  });

  it('lists a trip’s expenses by date and tallies them by currency and status', async () => {
    const w = await workspace('acme-trip-tally');
    const tripId = await w.trip(houston);
    const late = await w.expense('2026-09-25', { amountMinor: 49985 });
    const early = await w.expense('2026-09-22', { amountMinor: 41220 });
    const euro = await w.expense('2026-09-23', {
      amountMinor: 1200,
      currency: 'EUR',
      status: 'needs_review',
    });
    const undated = await w.expense(null);
    await w.inOrg((tx) => setExpenseTrip(tx, w.org.orgId, undated, { tripId }, w.org.userId));

    const listed = await w.inOrg((tx) => listTripExpenses(tx, tripId));
    expect(listed.map((e) => e.id)).toEqual([early, euro, late, undated]);
    const tally = await w.inOrg((tx) => tallyTrips(tx, [tripId]));
    expect(tally).toEqual(
      expect.arrayContaining([
        { tripId, status: 'ready', currency: 'USD', count: 2, amountMinor: 91205 },
        { tripId, status: 'needs_review', currency: 'EUR', count: 1, amountMinor: 1200 },
        { tripId, status: 'needs_review', currency: 'USD', count: 1, amountMinor: 3145 },
      ]),
    );
    expect(tally).toHaveLength(3);
    expect(await w.inOrg((tx) => tallyTrips(tx, []))).toEqual([]);
  });

  it('keeps trips inside their organization', async () => {
    const w = await workspace('acme-trip-rls');
    const tripId = await w.trip(houston);
    const other = await seedOrg(app.db, 'globex-trip-rls');
    expect(await withOrg(app.db, other.orgId, (tx) => getTrip(tx, tripId))).toBeUndefined();
    expect(await withOrg(app.db, other.orgId, (tx) => listTrips(tx, 10))).toEqual([]);
    expect(await withOrg(app.db, other.orgId, (tx) => tallyTrips(tx, [tripId]))).toEqual([]);
  });
});
