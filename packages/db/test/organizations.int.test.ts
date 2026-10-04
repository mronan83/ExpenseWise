import { newId } from '@expensewise/domain';
import { and, asc, eq } from 'drizzle-orm';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { withOrg } from '../src/client.ts';
import type { ReceiptOffer } from '../src/expenses.ts';
import { featureOn, setOrgFeature } from '../src/features.ts';
import {
  duplicateWindowFor,
  getOrganization,
  organizationTimeZone,
  setDuplicateWindow,
  updateOrganization,
} from '../src/organizations.ts';
import { fileReceipt, recordExtractionRun, settleReceipt } from '../src/receipts.ts';
import { closeReport, getReport, reportWorkDue, runReportSchedule } from '../src/reports.ts';
import {
  auditEvents,
  expenses,
  organizations,
  receiptDuplicates,
  receipts,
  trips,
} from '../src/schema.ts';
import { createTrip, fileExpenseToTrip } from '../src/trips.ts';
import { connectAs, expectDbError, seedOrg } from './helpers.ts';

const app = connectAs('app');
afterAll(async () => {
  await app.pool.end();
});
const overrides = process.env.FLAG_OVERRIDES;
afterEach(() => {
  if (overrides === undefined) delete process.env.FLAG_OVERRIDES;
  else process.env.FLAG_OVERRIDES = overrides;
});

const at = (iso: string) => new Date(iso);

/** An organization of one owner, with what the tests below do in it. */
async function workspace(name: string) {
  const org = await seedOrg(app.db, name);
  const inOrg = <T>(work: Parameters<typeof withOrg<T>>[2]) => withOrg(app.db, org.orgId, work);
  const switchOn = (flag: 'settings.organization' | 'settings.duplicate-window') =>
    inOrg((tx) =>
      setOrgFeature(tx, org.orgId, { flag, enabled: true, memberId: org.memberId }, org.userId),
    );
  const edit = (change: Parameters<typeof updateOrganization>[2]) =>
    inOrg((tx) => updateOrganization(tx, org.orgId, change, org.userId));
  const setWindow = (minutes: number) =>
    inOrg((tx) => setDuplicateWindow(tx, org.orgId, minutes, org.userId));
  const events = (action: string) =>
    inOrg((tx) =>
      tx
        .select({ payload: auditEvents.payload, actor: auditEvents.actorId })
        .from(auditEvents)
        .where(and(eq(auditEvents.entityId, org.orgId), eq(auditEvents.action, action)))
        .orderBy(asc(auditEvents.sequence)),
    );
  const trip = async (startDate: string, endDate: string) => {
    const made = await inOrg((tx) =>
      createTrip(tx, org.orgId, org.memberId, { name: 'Trip', startDate, endDate }, org.userId),
    );
    if (made.status !== 'saved') throw new Error(`expected a trip, got ${made.status}`);
    return made.tripId;
  };
  const expense = (date: string, currency = 'USD') =>
    inOrg(async (tx) => {
      const id = newId();
      await tx.insert(expenses).values({
        id,
        orgId: org.orgId,
        memberId: org.memberId,
        status: 'ready',
        source: 'manual',
        merchant: 'Uber',
        transactionDate: date,
        currency,
        amountMinor: 3145,
      });
      await fileExpenseToTrip(tx, org.orgId, id, { type: 'user', id: org.userId });
      return id;
    });
  const reportOfTrip = async (tripId: string) =>
    (await inOrg((tx) => tx.select().from(trips).where(eq(trips.id, tripId))))[0]?.reportId ?? null;
  const run = (now: Date) => runReportSchedule(app.db, org.orgId, now);
  return {
    org,
    inOrg,
    switchOn,
    edit,
    setWindow,
    events,
    trip,
    expense,
    reportOfTrip,
    run,
  };
}

describe('the organization’s details (FR-PLT-11)', () => {
  it('keeps each detail the owner sets, with one audit event listing every change', async () => {
    const w = await workspace('org-details');
    const saved = await w.edit({
      name: 'Acme Field Services',
      country: 'us',
      locale: 'en-us',
      timeZone: 'America/Chicago',
      address: '1520 Harney St, Suite 400\nOmaha, NE 68102',
      industry: 'Professional services',
      size: '2_10',
    });
    expect(saved).toMatchObject({ status: 'updated' });
    const expected = {
      id: w.org.orgId,
      name: 'Acme Field Services',
      homeCurrency: 'USD',
      country: 'US',
      locale: 'en-US',
      timeZone: 'America/Chicago',
      address: '1520 Harney St, Suite 400\nOmaha, NE 68102',
      industry: 'Professional services',
      size: '2_10',
      duplicateWindowMinutes: null,
    };
    expect(await w.inOrg((tx) => getOrganization(tx, w.org.orgId))).toEqual(expected);
    const [event] = await w.events('organization.updated');
    expect(event?.actor).toBe(w.org.userId);
    expect(event?.payload).toMatchObject({
      changes: [
        { field: 'name', from: 'org-details', to: 'Acme Field Services' },
        { field: 'country', from: null, to: 'US' },
        { field: 'locale', from: null, to: 'en-US' },
        { field: 'timeZone', from: null, to: 'America/Chicago' },
        { field: 'address', from: null },
        { field: 'industry', from: null },
        { field: 'size', from: null, to: '2_10' },
      ],
    });

    // Saying what is already there changes nothing and records nothing.
    expect(await w.edit({ name: 'Acme Field Services', country: 'US' })).toEqual({
      status: 'unchanged',
      organization: expected,
    });
    expect(await w.events('organization.updated')).toHaveLength(1);
  });

  it('refuses a value that isn’t one, and changes nothing', async () => {
    const w = await workspace('org-invalid');
    expect(await w.edit({ country: 'USA' })).toMatchObject({
      status: 'invalid',
      problem: { field: 'country' },
    });
    expect(await w.edit({ timeZone: 'Mars/Olympus_Mons' })).toMatchObject({
      status: 'invalid',
      problem: { field: 'timeZone' },
    });
    expect(await w.edit({ name: '' })).toMatchObject({ status: 'invalid' });
    expect(await w.events('organization.updated')).toEqual([]);
    // The database holds a country to two capitals, and a window to 0 to 120 minutes.
    await expectDbError(
      w.inOrg((tx) =>
        tx.update(organizations).set({ country: 'us' }).where(eq(organizations.id, w.org.orgId)),
      ),
      /organizations_country_code/,
    );
    await expectDbError(
      w.inOrg((tx) =>
        tx
          .update(organizations)
          .set({ duplicateWindowMinutes: 121 })
          .where(eq(organizations.id, w.org.orgId)),
      ),
      /organizations_duplicate_window_range/,
    );
  });

  it('opens reports from then on in a new home currency, and leaves those opened before as they were', async () => {
    const w = await workspace('org-currency');
    const first = await w.trip('2026-09-22', '2026-09-25');
    const ride = await w.expense('2026-09-23');
    await w.run(at('2026-09-27T12:00:00Z'));
    const before = (await w.reportOfTrip(first))!;
    await w.inOrg((tx) =>
      closeReport(tx, w.org.orgId, before, w.org.userId, at('2026-09-28T00:00:00Z')),
    );

    expect(await w.edit({ homeCurrency: 'eur' })).toMatchObject({
      status: 'updated',
      changes: [{ field: 'homeCurrency', from: 'USD', to: 'EUR' }],
    });
    const second = await w.trip('2026-09-29', '2026-10-01');
    await w.expense('2026-09-30');
    await w.run(at('2026-10-03T12:00:00Z'));
    const after = (await w.reportOfTrip(second))!;

    const report = (id: string) => w.inOrg((tx) => getReport(tx, id));
    expect((await report(before))?.report.currency).toBe('USD');
    expect((await report(after))?.report.currency).toBe('EUR');
    // No amount is converted: the ride is still in the dollars it was spent in.
    const [kept] = await w.inOrg((tx) => tx.select().from(expenses).where(eq(expenses.id, ride)));
    expect(kept).toMatchObject({ currency: 'USD', amountMinor: 3145 });
  });
});

describe('the organization’s time zone in background work (ADR-0037)', () => {
  it('with organization settings on, joins a trip 24 hours after its return day ends there', async () => {
    const w = await workspace('org-zone-on');
    await w.switchOn('settings.organization');
    await w.edit({ timeZone: 'America/Chicago' });
    expect(await w.inOrg((tx) => organizationTimeZone(tx, w.org.orgId))).toBe('America/Chicago');
    const trip = await w.trip('2026-10-05', '2026-10-07');
    await w.expense('2026-10-06');

    // 7 Oct ends in Chicago at 8 Oct 05:00 UTC; 24 hours on is 9 Oct 05:00 UTC, not noon.
    expect(await reportWorkDue(app.db, at('2026-10-09T04:59:59Z'))).not.toContain(w.org.orgId);
    expect((await w.run(at('2026-10-09T04:59:59Z'))).joined.trips).toBe(0);
    expect(await reportWorkDue(app.db, at('2026-10-09T05:00:00Z'))).toContain(w.org.orgId);
    expect((await w.run(at('2026-10-09T05:30:00Z'))).joined).toEqual({
      trips: 1,
      expenses: 0,
      opened: 1,
    });
    const reportId = (await w.reportOfTrip(trip))!;
    // Day 28 is 6 Nov on Chicago's calendar, at 00:30 as it opened: the clocks went back on
    // 1 Nov, so that is 06:30 UTC, an hour later than 28 days of 24 hours.
    expect((await w.inOrg((tx) => getReport(tx, reportId)))?.report).toMatchObject({
      title: 'Report from 9 Oct 2026',
      closesAt: at('2026-11-06T06:30:00Z'),
    });
  });

  it('names a report by the day it opened where the organization is', async () => {
    const w = await workspace('org-zone-title');
    await w.switchOn('settings.organization');
    await w.edit({ timeZone: 'Asia/Tokyo' });
    const trip = await w.trip('2026-10-05', '2026-10-07');
    await w.expense('2026-10-06');
    // 7 Oct ends in Tokyo at 7 Oct 15:00 UTC; it joins a day later, early on 9 Oct there.
    await w.run(at('2026-10-08T15:07:00Z'));
    const reportId = (await w.reportOfTrip(trip))!;
    expect((await w.inOrg((tx) => getReport(tx, reportId)))?.report.title).toBe(
      'Report from 9 Oct 2026',
    );
  });

  it('with organization settings off, goes by UTC−12 as before, whatever time zone is kept', async () => {
    const w = await workspace('org-zone-off');
    await w.edit({ timeZone: 'America/Chicago' });
    expect(await w.inOrg((tx) => organizationTimeZone(tx, w.org.orgId))).toBeNull();
    const trip = await w.trip('2026-10-05', '2026-10-07');
    await w.expense('2026-10-06');
    // The schedule may look in a few hours early, and then finds nothing due.
    expect(await reportWorkDue(app.db, at('2026-10-09T05:00:00Z'))).toContain(w.org.orgId);
    expect((await w.run(at('2026-10-09T05:00:00Z'))).joined.trips).toBe(0);
    expect((await w.run(at('2026-10-09T12:00:00Z'))).joined.trips).toBe(1);
    const reportId = (await w.reportOfTrip(trip))!;
    expect((await w.inOrg((tx) => getReport(tx, reportId)))?.report).toMatchObject({
      title: 'Report from 9 Oct 2026',
      closesAt: at('2026-11-06T12:00:00Z'),
    });
  });
});

let files = 0;
/** Files a receipt and settles its reading, as the workflow does; returns its id. */
async function readReceipt(
  w: Awaited<ReturnType<typeof workspace>>,
  values: ReceiptOffer,
): Promise<string> {
  const id = newId();
  const { org } = w;
  const filed = await w.inOrg((tx) =>
    fileReceipt(
      tx,
      org.orgId,
      {
        id,
        memberId: org.memberId,
        source: 'email',
        storageKey: `orgs/${org.orgId}/receipts/${id}`,
        contentType: 'application/pdf',
        byteSize: 2000,
        sha256: `ab${(++files).toString(16).padStart(62, '0')}`,
      },
      org.userId,
    ),
  );
  if (filed.status !== 'filed') throw new Error('not filed');
  await w.inOrg(async (tx) => {
    await recordExtractionRun(tx, org.orgId, {
      receiptId: id,
      requestId: filed.event.outboxId,
      extractor: 'claude',
      model: 'claude-haiku-4-5',
      promptVersion: 'extract-v2',
      schemaVersion: 'receipt-v2',
      outcome: 'confident',
      output: { documentType: 'receipt' },
      fieldConfidence: { total: 'high' },
      error: null,
      latencyMs: 900,
      inputTokens: 1000,
      outputTokens: 200,
      costMicroUsd: 3000,
    });
    await settleReceipt(tx, org.orgId, id, {
      status: 'extracted',
      requestId: filed.event.outboxId,
      detail: {},
      values,
    });
  });
  return id;
}

/** A dinner's bill at a time, in Houston, and its total. */
const dinner = (time: string, amountMinor = 9310): ReceiptOffer => ({
  merchant: 'Pappas Bros. Steakhouse',
  transactionDate: '2026-09-23',
  currency: 'USD',
  amountMinor,
  details: {
    time,
    timeZone: 'America/Chicago',
    address: '1200 McKinney St, Houston, TX 77010',
    city: 'Houston',
    region: 'TX',
    country: 'US',
  },
});

describe('the duplicate time window (FR-INT-19)', () => {
  const heldWith = (w: Awaited<ReturnType<typeof workspace>>, receiptId: string) =>
    w.inOrg(async (tx) =>
      (
        await tx
          .select({ other: receiptDuplicates.otherReceiptId, state: receiptDuplicates.state })
          .from(receiptDuplicates)
          .where(eq(receiptDuplicates.receiptId, receiptId))
      ).map((p) => p.other),
    );

  it('judges receipts read from then on by the window the owner set, and leaves pairs already decided', async () => {
    const w = await workspace('org-window');
    await w.switchOn('settings.duplicate-window');
    expect(await w.inOrg((tx) => duplicateWindowFor(tx, w.org.orgId))).toBe(30);

    expect(await w.setWindow(5)).toEqual({ status: 'changed', from: 30, to: 5 });
    const bill = await readReceipt(w, dinner('19:58'));
    const slip = await readReceipt(w, dinner('20:10', 10810));
    // Twelve minutes on is outside a 5-minute window.
    expect(await heldWith(w, slip)).toEqual([]);

    expect(await w.setWindow(60)).toEqual({ status: 'changed', from: 5, to: 60 });
    // The slip was judged when it was read; a wider window doesn't go back over it.
    expect(await heldWith(w, slip)).toEqual([]);
    const late = await readReceipt(w, dinner('20:50', 10810));
    expect(await heldWith(w, late)).toEqual([bill]);

    // Narrowing it to the same minute leaves the pair already flagged as it is.
    expect(await w.setWindow(0)).toEqual({ status: 'changed', from: 60, to: 0 });
    expect(await heldWith(w, late)).toEqual([bill]);
    const [stillHeld] = await w.inOrg((tx) =>
      tx.select({ status: receipts.status }).from(receipts).where(eq(receipts.id, late)),
    );
    expect(stillHeld?.status).toBe('needs_review');

    // Each change is in the audit trail; setting what it is records nothing.
    expect(await w.setWindow(0)).toEqual({ status: 'unchanged', minutes: 0 });
    expect((await w.events('organization.duplicate_window_set')).map((e) => e.payload)).toEqual([
      { from: 30, to: 5 },
      { from: 5, to: 60 },
      { from: 60, to: 0 },
    ]);
  });

  it('refuses a window outside 0 to 120 whole minutes', async () => {
    const w = await workspace('org-window-range');
    for (const minutes of [-1, 121, 2.5]) {
      expect(await w.setWindow(minutes)).toEqual({ status: 'invalid' });
    }
    expect(await w.setWindow(120)).toMatchObject({ status: 'changed', to: 120 });
  });

  it('with the setting off, keeps to 30 minutes whatever the owner set', async () => {
    const w = await workspace('org-window-off');
    await w.setWindow(5);
    expect(await w.inOrg((tx) => duplicateWindowFor(tx, w.org.orgId))).toBe(30);
    const bill = await readReceipt(w, dinner('19:58'));
    const slip = await readReceipt(w, dinner('20:10', 10810));
    expect(await heldWith(w, slip)).toEqual([bill]);
  });
});

describe('a feature for work with no request (ADR-0032)', () => {
  it('is the server’s override first, then the organization’s switch, then off', async () => {
    const w = await workspace('org-override');
    const on = () => w.inOrg((tx) => featureOn(tx, w.org.orgId, 'settings.organization'));
    delete process.env.FLAG_OVERRIDES;
    expect(await on()).toBe(false);
    process.env.FLAG_OVERRIDES = 'settings.organization=on';
    expect(await on()).toBe(true);
    await w.switchOn('settings.organization');
    process.env.FLAG_OVERRIDES = 'settings.organization=off';
    expect(await on()).toBe(false);
    delete process.env.FLAG_OVERRIDES;
    expect(await on()).toBe(true);
  });
});
