import type {
  ExpenseRecord,
  Membership,
  ReportContents,
  ReportExpenseRecord,
  TripRecord,
} from '@expensewise/db';
import type { z } from '@hono/zod-openapi';
import { describe, expect, it } from 'vitest';
import { createApi } from '../src/app.ts';
import type { Identity } from '../src/auth.ts';
import type { ReceiptStore } from '../src/receipts.ts';
import type { ReportStore } from '../src/reports.ts';
import type { InboxSchema, ReportDetailSchema, ReportListSchema } from '../src/schemas.ts';
import type { WorkspaceStore } from '../src/workspace.ts';

const ORG = '0192f7a0-0000-7000-8000-0000000000a1';
const MEMBER = '0192f7a0-0000-7000-8000-0000000000b1';
const REPORT = '0192f7a0-0000-7000-8000-0000000000e1';
const NEXT = '0192f7a0-0000-7000-8000-0000000000e2';
const TRIP = '0192f7a0-0000-7000-8000-0000000000c1';
const LUNCH = '0192f7a0-0000-7000-8000-0000000000d1';
const NOW = new Date('2026-10-04T12:00:00.000Z');

/** Whatever an answer carries: a report, a list, the inbox, a move or a problem. */
type Reply = Partial<z.infer<typeof ReportDetailSchema>> &
  Partial<z.infer<typeof ReportListSchema>> &
  Partial<z.infer<typeof InboxSchema>> & {
    code?: string;
    detail?: string;
    blocking?: string[];
    reportId?: string;
    dropped?: string | null;
    justification?: string | null;
  };

const identity = (userId: string): Identity => ({
  userId,
  email: `${userId}@example.com`,
  assuranceLevel: 'aal1',
  sessionId: 's',
  issuedAt: NOW,
});

const omaha: TripRecord = {
  id: TRIP,
  memberId: MEMBER,
  owner: 'Riley',
  name: 'Q4 Architect Meeting',
  purpose: null,
  primaryCity: 'Omaha',
  startDate: '2026-09-29',
  endDate: '2026-10-01',
  reportId: REPORT,
  createdAt: NOW,
};

const lunch = (over: Partial<ReportExpenseRecord> = {}): ReportExpenseRecord => ({
  id: LUNCH,
  memberId: MEMBER,
  owner: 'Riley',
  status: 'ready',
  source: 'camera',
  merchant: 'Verve Coffee Roasters',
  transactionDate: '2026-10-02',
  currency: 'USD',
  amountMinor: 1225,
  receiptId: null,
  tripId: null,
  tripName: null,
  tripPinned: false,
  reportId: REPORT,
  tripReportId: null,
  justification: null,
  editedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
  held: false,
  ...over,
});

function contents(over: Partial<ReportContents['report']> = {}, unsettled = 0): ReportContents {
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
      ...over,
    },
    trips: [omaha],
    tallies: [
      { tripId: TRIP, status: 'ready', currency: 'USD', count: 3, amountMinor: 128_437 },
      { tripId: TRIP, status: 'ready', currency: 'EUR', count: 1, amountMinor: 41_280 },
    ],
    counts: [{ tripId: TRIP, total: 4, unsettled }],
    locals: [lunch()],
  };
}

function setup(state: { report?: ReportContents; unjustified?: ExpenseRecord[] } = {}) {
  let report = state.report ?? contents();
  const calls: string[] = [];
  const reports: ReportStore = {
    list: () => Promise.resolve([report]),
    get: (_org, id) => Promise.resolve(id === REPORT ? report : undefined),
    needsYou: () => Promise.resolve({ reports: [report], unjustified: state.unjustified ?? [] }),
    close: (_org, id) => {
      calls.push(`close:${id}`);
      if (id !== REPORT) return Promise.resolve({ status: 'missing' });
      if (report.report.status !== 'open') {
        return Promise.resolve({ status: 'not_open', current: report.report.status });
      }
      const blocking = [
        ...report.counts.filter((c) => c.unsettled > 0).map((c) => c.tripId),
        ...report.locals.filter((e) => !e.justification).map((e) => e.id),
      ];
      if (blocking.length > 0) return Promise.resolve({ status: 'needs_attention', blocking });
      report = contents({ status: 'closed', closedAt: NOW });
      report = { ...report, locals: [lunch({ justification: 'Client coffee' })] };
      return Promise.resolve({ status: 'closed' });
    },
    reopen: (_org, id) => {
      calls.push(`reopen:${id}`);
      if (report.report.status !== 'closed') {
        return Promise.resolve({ status: 'not_closed', current: report.report.status });
      }
      return Promise.resolve({ status: 'reopened', closesAt: report.report.closesAt });
    },
    move: (_org, item, choice) => {
      calls.push(`move:${JSON.stringify(item)}:${JSON.stringify(choice)}`);
      if ('expenseId' in item && item.expenseId !== LUNCH) {
        return Promise.resolve({ status: 'not_local' });
      }
      if ('reportId' in choice && choice.reportId === NEXT) {
        return Promise.resolve({ status: 'not_open' });
      }
      return Promise.resolve({ status: 'moved', reportId: NEXT, dropped: REPORT });
    },
    justify: (_org, id, text) => {
      calls.push(`justify:${id}`);
      if (id !== LUNCH) return Promise.resolve({ status: 'not_local' });
      if (text.length > 500) return Promise.resolve({ status: 'invalid', message: 'Too long.' });
      report = { ...report, locals: [lunch({ justification: text.trim() })] };
      return Promise.resolve({ status: 'justified', justification: text.trim() });
    },
  };
  const memberships: Record<string, Membership> = {
    riley: { orgId: ORG, memberId: MEMBER, role: 'owner' },
  };
  const api = createApi({
    version: 't',
    verifyToken: (token) => Promise.resolve(identity(token)),
    workspace: {
      findMembership: (userId: string) => Promise.resolve(memberships[userId]),
    } as unknown as WorkspaceStore,
    receipts: {
      list: () => Promise.resolve({ receipts: [], runs: [], reviews: [], pairs: [] }),
    } as unknown as ReceiptStore,
    reports,
    now: () => NOW,
  });
  const call = async (method: string, path: string, who?: string, body?: unknown) => {
    const res = await api.request(path, {
      method,
      headers: {
        ...(who ? { authorization: `Bearer ${who}` } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Reply };
  };
  return { call, calls };
}

describe('expense reports (FR-EXP-05, FR-EXP-12)', () => {
  it('lists the person’s reports with their trips, totals per currency and what holds them', async () => {
    const { call } = setup();
    const { status, body } = await call('GET', '/v1/reports', 'riley');
    expect(status).toBe(200);
    expect(body.reports).toEqual([
      {
        id: REPORT,
        title: 'Report from 3 Oct 2026',
        status: 'open',
        owner: 'Riley',
        currency: 'USD',
        openedAt: '2026-10-03T12:00:00.000Z',
        closesAt: '2026-10-31T12:00:00.000Z',
        closedAt: null,
        tripNames: ['Q4 Architect Meeting'],
        trips: 1,
        localExpenses: 1,
        needsAttention: 1,
        canClose: false,
        warning: false,
        overdue: false,
        totals: [
          { amountMinor: 41_280, currency: 'EUR', decimal: '412.80' },
          { amountMinor: 129_662, currency: 'USD', decimal: '1296.62' },
        ],
      },
    ]);
  });

  it('shows each trip and local expense, and leaves a possible duplicate out of the totals', async () => {
    const held = { ...contents(), locals: [lunch({ held: true, status: 'needs_review' })] };
    const { call } = setup({ report: held });
    const { body } = await call('GET', `/v1/reports/${REPORT}`, 'riley');
    expect(body.tripItems).toMatchObject([
      { id: TRIP, name: 'Q4 Architect Meeting', unsettled: 0, ready: true, reportId: REPORT },
    ]);
    expect(body.localItems).toEqual([
      {
        id: LUNCH,
        status: 'needs_review',
        merchant: 'Verve Coffee Roasters',
        date: '2026-10-02',
        amount: { amountMinor: 1225, currency: 'USD', decimal: '12.25' },
        receiptId: null,
        justification: null,
        held: true,
        ready: false,
      },
    ]);
    expect(body.totals).toContainEqual({
      amountMinor: 128_437,
      currency: 'USD',
      decimal: '1284.37',
    });
    expect((await call('GET', `/v1/reports/${NEXT}`, 'riley')).status).toBe(404);
  });

  it('refuses to close while anything needs a justification, then closes and reopens', async () => {
    const { call } = setup();
    const refused = await call('POST', `/v1/reports/${REPORT}/close`, 'riley');
    expect(refused).toMatchObject({
      status: 409,
      body: { code: 'needs_attention', blocking: [LUNCH] },
    });

    const justified = await call('PUT', `/v1/expenses/${LUNCH}/justification`, 'riley', {
      justification: '  Client coffee  ',
    });
    expect(justified).toEqual({ status: 200, body: { justification: 'Client coffee' } });

    const closed = await call('POST', `/v1/reports/${REPORT}/close`, 'riley');
    expect(closed.status).toBe(200);
    expect(closed.body).toMatchObject({ status: 'closed', closedAt: NOW.toISOString() });
    expect((await call('POST', `/v1/reports/${REPORT}/close`, 'riley')).body.code).toBe('not_open');
    expect((await call('POST', `/v1/reports/${REPORT}/reopen`, 'riley')).status).toBe(200);
  });

  it('refuses to reopen an open report, and a justification on a trip’s expense or too long', async () => {
    const { call } = setup();
    expect((await call('POST', `/v1/reports/${REPORT}/reopen`, 'riley')).body).toMatchObject({
      code: 'not_closed',
      detail: 'It is open already.',
    });
    const onTrip = await call('PUT', `/v1/expenses/${TRIP}/justification`, 'riley', {
      justification: 'Client visit',
    });
    expect([onTrip.status, onTrip.body.code]).toEqual([422, 'not_local']);
    const long = await call('PUT', `/v1/expenses/${LUNCH}/justification`, 'riley', {
      justification: 'x'.repeat(501),
    });
    expect([long.status, long.body.code]).toEqual([422, 'invalid_value']);
    const huge = await call('PUT', `/v1/expenses/${LUNCH}/justification`, 'riley', {
      justification: 'x'.repeat(2001),
    });
    expect(huge.status).toBe(400);
  });

  it('moves a trip or a local expense to a new report, and refuses a closed one', async () => {
    const { call, calls } = setup();
    const moved = await call('PUT', `/v1/trips/${TRIP}/report`, 'riley', { newReport: true });
    expect(moved).toEqual({ status: 200, body: { reportId: NEXT, dropped: REPORT } });
    expect(calls).toContain(`move:{"tripId":"${TRIP}"}:{"newReport":true}`);

    const closed = await call('PUT', `/v1/expenses/${LUNCH}/report`, 'riley', { reportId: NEXT });
    expect([closed.status, closed.body.code]).toEqual([409, 'not_open']);
    const onTrip = await call('PUT', `/v1/expenses/${TRIP}/report`, 'riley', { newReport: true });
    expect([onTrip.status, onTrip.body.code]).toEqual([422, 'not_local']);
    const both = await call('PUT', `/v1/trips/${TRIP}/report`, 'riley', {
      newReport: true,
      reportId: NEXT,
    });
    expect(both.status).toBe(400);
  });

  it('needs a signed-in member', async () => {
    const { call } = setup();
    expect((await call('GET', '/v1/reports')).status).toBe(401);
    expect((await call('GET', '/v1/reports', 'mallory')).status).toBe(403);
  });
});

describe('reports and local expenses in Needs you (FR-EXP-02, FR-EXP-14)', () => {
  const unjustified: ExpenseRecord = { ...lunch(), reportId: null };

  it('asks for a justification, and says when a report is ready to close', async () => {
    const ready = { ...contents(), locals: [lunch({ justification: 'Client coffee' })] };
    const { call } = setup({ report: ready, unjustified: [unjustified] });
    const items = (await call('GET', '/v1/inbox', 'riley')).body.items ?? [];
    expect(items.map((i) => [i.kind, i.reason.code])).toEqual([
      ['expense', 'justification'],
      ['report', 'ready_to_close'],
    ]);
    expect(items[0]).toMatchObject({
      expense: {
        id: LUNCH,
        merchant: 'Verve Coffee Roasters',
        date: '2026-10-02',
        amount: { amountMinor: 1225, currency: 'USD', decimal: '12.25' },
        receiptId: null,
      },
    });
  });

  it('puts a report first in its last week with something left, and when overdue', async () => {
    const soon = contents({ closesAt: new Date('2026-10-08T12:00:00.000Z') }, 1);
    const late = contents({ closesAt: new Date('2026-10-01T12:00:00.000Z') }, 1);
    for (const [report, code] of [
      [soon, 'closing_soon'],
      [late, 'overdue'],
    ] as const) {
      const { call } = setup({ report, unjustified: [unjustified] });
      const items = (await call('GET', '/v1/inbox', 'riley')).body.items ?? [];
      expect(items[0]).toMatchObject({
        kind: 'report',
        reason: { code },
        report: { warning: true },
      });
    }
  });

  it('leaves out a report still filling up, or closed', async () => {
    const closed = contents({ status: 'closed', closedAt: NOW });
    for (const report of [contents({}, 1), closed]) {
      const { call } = setup({ report });
      expect((await call('GET', '/v1/inbox', 'riley')).body.items).toEqual([]);
    }
  });
});
