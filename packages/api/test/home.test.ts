import type { HomeSnapshot, Membership, ReceiptRecord, TripRecord } from '@expensewise/db';
import type { z } from '@hono/zod-openapi';
import { describe, expect, it } from 'vitest';
import { createApi } from '../src/app.ts';
import type { Identity } from '../src/auth.ts';
import type { HomeData, HomeStore } from '../src/home.ts';
import type { HomeSchema } from '../src/schemas.ts';
import type { WorkspaceStore } from '../src/workspace.ts';

const ORG = '0192f7a0-0000-7000-8000-0000000000a1';
const MEMBER = '0192f7a0-0000-7000-8000-0000000000b1';
const NOW = new Date('2026-10-03T22:30:00.000Z');

const identity = (userId: string): Identity => ({
  userId,
  email: `${userId}@example.com`,
  assuranceLevel: 'aal1',
  sessionId: 's',
  issuedAt: NOW,
});

const trip = (id: string, name: string, startDate: string, endDate: string): TripRecord => ({
  id,
  memberId: MEMBER,
  owner: 'Riley',
  name,
  purpose: null,
  primaryCity: null,
  startDate,
  endDate,
  createdAt: NOW,
});
const AUSTIN = trip(
  '0192f7a0-0000-7000-8000-0000000000c1',
  'Austin · Initech',
  '2026-10-02',
  '2026-10-04',
);
const OMAHA = trip(
  '0192f7a0-0000-7000-8000-0000000000c2',
  'Q4 Architect Meeting',
  '2026-09-29',
  '2026-10-01',
);

const receipt = (n: number, status: ReceiptRecord['status']): ReceiptRecord => ({
  id: `0192f7a0-0000-7000-8000-00000000d00${n}`,
  memberId: MEMBER,
  source: 'camera',
  storageKey: `orgs/${ORG}/receipts/${n}`,
  contentType: 'image/jpeg',
  byteSize: 1000,
  sha256: String(n).repeat(64).slice(0, 64),
  uploadedBy: 'Riley',
  status,
  expenseId: null,
  createdAt: new Date(NOW.getTime() - n * 60_000),
});

const snapshot = (over: Partial<HomeSnapshot> = {}): HomeSnapshot => ({
  tripNow: AUSTIN,
  tripNext: null,
  recentTrips: [OMAHA],
  tallies: [
    { tripId: AUSTIN.id, status: 'ready', currency: 'USD', count: 3, amountMinor: 41_280 },
    { tripId: AUSTIN.id, status: 'needs_review', currency: 'USD', count: 1, amountMinor: 5_843 },
    { tripId: OMAHA.id, status: 'ready', currency: 'USD', count: 6, amountMinor: 128_437 },
  ],
  month: { from: '2026-10-01', until: '2026-11-01' },
  monthExpenses: [
    { status: 'ready', currency: 'USD', onTrip: true, count: 3, amountMinor: 41_280 },
    { status: 'needs_review', currency: 'USD', onTrip: true, count: 1, amountMinor: 5_843 },
    { status: 'ready', currency: 'EUR', onTrip: true, count: 1, amountMinor: 9_900 },
    { status: 'ready', currency: 'USD', onTrip: false, count: 3, amountMinor: 4_175 },
  ],
  monthTrips: 2,
  reading: 2,
  ...over,
});

function setup(data: Partial<HomeData> = {}, opts: { home?: boolean } = {}) {
  const memberships: Record<string, Membership> = {
    riley: { orgId: ORG, memberId: MEMBER, role: 'owner' },
  };
  const asked: { orgId: string; memberId: string; day: string }[] = [];
  const home: HomeStore = {
    snapshot: (orgId, memberId, day) => {
      asked.push({ orgId, memberId, day });
      return Promise.resolve({
        home: snapshot(),
        receipts: [],
        runs: [],
        reviews: [],
        ...data,
      });
    },
  };
  const api = createApi({
    version: 't',
    verifyToken: (token) => Promise.resolve(identity(token)),
    workspace: {
      findMembership: (userId: string) => Promise.resolve(memberships[userId]),
    } as unknown as WorkspaceStore,
    home: opts.home === false ? undefined : home,
    now: () => NOW,
  });
  const call = async (path: string, who?: string) => {
    const res = await api.request(path, {
      headers: who ? { authorization: `Bearer ${who}` } : {},
    });
    return { status: res.status, body: (await res.json()) as z.infer<typeof HomeSchema> };
  };
  return { call, asked };
}

describe('Home', () => {
  it('builds Home for the person’s own day, scoped to them', async () => {
    const s = setup();
    const { status, body } = await s.call('/v1/home?day=2026-10-03', 'riley');
    expect(status).toBe(200);
    expect(s.asked).toEqual([{ orgId: ORG, memberId: MEMBER, day: '2026-10-03' }]);
    expect(body.day).toBe('2026-10-03');
  });

  it('defaults to today in UTC when no day is given', async () => {
    const s = setup();
    await s.call('/v1/home', 'riley');
    expect(s.asked[0]?.day).toBe('2026-10-03');
  });

  it('shows the trip under way as which day of it, with its totals', async () => {
    const { body } = await setup().call('/v1/home?day=2026-10-03', 'riley');
    expect(body.trip).toMatchObject({
      when: 'now',
      day: 2,
      trip: {
        name: 'Austin · Initech',
        days: 3,
        expenseCount: 4,
        readyCount: 3,
        needsReviewCount: 1,
        totals: [{ amountMinor: 47_123, currency: 'USD', decimal: '471.23' }],
      },
    });
  });

  it('shows the next trip as days until it starts, or no trip at all', async () => {
    const next = setup({ home: snapshot({ tripNow: null, tripNext: AUSTIN }) });
    expect((await next.call('/v1/home?day=2026-09-25', 'riley')).body.trip).toMatchObject({
      when: 'next',
      startsIn: 7,
      trip: { name: 'Austin · Initech' },
    });
    const none = setup({ home: snapshot({ tripNow: null, tripNext: null }) });
    expect((await none.call('/v1/home?day=2026-09-25', 'riley')).body.trip).toBeNull();
  });

  it('adds up the month per currency, never converted, and what is on no trip', async () => {
    const { body } = await setup().call('/v1/home?day=2026-10-03', 'riley');
    expect(body.month).toEqual({
      from: '2026-10-01',
      expenses: 8,
      ready: 7,
      spent: [
        { amountMinor: 9_900, currency: 'EUR', decimal: '99.00' },
        { amountMinor: 51_298, currency: 'USD', decimal: '512.98' },
      ],
      trips: 2,
      notOnTrip: {
        expenses: 3,
        spent: [{ amountMinor: 4_175, currency: 'USD', decimal: '41.75' }],
      },
    });
    expect(body.reading).toBe(2);
    expect(body.recentTrips.map((t) => t.name)).toEqual(['Q4 Architect Meeting']);
  });

  it('counts everything that needs the person, and shows the newest three', async () => {
    const receipts = [1, 2, 3, 4].map((n) => receipt(n, n === 4 ? 'failed' : 'needs_review'));
    const { body } = await setup({ receipts }).call('/v1/home?day=2026-10-03', 'riley');
    expect(body.needsYou.count).toBe(4);
    expect(body.needsYou.items.map((i) => [i.receipt.id, i.reason.code])).toEqual([
      [receipts[0]!.id, 'unsure'],
      [receipts[1]!.id, 'unsure'],
      [receipts[2]!.id, 'unsure'],
    ]);
  });

  it('refuses a day that does not exist, and needs a signed-in member and a database', async () => {
    expect((await setup().call('/v1/home?day=2026-02-30', 'riley')).status).toBe(400);
    expect((await setup().call('/v1/home')).status).toBe(401);
    expect((await setup().call('/v1/home', 'mallory')).status).toBe(403);
    expect((await setup({}, { home: false }).call('/v1/home', 'riley')).status).toBe(503);
  });
});
