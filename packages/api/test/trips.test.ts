import type {
  ExpenseRecord,
  Membership,
  SaveTripResult,
  TripFilter,
  TripRecord,
  TripTally,
} from '@expensewise/db';
import { applyTripInput } from '@expensewise/domain';
import { describe, expect, it } from 'vitest';
import { createApi } from '../src/app.ts';
import type { Identity } from '../src/auth.ts';
import type { TripStore } from '../src/trips.ts';
import type { WorkspaceStore } from '../src/workspace.ts';

const ORG = '0192f7a0-0000-7000-8000-0000000000a1';
const MEMBER = '0192f7a0-0000-7000-8000-0000000000b1';
const TRIP = '0192f7a0-0000-7000-8000-0000000000c1';
const NEW_TRIP = '0192f7a0-0000-7000-8000-0000000000c3';
const EXPENSE = '0192f7a0-0000-7000-8000-0000000000e1';
const NOW = new Date('2026-10-03T12:00:00.000Z');

const identity = (userId: string): Identity => ({
  userId,
  email: `${userId}@example.com`,
  assuranceLevel: 'aal1',
  sessionId: 's',
  issuedAt: NOW,
});

const houston: TripRecord = {
  id: TRIP,
  memberId: MEMBER,
  owner: 'riley',
  name: 'Houston · Acme onsite',
  purpose: 'Client onsite',
  primaryCity: 'Houston',
  startDate: '2026-09-22',
  endDate: '2026-09-25',
  reportId: null,
  createdAt: NOW,
};

const hotel: ExpenseRecord = {
  id: EXPENSE,
  memberId: MEMBER,
  owner: 'riley',
  status: 'ready',
  source: 'manual',
  merchant: 'Hotel ZaZa',
  transactionDate: '2026-09-25',
  currency: 'USD',
  amountMinor: 49985,
  receiptId: null,
  tripId: TRIP,
  tripName: houston.name,
  tripPinned: false,
  time: null,
  timeZone: null,
  address: null,
  city: null,
  region: null,
  country: null,
  reportId: null,
  tripReportId: null,
  justification: null,
  editedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
};

function setup() {
  const trips: TripRecord[] = [houston];
  const tallies: TripTally[] = [
    { tripId: TRIP, status: 'ready', currency: 'USD', count: 6, amountMinor: 123_000 },
    { tripId: TRIP, status: 'needs_review', currency: 'USD', count: 1, amountMinor: 2_760 },
    { tripId: TRIP, status: 'needs_review', currency: 'EUR', count: 1, amountMinor: 1_200 },
    { tripId: TRIP, status: 'processing', currency: null, count: 1, amountMinor: null },
  ];
  const filters: TripFilter[] = [];
  const removals: Record<string, Awaited<ReturnType<TripStore['remove']>>> = {};
  const save = (id: string, current: TripRecord | null, input: object): SaveTripResult => {
    const applied = applyTripInput(current, input);
    if (!applied.ok) return { status: 'invalid', problem: applied.error };
    if (applied.value.changes.length === 0) return { status: 'unchanged', tripId: id };
    const next = { ...(current ?? houston), ...applied.value.values, id };
    const i = trips.findIndex((t) => t.id === id);
    if (i === -1) trips.push(next);
    else trips[i] = next;
    return { status: 'saved', tripId: id, refiled: 0 };
  };
  const store: TripStore = {
    list: (_org, _limit, filter) => {
      filters.push(filter);
      return Promise.resolve({ trips, tallies });
    },
    get: (_org, id) => {
      const trip = trips.find((t) => t.id === id);
      return Promise.resolve(
        trip
          ? {
              trip,
              tallies,
              expenses: {
                expenses: id === TRIP ? [hotel] : [],
                receipts: [],
                runs: [],
                reviews: [],
              },
            }
          : undefined,
      );
    },
    create: (_org, _member, input) => Promise.resolve(save(NEW_TRIP, null, input)),
    edit: (_org, id, input) => {
      const trip = trips.find((t) => t.id === id);
      return Promise.resolve(trip ? save(id, trip, input) : { status: 'missing' });
    },
    remove: (_org, id) => {
      const refused = removals[id];
      if (refused) return Promise.resolve(refused);
      const i = trips.findIndex((t) => t.id === id);
      if (i === -1) return Promise.resolve({ status: 'missing' });
      trips.splice(i, 1);
      return Promise.resolve({ status: 'deleted', refiled: 1 });
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
    trips: store,
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
    return {
      status: res.status,
      body: (await res.json().catch(() => null)) as Record<string, unknown>,
    };
  };
  return { call, trips, filters, removals };
}

describe('trips', () => {
  it('lists trips with their progress and a total per currency, never converted', async () => {
    const { call } = setup();
    const res = await call('GET', '/v1/trips', 'riley');
    expect(res.status).toBe(200);
    expect(res.body.trips).toEqual([
      {
        id: TRIP,
        name: 'Houston · Acme onsite',
        purpose: 'Client onsite',
        primaryCity: 'Houston',
        startDate: '2026-09-22',
        endDate: '2026-09-25',
        days: 4,
        owner: 'riley',
        expenseCount: 9,
        readyCount: 6,
        reportId: null,
        needsReviewCount: 2,
        totals: [
          { amountMinor: 1200, currency: 'EUR', decimal: '12.00' },
          { amountMinor: 125760, currency: 'USD', decimal: '1257.60' },
        ],
        createdAt: NOW.toISOString(),
      },
    ]);
  });

  it('searches by text and dates, and refuses a date that does not exist', async () => {
    const { call, filters } = setup();
    await call('GET', '/v1/trips?q=houston&from=2026-09-01&to=2026-09-30', 'riley');
    expect(filters.at(-1)).toEqual({ q: 'houston', from: '2026-09-01', to: '2026-09-30' });
    expect((await call('GET', '/v1/trips?from=2026-02-30', 'riley')).status).toBe(400);
  });

  it('shows a trip with its expenses, each with the trip it is filed to', async () => {
    const { call } = setup();
    const res = await call('GET', `/v1/trips/${TRIP}`, 'riley');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: TRIP, days: 4, readyCount: 6 });
    expect(res.body.expenses).toEqual([
      expect.objectContaining({
        id: EXPENSE,
        merchant: 'Hotel ZaZa',
        trip: { id: TRIP, name: 'Houston · Acme onsite' },
        tripFiledBy: 'date',
      }),
    ]);
  });

  it('makes a trip for the caller and answers with it', async () => {
    const { call } = setup();
    const res = await call('POST', '/v1/trips', 'riley', {
      name: 'Denver offsite',
      startDate: '2026-10-05',
      endDate: '2026-10-07',
      primaryCity: 'Denver',
    });
    expect(res).toMatchObject({
      status: 201,
      body: { id: NEW_TRIP, name: 'Denver offsite', days: 3, purpose: null, expenses: [] },
    });
  });

  it('names the field that is not valid', async () => {
    const { call } = setup();
    expect(
      await call('POST', '/v1/trips', 'riley', {
        name: 'Backwards',
        startDate: '2026-10-07',
        endDate: '2026-10-05',
      }),
    ).toMatchObject({ status: 422, body: { code: 'invalid_value', field: 'endDate' } });
    expect(await call('PATCH', `/v1/trips/${TRIP}`, 'riley', { startDate: 'soon' })).toMatchObject({
      status: 422,
      body: { field: 'startDate' },
    });
    expect((await call('POST', '/v1/trips', 'riley', { name: 'No dates' })).status).toBe(400);
    expect((await call('PATCH', `/v1/trips/${TRIP}`, 'riley', {})).status).toBe(400);
    expect((await call('PATCH', `/v1/trips/${TRIP}`, 'riley', { status: 'closed' })).status).toBe(
      400,
    );
  });

  it('edits a trip and answers with it as it is now', async () => {
    const { call } = setup();
    const res = await call('PATCH', `/v1/trips/${TRIP}`, 'riley', {
      endDate: '2026-09-26',
      purpose: null,
    });
    expect(res).toMatchObject({
      status: 200,
      body: { endDate: '2026-09-26', days: 5, purpose: null },
    });
    expect(
      (await call('PATCH', `/v1/trips/${TRIP}`, 'riley', { endDate: '2026-09-26' })).status,
    ).toBe(200);
  });

  it('deletes a trip, unless something submitted rests on it', async () => {
    const { call, removals, trips } = setup();
    removals[TRIP] = { status: 'has_submitted', count: 2 };
    expect(await call('DELETE', `/v1/trips/${TRIP}`, 'riley')).toMatchObject({
      status: 409,
      body: {
        code: 'has_submitted',
        detail: '2 of its expenses are submitted or later, and stay with their trip.',
      },
    });
    removals[TRIP] = { status: 'has_submitted', count: 1 };
    expect((await call('DELETE', `/v1/trips/${TRIP}`, 'riley')).body.detail).toMatch(
      /^1 of its expenses is/,
    );
    delete removals[TRIP];
    expect((await call('DELETE', `/v1/trips/${TRIP}`, 'riley')).status).toBe(204);
    expect(trips).toEqual([]);
  });

  it('answers 404 for a trip it does not have, and needs a signed-in member', async () => {
    const { call } = setup();
    const missing = '0192f7a0-0000-7000-8000-0000000000c9';
    expect((await call('GET', `/v1/trips/${missing}`, 'riley')).status).toBe(404);
    expect((await call('PATCH', `/v1/trips/${missing}`, 'riley', { name: 'x' })).status).toBe(404);
    expect((await call('DELETE', `/v1/trips/${missing}`, 'riley')).status).toBe(404);
    expect((await call('GET', '/v1/trips')).status).toBe(401);
    expect((await call('GET', '/v1/trips', 'mallory')).status).toBe(403);
  });

  it('answers 503 when no database is configured', async () => {
    const api = createApi({ version: 't', verifyToken: (t) => Promise.resolve(identity(t)) });
    const res = await api.request('/v1/trips', { headers: { authorization: 'Bearer riley' } });
    expect(res.status).toBe(503);
  });
});
