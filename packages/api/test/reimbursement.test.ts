import type {
  CommittedEvent,
  Membership,
  ReimbursementCurrency,
  ReportAmount,
  ReportContents,
  TripRecord,
} from '@expensewise/db';
import { fxRate, money } from '@expensewise/domain';
import type { z } from '@hono/zod-openapi';
import { describe, expect, it } from 'vitest';
import { createApi } from '../src/app.ts';
import type { Identity } from '../src/auth.ts';
import type { HomeStore } from '../src/home.ts';
import type { ReceiptStore } from '../src/receipts.ts';
import type { ReimbursementStore } from '../src/reimbursement.ts';
import type { ReportStore } from '../src/reports.ts';
import type {
  HomeSchema,
  InboxSchema,
  ReimbursementCurrencySchema,
  ReportDetailSchema,
  ReportListSchema,
} from '../src/schemas.ts';
import type { WorkspaceStore } from '../src/workspace.ts';

const ORG = '0192f7a0-0000-7000-8000-0000000000a1';
const MEMBER = '0192f7a0-0000-7000-8000-0000000000b1';
const REPORT = '0192f7a0-0000-7000-8000-0000000000e1';
const TRIP = '0192f7a0-0000-7000-8000-0000000000c1';
const LUFTHANSA = '0192f7a0-0000-7000-8000-0000000000d1';
const HOTEL = '0192f7a0-0000-7000-8000-0000000000d2';
const TAXI = '0192f7a0-0000-7000-8000-0000000000d3';
const DUBAI = '0192f7a0-0000-7000-8000-0000000000d4';
const LUNCH = '0192f7a0-0000-7000-8000-0000000000d5';
const NOW = new Date('2026-10-04T12:00:00.000Z');
const ON = 'reports.currency-conversion=on';

/** Whatever an answer carries: a currency, a report, a list, Home, the inbox or a problem. */
type Reply = Partial<z.infer<typeof ReimbursementCurrencySchema>> &
  Partial<Omit<z.infer<typeof ReportDetailSchema>, 'currency'>> &
  Partial<z.infer<typeof ReportListSchema>> &
  Partial<Omit<z.infer<typeof HomeSchema>, 'reports'>> &
  Partial<z.infer<typeof InboxSchema>> & { code?: string };

/** The report summary in an inbox or Needs you item. */
const reportIn = (item: unknown) => (item as { report?: { reimbursement?: unknown } }).report;

const identity = (userId: string): Identity => ({
  userId,
  email: `${userId}@example.com`,
  assuranceLevel: 'aal1',
  sessionId: 's',
  issuedAt: NOW,
});

const RATE = fxRate({
  base: 'EUR',
  quote: 'USD',
  rate: '1.1712',
  asOf: '2026-09-25',
  source: 'ECB',
});

const amount = (
  expenseId: string,
  tripId: string | null,
  amountMinor: number,
  currency: string,
  over: Partial<ReportAmount> = {},
): ReportAmount => ({
  reportId: REPORT,
  expenseId,
  tripId,
  amountMinor,
  currency,
  purchaseDate: '2026-09-27',
  held: false,
  conversion: null,
  ...over,
});

const omaha: TripRecord = {
  id: TRIP,
  memberId: MEMBER,
  owner: 'Riley',
  name: 'Q4 Architect Meeting',
  purpose: null,
  primaryCity: 'Omaha',
  startDate: '2026-09-26',
  endDate: '2026-10-01',
  reportId: REPORT,
  createdAt: NOW,
};

function contents(amounts?: ReportAmount[]): ReportContents {
  return {
    report: {
      id: REPORT,
      memberId: MEMBER,
      owner: 'Riley',
      title: 'Report from 3 Oct 2026',
      status: 'open',
      currency: 'USD',
      closesAt: new Date('2026-10-31T12:00:00.000Z'),
      closedAt: null,
      submittedAt: null,
      createdAt: new Date('2026-10-03T12:00:00.000Z'),
    },
    trips: [omaha],
    tallies: [
      { tripId: TRIP, status: 'ready', currency: 'USD', count: 1, amountMinor: 128_437 },
      { tripId: TRIP, status: 'ready', currency: 'EUR', count: 1, amountMinor: 41_280 },
      { tripId: TRIP, status: 'ready', currency: 'GBP', count: 1, amountMinor: 2_000 },
    ],
    counts: [{ tripId: TRIP, total: 3, unsettled: 0 }],
    locals: [
      {
        id: DUBAI,
        memberId: MEMBER,
        owner: 'Riley',
        status: 'ready',
        source: 'camera',
        merchant: 'Dubai Mall',
        transactionDate: '2026-09-29',
        currency: 'AED',
        amountMinor: 18_500,
        receiptId: null,
        tripId: null,
        tripName: null,
        tripPinned: false,
        time: null,
        timeZone: null,
        address: null,
        city: null,
        region: null,
        country: null,
        reportId: REPORT,
        tripReportId: null,
        justification: 'Client gift',
        editedAt: null,
        createdAt: NOW,
        updatedAt: NOW,
        held: false,
      },
    ],
    ...(amounts ? { amounts } : {}),
  };
}

/** A hotel in dollars, a flight converted from euros, a taxi in pounds still converting. */
const AMOUNTS = [
  amount(HOTEL, TRIP, 128_437, 'USD'),
  amount(LUFTHANSA, TRIP, 41_280, 'EUR', {
    conversion: {
      amount: money(41_280, 'EUR'),
      purchaseDate: '2026-09-27',
      into: 'USD',
      outcome: 'converted',
      converted: money(48_347, 'USD'),
      rate: RATE,
    },
  }),
  amount(TAXI, TRIP, 2_000, 'GBP'),
  amount(DUBAI, null, 18_500, 'AED', {
    purchaseDate: '2026-09-29',
    conversion: {
      amount: money(18_500, 'AED'),
      purchaseDate: '2026-09-29',
      into: 'USD',
      outcome: 'unavailable',
      source: 'ECB',
    },
  }),
  // Held as a possible duplicate: shown, and in no total.
  amount(LUNCH, TRIP, 9_999, 'USD', { held: true }),
];

function setup(
  options: {
    flags?: string;
    amounts?: ReportAmount[];
    chosen?: string | null;
    event?: CommittedEvent | null;
  } = {},
) {
  const calls: string[] = [];
  const dispatched: CommittedEvent[] = [];
  let chosen = options.chosen ?? null;
  const current = (): ReimbursementCurrency => ({
    currency: chosen ?? 'USD',
    chosen,
    homeCurrency: 'USD',
  });
  const reimbursement: ReimbursementStore = {
    get: () => Promise.resolve(current()),
    set: (_org, member, currency, actor) => {
      calls.push(`set:${member}:${currency}:${actor}`);
      if (currency === chosen) return Promise.resolve({ status: 'unchanged', currency: current() });
      chosen = currency;
      return Promise.resolve({
        status: 'set',
        currency: current(),
        reports: [REPORT],
        event:
          options.event === undefined
            ? { outboxId: 'ob-1', topic: 'report.conversions_due', orgId: ORG, payload: {} }
            : options.event,
      });
    },
  };
  const report = contents('amounts' in options ? options.amounts : AMOUNTS);
  const reports = {
    list: () => Promise.resolve([report]),
    get: (_org: string, id: string) => Promise.resolve(id === REPORT ? report : undefined),
    needsYou: () => Promise.resolve({ reports: [report], unjustified: [] }),
  } as unknown as ReportStore;
  const home = {
    snapshot: () =>
      Promise.resolve({
        home: {
          tripNow: null,
          tripNext: null,
          recentTrips: [],
          tallies: [],
          month: { from: '2026-10-01', until: '2026-11-01' },
          monthExpenses: [],
          monthTrips: 0,
          reading: 0,
        },
        receipts: [],
        runs: [],
        reviews: [],
        pairs: [],
        reports: { reports: [report], unjustified: [] },
      }),
  } as unknown as HomeStore;
  const receipts = {
    list: () => Promise.resolve({ receipts: [], runs: [], reviews: [], pairs: [] }),
  } as unknown as ReceiptStore;
  const memberships: Record<string, Membership> = {
    riley: { orgId: ORG, memberId: MEMBER, role: 'owner' },
  };
  const api = createApi({
    version: 't',
    verifyToken: (token) => Promise.resolve(identity(token)),
    workspace: {
      findMembership: (userId: string) => Promise.resolve(memberships[userId]),
      featureOn: () => Promise.resolve(false),
    } as unknown as WorkspaceStore,
    reports,
    home,
    receipts,
    reimbursement,
    dispatch: (events) => {
      dispatched.push(...events);
      return Promise.resolve();
    },
    flagOverrides: options.flags,
    now: () => NOW,
  });
  const call = async (method: string, path: string, who?: string, body?: unknown) => {
    const res = await api.request(path, {
      method,
      headers: {
        ...(who ? { authorization: `Bearer ${who}` } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return {
      status: res.status,
      body: (await res.json().catch(() => ({}))) as Reply,
    };
  };
  return { call, calls, dispatched };
}

describe('the reimbursement currency in Settings (FR-EXP-13, Q23)', () => {
  it('is the organization’s home currency until the person chooses, with every currency to choose from', async () => {
    const { call } = setup({ flags: ON });
    const { status, body } = await call('GET', '/v1/me/reimbursement-currency', 'riley');
    expect(status).toBe(200);
    expect(body).toMatchObject({ currency: 'USD', chosen: null, homeCurrency: 'USD' });
    const codes = body.currencies ?? [];
    expect(codes.find((c) => c.code === 'EUR')).toEqual({ code: 'EUR', converts: true });
    expect(codes.find((c) => c.code === 'AED')).toEqual({ code: 'AED', converts: false });
  });

  it('sets the person’s choice and hands the request to convert to the workflows at once', async () => {
    const { call, calls, dispatched } = setup({ flags: ON });
    const { status, body } = await call('PUT', '/v1/me/reimbursement-currency', 'riley', {
      currency: 'EUR',
    });
    expect(status).toBe(200);
    expect(body).toMatchObject({ currency: 'EUR', chosen: 'EUR', homeCurrency: 'USD' });
    expect(calls).toEqual([`set:${MEMBER}:EUR:riley`]);
    expect(dispatched.map((e) => e.topic)).toEqual(['report.conversions_due']);

    const back = await call('PUT', '/v1/me/reimbursement-currency', 'riley', { currency: null });
    expect(back.body).toMatchObject({ currency: 'USD', chosen: null });
  });

  it('refuses a currency the app doesn’t support, and a stranger', async () => {
    const { call, calls } = setup({ flags: ON });
    const bad = await call('PUT', '/v1/me/reimbursement-currency', 'riley', { currency: 'XYZ' });
    expect(bad.status).toBe(400);
    expect((await call('GET', '/v1/me/reimbursement-currency', 'stranger')).status).toBe(403);
    expect((await call('GET', '/v1/me/reimbursement-currency')).status).toBe(401);
    expect(calls).toEqual([]);
  });

  it('looks absent while the feature is off', async () => {
    const { call, calls } = setup();
    for (const [method, body] of [
      ['GET', undefined],
      ['PUT', { currency: 'EUR' }],
    ] as const) {
      const res = await call(method, '/v1/me/reimbursement-currency', 'riley', body);
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('feature_off');
    }
    expect(calls).toEqual([]);
  });
});

describe('a report in the reimbursement currency (FR-EXP-13, Q22, Q25)', () => {
  it('totals in one currency: amounts already in it as they are, the rest at their rate, and says what is left out', async () => {
    const { call } = setup({ flags: ON });
    const { body } = await call('GET', '/v1/reports', 'riley');
    expect(body.reports?.[0]).toMatchObject({
      currency: 'USD',
      reimbursement: {
        total: { amountMinor: 176_784, currency: 'USD', decimal: '1767.84' },
        converting: 1,
        unconverted: [{ amountMinor: 18_500, currency: 'AED', decimal: '185.00' }],
      },
    });
    // The amounts as spent are still there, one total per currency.
    expect(body.reports?.[0]?.totals.map((t) => t.currency)).toEqual(['AED', 'EUR', 'GBP', 'USD']);
  });

  it('shows each amount beside its conversion, with the rate, its date and its source', async () => {
    const { call } = setup({ flags: ON });
    const { status, body } = await call('GET', `/v1/reports/${REPORT}`, 'riley');
    expect(status).toBe(200);
    expect(body.tripItems?.[0]?.reimbursement).toEqual({
      total: { amountMinor: 176_784, currency: 'USD', decimal: '1767.84' },
      converting: 1,
      unconverted: [],
    });
    expect(body.localItems?.[0]).toMatchObject({
      amount: { amountMinor: 18_500, currency: 'AED' },
      reimbursed: { kind: 'unconverted', amount: null, rate: null },
    });
    expect(body.rates).toEqual([
      { from: 'EUR', to: 'USD', rate: '1.1712', date: '2026-09-25', source: 'ECB', expenses: 1 },
    ]);
  });

  it('totals in the reimbursement currency on Home and in Needs you too', async () => {
    const { call } = setup({ flags: ON });
    const total = { amountMinor: 176_784, currency: 'USD', decimal: '1767.84' };
    const home = (await call('GET', '/v1/home?day=2026-10-04', 'riley')).body;
    expect(home.reports?.[0]?.reimbursement?.total).toEqual(total);
    expect(reportIn(home.needsYou?.items[0])).toMatchObject({ reimbursement: { total } });
    const inbox = (await call('GET', '/v1/inbox', 'riley')).body;
    expect(reportIn(inbox.items?.[0])).toMatchObject({ reimbursement: { total } });
  });

  it('reads exactly as before while the feature is off', async () => {
    const off = setup({ flags: 'reports.currency-conversion=off' });
    const plain = setup({ flags: ON, amounts: undefined });
    for (const path of [
      '/v1/reports',
      `/v1/reports/${REPORT}`,
      '/v1/home?day=2026-10-04',
      '/v1/inbox',
    ]) {
      const shown = (await off.call('GET', path, 'riley')).body;
      expect(shown).toEqual((await plain.call('GET', path, 'riley')).body);
      expect(JSON.stringify(shown)).not.toMatch(/reimburse|"rates"/);
    }
  });
});
