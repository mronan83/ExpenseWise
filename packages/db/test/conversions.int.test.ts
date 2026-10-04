import { euroRate, newId } from '@expensewise/domain';
import { asc, eq, sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { withMember, withOrg } from '../src/client.ts';
import {
  CONVERSION_FLAG,
  CONVERSIONS_DUE,
  conversionWorkDue,
  convertAmounts,
  getReimbursementCurrency,
  requestConversions,
  setReimbursementCurrency,
} from '../src/conversions.ts';
import { editExpense } from '../src/expenses.ts';
import { FEATURE_SWITCHED, featureOn, setOrgFeature } from '../src/features.ts';
import { listReportAmounts } from '../src/report-amounts.ts';
import { closeReport, moveToReport, runReportSchedule } from '../src/reports.ts';
import {
  auditEvents,
  expenseConversions,
  expenses,
  outboxEvents,
  receipts,
  reports,
} from '../src/schema.ts';
import { createTrip, fileExpenseToTrip } from '../src/trips.ts';
import { connectAs, expectDbError, seedOrg } from './helpers.ts';

const app = connectAs('app');
afterAll(async () => {
  await app.pool.end();
});

/** Omaha, 29 Sep to 1 Oct 2026: it joins a report on 3 Oct at noon UTC. */
const OMAHA = { name: 'Omaha', startDate: '2026-09-26', endDate: '2026-10-01' };
const JOINS = new Date('2026-10-03T12:00:00Z');
const LATER = new Date('2026-10-04T09:00:00Z');

// What the ECB published on Friday 25 and Monday 28 September 2026.
const PUBLISHED = {
  asked: [
    { date: '2026-09-27', currencies: ['GBP', 'USD'] as const },
    { date: '2026-09-28', currencies: ['USD'] as const },
  ],
  rates: [
    euroRate({ currency: 'USD', date: '2026-09-25', rate: '1.1712' }),
    euroRate({ currency: 'GBP', date: '2026-09-25', rate: '0.87265' }),
    euroRate({ currency: 'USD', date: '2026-09-28', rate: '1.1723' }),
  ],
};

async function workspace(name: string, { on = true } = {}) {
  const org = await seedOrg(app.db, name);
  const inOrg = <T>(work: Parameters<typeof withOrg<T>>[2]) => withOrg(app.db, org.orgId, work);
  const actor = { type: 'user', id: org.userId } as const;
  if (on) {
    await inOrg((tx) =>
      setOrgFeature(
        tx,
        org.orgId,
        { flag: CONVERSION_FLAG, enabled: true, memberId: org.memberId },
        org.userId,
      ),
    );
  }
  const made = await inOrg((tx) => createTrip(tx, org.orgId, org.memberId, OMAHA, org.userId));
  if (made.status !== 'saved') throw new Error('no trip');
  const expense = (date: string, currency: string, amountMinor: number) =>
    inOrg(async (tx) => {
      const id = newId();
      await tx.insert(expenses).values({
        id,
        orgId: org.orgId,
        memberId: org.memberId,
        status: 'ready',
        source: 'manual',
        merchant: `${currency} ${amountMinor}`,
        transactionDate: date,
        currency,
        amountMinor,
      });
      await fileExpenseToTrip(tx, org.orgId, id, actor);
      return id;
    });
  const convert = (now = LATER, fetched?: Parameters<typeof convertAmounts>[3]) =>
    inOrg((tx) => convertAmounts(tx, org.orgId, now, fetched));
  const conversion = async (expenseId: string) =>
    (
      await inOrg((tx) =>
        tx.select().from(expenseConversions).where(eq(expenseConversions.expenseId, expenseId)),
      )
    )[0];
  const actions = (entityId: string) =>
    inOrg(async (tx) =>
      (
        await tx
          .select({ action: auditEvents.action, payload: auditEvents.payload })
          .from(auditEvents)
          .where(eq(auditEvents.entityId, entityId))
          .orderBy(asc(auditEvents.sequence))
      ).map((e) => e.action),
    );
  const requests = () =>
    inOrg(
      async (tx) =>
        (
          await tx
            .select({ topic: outboxEvents.topic })
            .from(outboxEvents)
            .where(eq(outboxEvents.topic, CONVERSIONS_DUE))
        ).length,
    );
  const reportOf = async () => {
    const [row] = await inOrg((tx) =>
      tx.select({ id: reports.id, currency: reports.currency }).from(reports),
    );
    return row;
  };
  return {
    org,
    inOrg,
    trip: made.tripId,
    expense,
    convert,
    conversion,
    actions,
    requests,
    reportOf,
  };
}

describe('the currency a person is reimbursed in (FR-EXP-13, Q23)', () => {
  it('starts as the organization’s home currency, and is the person’s own once chosen', async () => {
    const w = await workspace('fx-choose');
    const at = (memberId: string) => w.inOrg((tx) => getReimbursementCurrency(tx, memberId));
    expect(await at(w.org.memberId)).toEqual({
      currency: 'USD',
      chosen: null,
      homeCurrency: 'USD',
    });
    const set = await w.inOrg((tx) =>
      setReimbursementCurrency(tx, w.org.orgId, w.org.memberId, 'EUR', w.org.userId),
    );
    expect(set).toMatchObject({ status: 'set', currency: { currency: 'EUR', chosen: 'EUR' } });
    expect(
      await w.inOrg((tx) =>
        setReimbursementCurrency(tx, w.org.orgId, w.org.memberId, 'EUR', w.org.userId),
      ),
    ).toMatchObject({ status: 'unchanged' });
    await w.inOrg((tx) =>
      setReimbursementCurrency(tx, w.org.orgId, w.org.memberId, null, w.org.userId),
    );
    expect((await at(w.org.memberId))?.currency).toBe('USD');
    expect(await w.actions(w.org.memberId)).toEqual([
      'member.reimbursement_currency_set',
      'member.reimbursement_currency_set',
    ]);
    expect(await at(newId())).toBeUndefined();
    await expect(
      w.inOrg((tx) =>
        setReimbursementCurrency(tx, w.org.orgId, w.org.memberId, 'XYZ', w.org.userId),
      ),
    ).rejects.toThrow(/Unsupported currency/);
  });

  it('moves open and closed reports to a new choice, and leaves a submitted one as it was', async () => {
    const w = await workspace('fx-follow');
    await w.expense('2026-09-28', 'USD', 4500);
    await runReportSchedule(app.db, w.org.orgId, JOINS);
    const first = (await w.reportOf())!;
    expect(first.currency).toBe('USD');
    // A second report, closed; and a third, submitted.
    const lunch = await w.expense('2026-09-01', 'USD', 1225);
    await w.inOrg(async (tx) => {
      await tx.update(expenses).set({ justification: 'Team lunch' }).where(eq(expenses.id, lunch));
      return moveToReport(tx, w.org.orgId, { expenseId: lunch }, { newReport: true }, w.org.userId);
    });
    const all = await w.inOrg((tx) => tx.select().from(reports).orderBy(asc(reports.createdAt)));
    const second = all.find((r) => r.id !== first.id)!;
    expect(await w.inOrg((tx) => closeReport(tx, w.org.orgId, second.id, w.org.userId))).toEqual({
      status: 'closed',
    });
    const submitted = newId();
    await w.inOrg((tx) =>
      tx.insert(reports).values({
        id: submitted,
        orgId: w.org.orgId,
        memberId: w.org.memberId,
        title: 'Submitted',
        status: 'submitted',
        currency: 'USD',
        closesAt: JOINS,
        closedAt: JOINS,
        submittedAt: JOINS,
      }),
    );

    const set = await w.inOrg((tx) =>
      setReimbursementCurrency(tx, w.org.orgId, w.org.memberId, 'GBP', w.org.userId),
    );
    expect(set.status === 'set' && [...set.reports].sort()).toEqual([first.id, second.id].sort());
    const after = await w.inOrg((tx) => tx.select().from(reports));
    expect(Object.fromEntries(after.map((r) => [r.id, r.currency]))).toEqual({
      [first.id]: 'GBP',
      [second.id]: 'GBP',
      [submitted]: 'USD',
    });
    expect(await w.actions(first.id)).toContain('report.currency_changed');
    // Its amounts now wait for a rate, so the workflow is asked to convert them.
    expect(set.status === 'set' && set.event?.topic).toBe(CONVERSIONS_DUE);
  });

  it('opens a new report in the person’s currency while the feature is on, and the home currency while off', async () => {
    const on = await workspace('fx-open-on');
    await on.inOrg((tx) =>
      setReimbursementCurrency(tx, on.org.orgId, on.org.memberId, 'EUR', on.org.userId),
    );
    await on.expense('2026-09-28', 'USD', 4500);
    await runReportSchedule(app.db, on.org.orgId, JOINS);
    expect((await on.reportOf())?.currency).toBe('EUR');

    const off = await workspace('fx-open-off', { on: false });
    await off.inOrg((tx) =>
      tx.execute(
        sql`update members set reimbursement_currency = 'EUR' where id = ${off.org.memberId}`,
      ),
    );
    await off.expense('2026-09-28', 'USD', 4500);
    await runReportSchedule(app.db, off.org.orgId, JOINS);
    expect((await off.reportOf())?.currency).toBe('USD');
  });
});

describe('converting a report’s amounts (FR-EXP-13, Q25, NFR-DAT-02, NFR-DAT-04)', () => {
  it('converts at the purchase date’s reference rate, or the last one before it, and copies the rate on', async () => {
    const w = await workspace('fx-convert');
    const sunday = await w.expense('2026-09-27', 'EUR', 41280);
    const monday = await w.expense('2026-09-28', 'EUR', 2000);
    const dollars = await w.expense('2026-09-29', 'USD', 3145);
    await runReportSchedule(app.db, w.org.orgId, JOINS);

    // Nothing is known yet: the rates are asked for, and nothing is recorded.
    expect(await w.convert()).toEqual({
      skipped: false,
      followed: 0,
      converted: 0,
      unavailable: 0,
      needed: [
        { date: '2026-09-27', currencies: ['USD'] },
        { date: '2026-09-28', currencies: ['USD'] },
      ],
    });
    expect(await w.conversion(sunday)).toBeUndefined();

    expect(await w.convert(LATER, PUBLISHED)).toMatchObject({ converted: 2, needed: [] });
    expect(await w.conversion(sunday)).toMatchObject({
      amountMinor: 41280,
      currency: 'EUR',
      purchaseDate: '2026-09-27',
      reimbursementCurrency: 'USD',
      outcome: 'converted',
      convertedMinor: 48347,
      rate: '1.1712',
      rateDate: '2026-09-25',
      source: 'ECB',
    });
    expect(await w.conversion(monday)).toMatchObject({ rate: '1.1723', rateDate: '2026-09-28' });
    expect(await w.conversion(dollars)).toBeUndefined();
    expect(await w.actions(sunday)).toContain('expense.converted');

    // The report lists each amount with what was recorded for it.
    const report = (await w.reportOf())!;
    const amounts = await w.inOrg((tx) => listReportAmounts(tx, [report.id]));
    expect(amounts.map((a) => [a.currency, a.conversion?.outcome ?? null])).toEqual([
      ['EUR', 'converted'],
      ['EUR', 'converted'],
      ['USD', null],
    ]);
  });

  it('keeps the rate it converted at when rates move, and applies it again to an edited amount', async () => {
    const w = await workspace('fx-keep');
    const sunday = await w.expense('2026-09-27', 'EUR', 41280);
    await runReportSchedule(app.db, w.org.orgId, JOINS);
    await w.convert(LATER, PUBLISHED);
    const moved = {
      asked: PUBLISHED.asked,
      rates: [euroRate({ currency: 'USD', date: '2026-09-25', rate: '1.2500' })],
    };
    expect(await w.convert(LATER, moved)).toMatchObject({ converted: 0, needed: [] });
    expect(await w.conversion(sunday)).toMatchObject({ rate: '1.1712', convertedMinor: 48347 });

    const edited = await w.inOrg((tx) =>
      editExpense(tx, w.org.orgId, sunday, { amount: '420.00' }, w.org.userId),
    );
    expect(edited.status).toBe('edited');
    // No rate needs fetching: the one recorded for that day applies to the new amount.
    expect(await w.convert(LATER)).toMatchObject({ converted: 1, needed: [] });
    expect(await w.conversion(sunday)).toMatchObject({
      amountMinor: 42000,
      rate: '1.1712',
      rateDate: '2026-09-25',
      convertedMinor: 49190,
    });
  });

  it('records a currency the source has no rate for, or a day with none in reach, as unconverted', async () => {
    const w = await workspace('fx-none');
    const dirhams = await w.expense('2026-09-29', 'AED', 18500);
    const early = await w.expense('2026-09-26', 'GBP', 900);
    await runReportSchedule(app.db, w.org.orgId, JOINS);
    // Dirhams aren't published: recorded as such without asking the source.
    expect(await w.convert()).toMatchObject({
      unavailable: 1,
      needed: [{ date: '2026-09-26', currencies: ['GBP', 'USD'] }],
    });
    expect(await w.conversion(dirhams)).toMatchObject({
      outcome: 'unavailable',
      rate: null,
      rateDate: null,
      convertedMinor: null,
      source: 'ECB',
    });
    // Asked, and nothing published for pounds in the ten days before: unconverted too.
    const asked = {
      asked: [{ date: '2026-09-26', currencies: ['GBP', 'USD'] as const }],
      rates: [],
    };
    expect(await w.convert(LATER, asked)).toMatchObject({ unavailable: 1, needed: [] });
    expect(await w.conversion(early)).toMatchObject({ outcome: 'unavailable' });
    expect(await w.actions(early)).toContain('expense.not_converted');
  });

  it('waits for the day after a purchase before asking for its rate', async () => {
    const w = await workspace('fx-wait');
    await w.expense('2026-09-30', 'EUR', 1000);
    await runReportSchedule(app.db, w.org.orgId, JOINS);
    expect((await w.convert(new Date('2026-09-30T20:00:00Z'))).needed).toEqual([]);
    expect((await w.convert(new Date('2026-10-01T00:00:00Z'))).needed).toEqual([
      { date: '2026-09-30', currencies: ['USD'] },
    ]);
  });

  it('does nothing while the feature is off', async () => {
    const w = await workspace('fx-off', { on: false });
    await w.expense('2026-09-27', 'EUR', 41280);
    await runReportSchedule(app.db, w.org.orgId, JOINS);
    expect(await w.convert(LATER, PUBLISHED)).toEqual({
      skipped: true,
      followed: 0,
      converted: 0,
      unavailable: 0,
      needed: [],
    });
    expect(await w.inOrg((tx) => requestConversions(tx, w.org.orgId, LATER))).toBeNull();
    expect(await w.requests()).toBe(0);
    expect(await w.inOrg((tx) => featureOn(tx, w.org.orgId, CONVERSION_FLAG))).toBe(false);
    expect(
      await w.inOrg((tx) =>
        featureOn(tx, w.org.orgId, CONVERSION_FLAG, 'reports.currency-conversion=on'),
      ),
    ).toBe(true);
  });

  it('refuses a converted amount without its rate, the rate’s date or its source', async () => {
    const w = await workspace('fx-refuse');
    const id = await w.expense('2026-09-27', 'EUR', 41280);
    const row = {
      orgId: w.org.orgId,
      expenseId: id,
      amountMinor: 41280,
      currency: 'EUR',
      purchaseDate: '2026-09-27',
      reimbursementCurrency: 'USD',
      outcome: 'converted' as const,
      convertedMinor: 48347,
      rate: '1.1712',
      rateDate: '2026-09-25',
      source: 'ECB',
    };
    for (const missing of [{ rate: null }, { rateDate: null }, { convertedMinor: null }]) {
      await expectDbError(
        w.inOrg((tx) => tx.insert(expenseConversions).values({ ...row, ...missing })),
        /expense_conversions_rate_complete/,
      );
    }
    await expectDbError(
      w.inOrg((tx) => tx.insert(expenseConversions).values({ ...row, source: ' ' })),
      /expense_conversions_source_named/,
    );
    await expectDbError(
      w.inOrg((tx) => tx.insert(expenseConversions).values({ ...row, rateDate: '2026-09-28' })),
      /expense_conversions_rate_complete/,
    );
    await expectDbError(
      w.inOrg((tx) =>
        tx.insert(expenseConversions).values({ ...row, reimbursementCurrency: 'EUR' }),
      ),
      /expense_conversions_two_currencies/,
    );
    await w.inOrg((tx) => tx.insert(expenseConversions).values(row));
  });
});

describe('asking for conversions (ADR-0034)', () => {
  it('asks when something on a report changes, and the sweep finds the organization until it is converted', async () => {
    const w = await workspace('fx-ask');
    const off = await workspace('fx-ask-off', { on: false });
    const sunday = await w.expense('2026-09-27', 'EUR', 41280);
    await off.expense('2026-09-27', 'EUR', 41280);
    await runReportSchedule(app.db, w.org.orgId, JOINS);
    await runReportSchedule(app.db, off.org.orgId, JOINS);
    // The trip joining its report asked for it.
    expect(await w.requests()).toBe(1);
    expect(await off.requests()).toBe(0);

    const due = await conversionWorkDue(app.db, LATER, false);
    expect(due).toContain(w.org.orgId);
    expect(due).not.toContain(off.org.orgId);
    expect(await conversionWorkDue(app.db, LATER, true)).toContain(off.org.orgId);

    await w.convert(LATER, PUBLISHED);
    expect(await conversionWorkDue(app.db, LATER, false)).not.toContain(w.org.orgId);
    // An edit on the report asks again, and the sweep sees it until it is recorded.
    await w.inOrg((tx) => editExpense(tx, w.org.orgId, sunday, { amount: '420.00' }, w.org.userId));
    expect(await w.requests()).toBe(2);
    expect(await conversionWorkDue(app.db, LATER, false)).toContain(w.org.orgId);
    // An edit that leaves nothing to convert asks for nothing.
    await w.convert(LATER);
    await w.inOrg((tx) =>
      editExpense(tx, w.org.orgId, sunday, { merchant: 'Lufthansa' }, w.org.userId),
    );
    expect(await w.requests()).toBe(2);
  });

  it('announces a feature switched on or off', async () => {
    const w = await workspace('fx-switch', { on: false });
    await w.inOrg((tx) =>
      setOrgFeature(
        tx,
        w.org.orgId,
        { flag: CONVERSION_FLAG, enabled: true, memberId: w.org.memberId },
        w.org.userId,
      ),
    );
    const events = await w.inOrg((tx) =>
      tx
        .select({ payload: outboxEvents.payload })
        .from(outboxEvents)
        .where(eq(outboxEvents.topic, FEATURE_SWITCHED)),
    );
    expect(events.map((e) => e.payload)).toEqual([{ flag: CONVERSION_FLAG, enabled: true }]);
  });

  it('goes with its expense when its member deletes the receipt that proves it', async () => {
    const w = await workspace('fx-delete');
    const id = await w.expense('2026-09-27', 'EUR', 41280);
    await runReportSchedule(app.db, w.org.orgId, JOINS);
    await w.convert(LATER, PUBLISHED);
    const receiptId = newId();
    await w.inOrg((tx) =>
      tx.insert(receipts).values({
        id: receiptId,
        orgId: w.org.orgId,
        memberId: w.org.memberId,
        expenseId: id,
        source: 'upload',
        storageKey: `orgs/${w.org.orgId}/receipts/${receiptId}`,
        contentType: 'application/pdf',
        byteSize: 100,
        sha256: 'a'.repeat(64),
        status: 'extracted',
      }),
    );
    // As the API deletes it: as the member, under the own-records rules (ADR-0035).
    const member = { orgId: w.org.orgId, memberId: w.org.memberId, role: 'owner' as const };
    await withMember(app.db, member, (tx) =>
      tx.execute(sql`select * from delete_receipt(${receiptId})`),
    );
    expect(await w.conversion(id)).toBeUndefined();
    expect(await w.inOrg((tx) => tx.select().from(expenses).where(eq(expenses.id, id)))).toEqual(
      [],
    );
  });
});
