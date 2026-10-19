import type {
  CommittedEvent,
  ExpenseRecord,
  Membership,
  MileageRecord,
  ReportForExport,
  RouteRecord,
  SavedPlace,
  StoredRouteKey,
} from '@expensewise/db';
import {
  applyPlaceInput,
  applyRouteDriveInput,
  claimRouteMiles,
  isExpenseEditable,
  milesFromMetres,
  quoteMileage,
  type ExportExpense,
  type MemberRole,
  type RouteDriveValues,
} from '@expensewise/domain';
import { describe, expect, it } from 'vitest';
import { createApi } from '../src/app.ts';
import type { Identity } from '../src/auth.ts';
import type { MileageStore } from '../src/mileage.ts';
import type { ReportStore } from '../src/reports.ts';
import type { OrganizationStore } from '../src/organization.ts';
import {
  routeSealContext,
  sealPick,
  type PlaceSuggester,
  type RouteKeyStore,
  type RouteKeyVerdict,
  type RouteMileageStore,
} from '../src/route-mileage.ts';
import { createSecretBox } from '../src/secret-box.ts';
import type { WorkspaceStore } from '../src/workspace.ts';

const ORG = '0192f7a0-0000-7000-8000-0000000000a1';
const RILEY = '0192f7a0-0000-7000-8000-0000000000b1';
const JORDAN = '0192f7a0-0000-7000-8000-0000000000b2';
const REPORT = '0192f7a0-0000-7000-8000-0000000000e1';
const NOW = new Date('2026-10-04T12:00:00.000Z');
const FLAG = 'expenses.route-mileage=on';
const ORS_KEY = '5b3ce3597851110001cf6248a1b2c3d4e5f60718293a4b5c6d7e8f90wxyz';

const identity = (userId: string): Identity => ({
  userId,
  email: `${userId}@example.com`,
  assuranceLevel: 'aal1',
  sessionId: 's',
  issuedAt: NOW,
});

const drive = {
  date: '2026-09-29',
  purpose: 'Client visit at Acme',
  stops: ['12 Elm St, Omaha, NE', 'Acme HQ, 1520 Harney St', 'Eppley Airfield'],
};

interface Entry {
  expense: ExpenseRecord;
  mileage: MileageRecord;
  route: RouteRecord;
}

/** Route drives and places in memory, by the domain's own rules. */
function fakeRoutes() {
  const entries = new Map<string, Entry>();
  const places = new Map<string, SavedPlace & { memberId: string }>();
  let next = 0;
  const id = () => `0192f7a0-0000-7000-8000-00000000f0${String(next++).padStart(2, '0')}`;
  const request = (expenseId: string): CommittedEvent => ({
    outboxId: id(),
    topic: 'mileage.route_measure_requested',
    orgId: ORG,
    payload: { expenseId },
  });
  const unmeasured = (values: RouteDriveValues, requestId: string) =>
    ({
      status: 'measuring',
      roundTrip: values.roundTrip,
      requestId,
      problem: null,
      provider: null,
      profile: null,
      measuredAt: null,
      distanceMetres: null,
      returnMetres: null,
      measuredMiles: null,
      milesReason: null,
      stops: values.stops.map((address, position) => {
        const pin = values.pins?.[position];
        return {
          position,
          address,
          label: pin?.label ?? null,
          longitude: pin?.longitude ?? null,
          latitude: pin?.latitude ?? null,
          pinned: pin !== undefined && pin !== null,
          legMetres: null,
        };
      }),
    }) satisfies RouteRecord;
  const store: RouteMileageStore = {
    log: (_org, memberId, input, _actor, today) => {
      const applied = applyRouteDriveInput(null, input, today);
      if (!applied.ok) return Promise.resolve({ status: 'invalid', problem: applied.error });
      const { values, rate } = applied.value;
      const expenseId = id();
      const event = request(expenseId);
      const end = values.stops[values.stops.length - 1]!;
      entries.set(expenseId, {
        expense: {
          id: expenseId,
          memberId,
          owner: 'riley',
          status: 'processing',
          source: 'mileage',
          merchant: end,
          transactionDate: values.date,
          currency: null,
          amountMinor: null,
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
          reportId: null,
          tripReportId: null,
          justification: values.purpose,
          editedAt: null,
          createdAt: NOW,
          updatedAt: NOW,
        },
        mileage: {
          expenseId,
          memberId,
          status: 'processing',
          method: 'route',
          date: values.date,
          destination: end,
          purpose: values.purpose,
          miles: '0',
          unit: 'mi',
          rate: rate!,
          amountMinor: null,
        },
        route: unmeasured(values, event.outboxId),
      });
      return Promise.resolve({ status: 'logged', expenseId, event });
    },
    get: (_org, memberId, expenseId) => {
      const found = entries.get(expenseId);
      return Promise.resolve(found?.expense.memberId === memberId ? found : undefined);
    },
    change: (_org, memberId, expenseId, input, _actor, today) => {
      const found = entries.get(expenseId);
      if (found?.expense.memberId !== memberId) return Promise.resolve({ status: 'missing' });
      const status = found.expense.status;
      if (status !== 'processing' && !isExpenseEditable(status)) {
        return Promise.resolve({ status: 'not_editable', current: status });
      }
      const pins = found.route.stops.map((s) =>
        s.pinned ? { label: s.label!, longitude: s.longitude!, latitude: s.latitude! } : null,
      );
      const current: RouteDriveValues = {
        date: found.mileage.date,
        purpose: found.mileage.purpose,
        stops: found.route.stops.map((s) => s.address),
        ...(pins.some(Boolean) ? { pins } : {}),
        roundTrip: found.route.roundTrip,
      };
      const applied = applyRouteDriveInput(current, input, today);
      if (!applied.ok) return Promise.resolve({ status: 'invalid', problem: applied.error });
      const { values, changes } = applied.value;
      const remeasured =
        applied.value.remeasure || (input.stops !== undefined && found.route.status !== 'measured');
      if (changes.length === 0 && !remeasured) return Promise.resolve({ status: 'unchanged' });
      const event = remeasured ? request(expenseId) : null;
      found.mileage = { ...found.mileage, date: values.date, purpose: values.purpose };
      if (event) {
        found.route = unmeasured(values, event.outboxId);
        found.expense = { ...found.expense, status: 'processing', amountMinor: null };
      }
      return Promise.resolve({ status: 'changed', changes, remeasured, event });
    },
    claim: (_org, memberId, expenseId, input, _actor, today) => {
      const found = entries.get(expenseId);
      if (found?.expense.memberId !== memberId) return Promise.resolve({ status: 'missing' });
      const status = found.expense.status;
      if (status !== 'processing' && !isExpenseEditable(status)) {
        return Promise.resolve({ status: 'not_editable', current: status });
      }
      if (found.route.status === 'measuring') return Promise.resolve({ status: 'measuring' });
      const claimed = claimRouteMiles(input, found.route.measuredMiles, found.mileage.date, today);
      if (!claimed.ok) return Promise.resolve({ status: 'invalid', problem: claimed.error });
      const { miles, reason, claim } = claimed.value;
      found.route = { ...found.route, milesReason: reason };
      found.mileage = { ...found.mileage, miles, amountMinor: claim.amount.amountMinor };
      found.expense = {
        ...found.expense,
        status: 'ready',
        amountMinor: claim.amount.amountMinor,
        currency: 'USD',
      };
      return Promise.resolve({ status: 'claimed', miles, reason });
    },
    places: (_org, memberId) =>
      Promise.resolve([...places.values()].filter((p) => p.memberId === memberId)),
    recentPlaces: (_org, memberId) =>
      Promise.resolve(
        [...entries.values()]
          .filter((e) => e.expense.memberId === memberId)
          .reverse()
          .flatMap((e) =>
            e.route.stops.flatMap((s) =>
              s.label && s.longitude && s.latitude
                ? [
                    {
                      address: s.address,
                      label: s.label,
                      longitude: s.longitude,
                      latitude: s.latitude,
                      lastDriven: e.mileage.date,
                    },
                  ]
                : [],
            ),
          ),
      ),
    savePlace: (_org, memberId, placeId, input) => {
      const current = placeId === null ? undefined : places.get(placeId);
      if (placeId !== null && current?.memberId !== memberId) {
        return Promise.resolve({ status: 'missing' });
      }
      const applied = applyPlaceInput(current ?? null, input);
      if (!applied.ok) return Promise.resolve({ status: 'invalid', problem: applied.error });
      const taken = [...places.values()].some(
        (p) =>
          p.memberId === memberId &&
          p.id !== placeId &&
          p.name.toLowerCase() === applied.value.name.toLowerCase(),
      );
      if (taken) return Promise.resolve({ status: 'taken' });
      const place = { id: placeId ?? id(), memberId, ...applied.value };
      places.set(place.id, place);
      return Promise.resolve({ status: 'saved', place });
    },
    removePlace: (_org, memberId, placeId) => {
      const found = places.get(placeId);
      if (found?.memberId !== memberId) return Promise.resolve(false);
      places.delete(placeId);
      return Promise.resolve(true);
    },
  };
  /** As the workflow would record it: legs in whole metres, priced at the rate on the day. */
  const measure = (expenseId: string, legs: number[]) => {
    const found = entries.get(expenseId)!;
    const metres = legs.reduce((a, b) => a + b, 0);
    const miles = milesFromMetres(metres);
    const quote = quoteMileage({ date: found.mileage.date, miles }, '2026-10-04');
    if (!quote.ok) throw new Error(quote.error.message);
    found.route = {
      ...found.route,
      status: 'measured',
      provider: 'openrouteservice',
      profile: 'driving-car',
      measuredAt: NOW,
      distanceMetres: metres,
      measuredMiles: miles,
      stops: found.route.stops.map((s, i) => ({
        ...s,
        ...(s.pinned
          ? {}
          : { label: `${s.address}, USA`, longitude: '-95.900000', latitude: '41.250000' }),
        legMetres: i === 0 ? null : legs[i - 1]!,
      })),
    };
    found.mileage = { ...found.mileage, miles, amountMinor: quote.value.amount.amountMinor };
    found.expense = {
      ...found.expense,
      status: 'ready',
      amountMinor: quote.value.amount.amountMinor,
      currency: 'USD',
    };
  };
  return { store, entries, places, measure };
}

function fakeKeys() {
  let stored: StoredRouteKey | undefined;
  const saved: { memberId: string; actor: string }[] = [];
  const keys: RouteKeyStore = {
    get: () => Promise.resolve(stored),
    save: (_org, key, actor) => {
      stored = {
        provider: key.provider,
        ciphertext: key.ciphertext,
        keyHint: key.keyHint,
        verifiedAt: key.verifiedAt,
        updatedAt: NOW,
      };
      saved.push({ memberId: key.memberId, actor });
      return Promise.resolve(stored);
    },
    remove: () => {
      const had = stored !== undefined;
      stored = undefined;
      return Promise.resolve(had);
    },
  };
  return { keys, saved, stored: () => stored };
}

const secrets = createSecretBox('route-test-secret-0123456789');

function setup(
  options: {
    flags?: string;
    role?: MemberRole;
    verdict?: RouteKeyVerdict;
    exported?: ExportExpense[];
    suggest?: PlaceSuggester;
  } = {},
) {
  const routes = fakeRoutes();
  const keys = fakeKeys();
  const dispatched: CommittedEvent[] = [];
  const checked: string[] = [];
  const memberships: Record<string, Membership> = {
    riley: { orgId: ORG, memberId: RILEY, role: 'owner' },
    jordan: { orgId: ORG, memberId: JORDAN, role: options.role ?? 'member' },
  };
  const mileage = {
    edit: () => Promise.resolve({ status: 'route' }),
  } as unknown as MileageStore;
  const reports = {
    forExport: (): Promise<ReportForExport> =>
      Promise.resolve({
        report: {
          id: REPORT,
          memberId: RILEY,
          owner: 'Riley',
          organization: 'Acme',
          title: 'September',
          status: 'closed',
          openedAt: new Date('2026-09-04T12:00:00Z'),
          closedAt: new Date('2026-10-02T12:00:00Z'),
        },
        expenses: options.exported ?? [],
      }),
  } as unknown as ReportStore;
  const api = createApi({
    version: 't',
    verifyToken: (token) => Promise.resolve(identity(token)),
    workspace: {
      findMembership: (userId: string) => Promise.resolve(memberships[userId]),
      featureOn: () => Promise.resolve(false),
    } as unknown as WorkspaceStore,
    routeMileage: routes.store,
    routeKeys: keys.keys,
    mileage,
    reports,
    secrets,
    verifyRouteKey: (key) => {
      checked.push(key);
      return Promise.resolve(options.verdict ?? { ok: true });
    },
    ...(options.suggest ? { suggestPlaces: options.suggest } : {}),
    organization: {
      get: () => Promise.resolve({ country: 'US' }),
    } as unknown as OrganizationStore,
    dispatch: (events) => {
      dispatched.push(...events);
      return Promise.resolve();
    },
    flagOverrides: options.flags ?? FLAG,
    now: () => NOW,
  });
  const call = async (method: string, path: string, body?: unknown, who = 'riley') => {
    const res = await api.request(path, {
      method,
      headers: {
        authorization: `Bearer ${who}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return {
      status: res.status,
      text,
      body: (text.startsWith('{') ? JSON.parse(text) : null) as Record<string, unknown> & {
        route?: Record<string, unknown>;
        code?: string;
      },
    };
  };
  return { call, routes, keys, dispatched, checked };
}

const ATTRIBUTION =
  'Route © openrouteservice.org by HeiGIT · Map data © OpenStreetMap contributors';

describe('route mileage, switched off (ADR-0032)', () => {
  const ID = '0192f7a0-0000-7000-8000-0000000000c1';
  it.each([
    ['POST', '/v1/mileage/routes', drive],
    ['GET', `/v1/mileage/${ID}/route`, undefined],
    ['PATCH', `/v1/mileage/${ID}/route`, { purpose: 'x' }],
    ['PUT', `/v1/mileage/${ID}/route/miles`, { miles: '1', reason: 'x' }],
    ['GET', '/v1/me/places', undefined],
    ['POST', '/v1/me/places', { name: 'Home', address: '12 Elm St' }],
    ['PATCH', `/v1/me/places/${ID}`, { name: 'Office' }],
    ['DELETE', `/v1/me/places/${ID}`, undefined],
    ['GET', '/v1/settings/mileage/route-key', undefined],
    ['PUT', '/v1/settings/mileage/route-key', { apiKey: ORS_KEY }],
    ['DELETE', '/v1/settings/mileage/route-key', undefined],
  ])('answers 404 feature_off to %s %s, and does nothing', async (method, path, body) => {
    const s = setup({ flags: 'expenses.route-mileage=off' });
    const res = await s.call(method, path, body);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('feature_off');
    expect(s.routes.entries.size).toBe(0);
    expect(s.checked).toEqual([]);
    expect(s.dispatched).toEqual([]);
  });

  it('exports a report as it always was, without the miles columns', async () => {
    const s = setup({
      flags: 'reports.export=on',
      exported: [exported({ measured: '38.4', claimed: '41', reason: 'Detour' })],
    });
    const res = await s.call('GET', `/v1/reports/${REPORT}/export.csv`);
    expect(res.status).toBe(200);
    expect(res.text.split('\r\n')[0]).toBe(
      'Date,Merchant,Category,Type,Trip,Purpose,Note,Amount,Currency',
    );
    expect(res.text).not.toMatch(/openrouteservice/);
  });
});

const exported = (miles: ExportExpense['miles']): ExportExpense => ({
  date: '2026-09-29',
  merchant: 'Eppley Airfield',
  category: null,
  type: null,
  trip: 'Omaha',
  purpose: 'Client visit at Acme',
  note: null,
  amountMinor: 2973,
  currency: 'USD',
  miles,
});

describe('a route drive (FR-CAP-04)', () => {
  it('logs a drive by its stops for the caller, Measuring…, and hands on the request to measure it', async () => {
    const s = setup();
    const res = await s.call('POST', '/v1/mileage/routes', drive);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      status: 'processing',
      source: 'mileage',
      merchant: 'Eppley Airfield',
      amount: null,
      mileage: { method: 'route', purpose: drive.purpose, rate: { perUnit: '0.725' } },
      route: {
        status: 'measuring',
        problem: null,
        roundTrip: false,
        stops: drive.stops.map((address) => ({ address, place: null, legMetres: null })),
        measured: null,
        claimedMiles: null,
        reason: null,
        attribution: ATTRIBUTION,
      },
    });
    expect(s.dispatched).toEqual([
      expect.objectContaining({
        topic: 'mileage.route_measure_requested',
        payload: { expenseId: res.body.id },
      }),
    ]);
    const entry = s.routes.entries.get(res.body.id as string)!;
    expect(entry.expense.memberId).toBe(RILEY);
  });

  it('names the stop that is not valid, and logs nothing', async () => {
    const s = setup();
    const res = await s.call('POST', '/v1/mileage/routes', {
      ...drive,
      stops: ['12 Elm St', ' ', 'Eppley Airfield'],
    });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ code: 'invalid_value', field: 'stops', stop: 1 });
    expect(s.routes.entries.size).toBe(0);
  });

  it('shows a measured drive with each stop’s place and leg, the metres, the miles and its source', async () => {
    const s = setup();
    const { body } = await s.call('POST', '/v1/mileage/routes', drive);
    s.routes.measure(body.id as string, [9_400, 52_400]);
    const res = await s.call('GET', `/v1/mileage/${body.id as string}/route`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'ready',
      amount: { amountMinor: 2784, currency: 'USD' },
      route: {
        status: 'measured',
        stops: [
          { place: { label: '12 Elm St, Omaha, NE, USA' }, legMetres: null },
          { legMetres: 9_400 },
          { legMetres: 52_400 },
        ],
        measured: {
          metres: 61_800,
          miles: '38.4',
          provider: 'openrouteservice',
          profile: 'driving-car',
          measuredAt: NOW.toISOString(),
        },
        claimedMiles: '38.4',
        reason: null,
        attribution: ATTRIBUTION,
      },
    });
  });

  it('measures it again only when its stops or round trip change', async () => {
    const s = setup();
    const { body } = await s.call('POST', '/v1/mileage/routes', drive);
    const id = body.id as string;
    s.routes.measure(id, [9_400, 52_400]);
    s.dispatched.length = 0;
    const renamed = await s.call('PATCH', `/v1/mileage/${id}/route`, { purpose: 'Acme onsite' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.route).toMatchObject({ status: 'measured' });
    expect(s.dispatched).toEqual([]);
    const round = await s.call('PATCH', `/v1/mileage/${id}/route`, { roundTrip: true });
    expect(round.body).toMatchObject({ status: 'processing', route: { status: 'measuring' } });
    expect(s.dispatched).toHaveLength(1);
  });

  it('changes the measured miles only with a reason, and shows both with the reason', async () => {
    const s = setup();
    const { body } = await s.call('POST', '/v1/mileage/routes', drive);
    const id = body.id as string;
    const early = await s.call('PUT', `/v1/mileage/${id}/route/miles`, {
      miles: '41',
      reason: 'x',
    });
    expect(early).toMatchObject({ status: 409, body: { code: 'measuring' } });
    s.routes.measure(id, [9_400, 52_400]);

    const bare = await s.call('PUT', `/v1/mileage/${id}/route/miles`, { miles: '41' });
    expect(bare.status).toBe(422);
    expect(bare.body).toMatchObject({ code: 'invalid_value', field: 'reason' });
    const res = await s.call('PUT', `/v1/mileage/${id}/route/miles`, {
      miles: '41',
      reason: 'Road closed at the bridge',
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      amount: { amountMinor: 2973 },
      route: {
        measured: { miles: '38.4', metres: 61_800 },
        claimedMiles: '41',
        reason: 'Road closed at the bridge',
      },
    });
  });

  it('refuses a change once the drive is submitted, and a change to it as a drive logged by hand', async () => {
    const s = setup({ flags: `${FLAG},expenses.mileage=on` });
    const { body } = await s.call('POST', '/v1/mileage/routes', drive);
    const id = body.id as string;
    s.routes.measure(id, [9_400, 52_400]);
    const manual = await s.call('PATCH', `/v1/mileage/${id}`, { miles: '50' });
    expect(manual).toMatchObject({ status: 409, body: { code: 'route' } });
    const entry = s.routes.entries.get(id)!;
    entry.expense = { ...entry.expense, status: 'submitted' };
    expect(await s.call('PATCH', `/v1/mileage/${id}/route`, { stops: ['A', 'B'] })).toMatchObject({
      status: 409,
      body: { code: 'locked' },
    });
    expect(
      await s.call('PUT', `/v1/mileage/${id}/route/miles`, { miles: '50', reason: 'x' }),
    ).toMatchObject({ status: 409, body: { code: 'locked' } });
  });

  it('opens and changes only the caller’s own route drives', async () => {
    const s = setup();
    const { body } = await s.call('POST', '/v1/mileage/routes', drive);
    const id = body.id as string;
    expect((await s.call('GET', `/v1/mileage/${id}/route`, undefined, 'jordan')).status).toBe(404);
    expect(
      (await s.call('PATCH', `/v1/mileage/${id}/route`, { purpose: 'x' }, 'jordan')).status,
    ).toBe(404);
  });

  it('exports the measured and claimed miles with the reason, and where the route came from', async () => {
    const s = setup({
      flags: `${FLAG},reports.export=on`,
      exported: [
        exported({ measured: '38.4', claimed: '41', reason: 'Road closed at the bridge' }),
      ],
    });
    const csv = await s.call('GET', `/v1/reports/${REPORT}/export.csv`);
    const lines = csv.text.split('\r\n');
    expect(lines[0]).toBe(
      'Date,Merchant,Category,Type,Trip,Purpose,Note,Amount,Currency,Miles measured,Miles claimed,Why the miles differ',
    );
    expect(lines[1]).toBe(
      '2026-09-29,Eppley Airfield,,,Omaha,Client visit at Acme,,29.73,USD,38.4,41,Road closed at the bridge',
    );
    expect(lines.at(-2)).toBe(ATTRIBUTION);
    const pdf = await s.call('GET', `/v1/reports/${REPORT}/export.pdf`);
    expect(pdf.status).toBe(200);
  });
});

describe('saved places', () => {
  it('keeps the caller’s places, each name once, and changes or removes only their own', async () => {
    const s = setup();
    const home = await s.call('POST', '/v1/me/places', { name: 'Home', address: '12 Elm St' });
    expect(home).toMatchObject({ status: 201, body: { name: 'Home', address: '12 Elm St' } });
    const id = home.body.id as string;
    expect(await s.call('POST', '/v1/me/places', { name: 'home', address: 'x' })).toMatchObject({
      status: 409,
      body: { code: 'name_taken' },
    });
    expect(await s.call('POST', '/v1/me/places', { name: ' ', address: 'x' })).toMatchObject({
      status: 422,
      body: { field: 'name' },
    });
    expect(await s.call('PATCH', `/v1/me/places/${id}`, { address: '14 Oak Ave' })).toMatchObject({
      status: 200,
      body: { address: '14 Oak Ave' },
    });
    expect((await s.call('GET', '/v1/me/places')).body).toEqual({
      places: [{ id, name: 'Home', address: '14 Oak Ave' }],
    });
    expect((await s.call('GET', '/v1/me/places', undefined, 'jordan')).body).toEqual({
      places: [],
    });
    expect((await s.call('DELETE', `/v1/me/places/${id}`, undefined, 'jordan')).status).toBe(404);
    expect((await s.call('DELETE', `/v1/me/places/${id}`)).status).toBe(204);
  });
});

describe('the OpenRouteService key in Settings (Q31)', () => {
  it('checks a key with OpenRouteService as it is saved, stores it encrypted, and shows only its last four characters', async () => {
    const s = setup();
    expect((await s.call('GET', '/v1/settings/mileage/route-key')).body).toEqual({
      provider: 'openrouteservice',
      configured: false,
      keyHint: null,
      verifiedAt: null,
      updatedAt: null,
    });
    const res = await s.call('PUT', '/v1/settings/mileage/route-key', { apiKey: ` ${ORS_KEY}\n` });
    expect(res.status).toBe(200);
    expect(s.checked).toEqual([ORS_KEY]);
    expect(res.body).toEqual({
      provider: 'openrouteservice',
      configured: true,
      keyHint: 'wxyz',
      verifiedAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    });
    expect(res.text).not.toContain(ORS_KEY);
    const stored = s.keys.stored()!;
    expect(stored.ciphertext).not.toContain(ORS_KEY);
    expect(secrets.open(stored.ciphertext, routeSealContext(ORG, 'openrouteservice'))).toBe(
      ORS_KEY,
    );
    // Bound to its organization and provider: under an AI key's context it won't open.
    expect(() => secrets.open(stored.ciphertext, `${ORG}:openai`)).toThrow();
    expect(s.keys.saved).toEqual([{ memberId: RILEY, actor: 'riley' }]);
    expect((await s.call('DELETE', '/v1/settings/mileage/route-key')).status).toBe(204);
    expect((await s.call('DELETE', '/v1/settings/mileage/route-key')).body.code).toBe(
      'not_configured',
    );
  });

  it('stores nothing when OpenRouteService refuses the key or can’t say', async () => {
    const rejected = setup({
      verdict: {
        ok: false,
        reason: 'rejected',
        status: 403,
        detail: 'OpenRouteService answered 403: Access to this API has been disallowed',
      },
    });
    const refused = await rejected.call('PUT', '/v1/settings/mileage/route-key', {
      apiKey: ORS_KEY,
    });
    expect(refused.status).toBe(422);
    expect(refused.body).toMatchObject({
      code: 'key_rejected',
      detail:
        'OpenRouteService answered 403: Access to this API has been disallowed. Nothing was stored.',
    });
    expect(rejected.keys.stored()).toBeUndefined();

    const busy = setup({ verdict: { ok: false, reason: 'limited', status: 429 } });
    const limited = await busy.call('PUT', '/v1/settings/mileage/route-key', { apiKey: ORS_KEY });
    expect(limited).toMatchObject({ status: 502, body: { code: 'provider_unreachable' } });
    expect(busy.keys.stored()).toBeUndefined();

    const short = await busy.call('PUT', '/v1/settings/mileage/route-key', { apiKey: 'abc' });
    expect(short).toMatchObject({ status: 422, body: { code: 'key_malformed' } });
  });

  it('lets only an owner or finance admin see, set or remove it', async () => {
    const s = setup();
    for (const [method, body] of [
      ['GET', undefined],
      ['PUT', { apiKey: ORS_KEY }],
      ['DELETE', undefined],
    ] as const) {
      const res = await s.call(method, '/v1/settings/mileage/route-key', body, 'jordan');
      expect(res).toMatchObject({ status: 403, body: { code: 'forbidden_role' } });
    }
    expect(s.checked).toEqual([]);
    const admin = setup({ role: 'finance_admin' });
    expect(
      (await admin.call('PUT', '/v1/settings/mileage/route-key', { apiKey: ORS_KEY }, 'jordan'))
        .status,
    ).toBe(200);
  });
});

const SUGGESTIONS = `${FLAG},expenses.place-suggestions=on`;
const OTHER_ORG = '0192f7a0-0000-7000-8000-0000000000a2';
const EPPLEY = {
  name: 'Eppley Airfield',
  detail: '4501 Abbott Drive, Omaha, NE, USA',
  address: 'Eppley Airfield, 4501 Abbott Drive, Omaha, NE, USA',
  label: 'Eppley Airfield, Omaha, NE, USA',
  longitude: -95.894069,
  latitude: 41.303166,
};
const EPPLEY_PIN = {
  label: EPPLEY.label,
  longitude: '-95.894069',
  latitude: '41.303166',
};

/** OpenRouteService's suggestions as a stand-in gives them, and what each was asked. */
function suggester(answer: Awaited<ReturnType<PlaceSuggester>> = { ok: true, places: [EPPLEY] }) {
  const asked: Parameters<PlaceSuggester>[] = [];
  const suggest: PlaceSuggester = (...args) => {
    asked.push(args);
    return Promise.resolve(answer);
  };
  return { suggest, asked };
}

describe('place suggestions for a stop (FR-CAP-14, ADR-0052)', () => {
  it.each([
    ['POST', '/v1/mileage/place-suggestions', { text: 'eppley' }],
    ['GET', '/v1/me/recent-places', undefined],
  ])(
    'answers 404 feature_off to %s %s while suggestions are off, route mileage on',
    async (method, path, body) => {
      const { suggest, asked } = suggester();
      const s = setup({ suggest });
      const res = await s.call(method, path, body);
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('feature_off');
      expect(asked).toEqual([]);
    },
  );

  it('suggests places for what is typed, in the organization’s country and near the place given, each with a pick', async () => {
    const { suggest, asked } = suggester();
    const s = setup({ flags: SUGGESTIONS, suggest });
    const res = await s.call('POST', '/v1/mileage/place-suggestions', {
      text: '  eppley   air ',
      near: { longitude: -95.934502, latitude: 41.256537 },
    });
    expect(res.status).toBe(200);
    expect(asked).toEqual([
      [
        ORG,
        { text: 'eppley air', country: 'US', near: { longitude: -95.934502, latitude: 41.256537 } },
      ],
    ]);
    expect(res.body).toEqual({
      places: [
        {
          name: 'Eppley Airfield',
          detail: '4501 Abbott Drive, Omaha, NE, USA',
          address: 'Eppley Airfield, 4501 Abbott Drive, Omaha, NE, USA',
          label: 'Eppley Airfield, Omaha, NE, USA',
          longitude: '-95.894069',
          latitude: '41.303166',
          pick: expect.stringMatching(/^v1\./) as unknown,
        },
      ],
      problem: null,
      attribution:
        'Places © openrouteservice.org by HeiGIT · Map data © OpenStreetMap contributors',
    });
  });

  it('asks OpenRouteService nothing for fewer than three characters', async () => {
    const { suggest, asked } = suggester();
    const s = setup({ flags: SUGGESTIONS, suggest });
    const res = await s.call('POST', '/v1/mileage/place-suggestions', { text: ' ep ' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ places: [], problem: null });
    expect(asked).toEqual([]);
  });

  it('says why there are none when there is no key or OpenRouteService fails, and never logs what was typed', async () => {
    const warned: unknown[][] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => void warned.push(args);
    try {
      for (const reason of ['no_key', 'limited', 'unreachable'] as const) {
        const s = setup({ flags: SUGGESTIONS, suggest: suggester({ ok: false, reason }).suggest });
        const res = await s.call('POST', '/v1/mileage/place-suggestions', {
          text: '1520 Harney',
        });
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ places: [], problem: reason });
      }
      const unconfigured = setup({ flags: SUGGESTIONS });
      expect(
        (await unconfigured.call('POST', '/v1/mileage/place-suggestions', { text: 'eppley' })).body,
      ).toMatchObject({ places: [], problem: 'unavailable' });
    } finally {
      console.warn = warn;
    }
    expect(JSON.stringify(warned)).not.toMatch(/Harney/);
  });

  it('measures a picked stop from exactly where it was picked, and keeps it when the stops come back', async () => {
    const s = setup({ flags: SUGGESTIONS });
    const pick = sealPick(secrets, ORG, EPPLEY_PIN);
    const logged = await s.call('POST', '/v1/mileage/routes', {
      ...drive,
      stops: ['12 Elm St, Omaha, NE', { address: EPPLEY.address, pick }],
    });
    expect(logged.status).toBe(201);
    const stops = logged.body.route?.stops as Record<string, unknown>[];
    expect(stops[0]).toMatchObject({ pinned: false, pick: null, place: null });
    expect(stops[1]).toMatchObject({
      address: EPPLEY.address,
      pinned: true,
      place: EPPLEY_PIN,
      pick: expect.stringMatching(/^v1\./) as unknown,
    });
    const id = logged.body.id as string;
    s.routes.measure(id, [61800]);
    const measured = await s.call('GET', `/v1/mileage/${id}/route`);
    const shown = measured.body.route?.stops as { address: string; pick: string | null }[];
    // The end keeps the place it was picked at; the start was found as typed.
    expect(shown[1]).toMatchObject({ place: EPPLEY_PIN, pinned: true });
    // Sent back as they came, with the pick they carry, the stops are unchanged: not measured again.
    const again = await s.call('PATCH', `/v1/mileage/${id}/route`, {
      stops: shown.map((stop) =>
        stop.pick ? { address: stop.address, pick: stop.pick } : stop.address,
      ),
    });
    expect(again.status).toBe(200);
    expect(again.body.route).toMatchObject({ status: 'measured' });
    expect(s.dispatched).toHaveLength(1);
    // Typed over, the same stop is no longer pinned, and the drive is measured again.
    const typed = await s.call('PATCH', `/v1/mileage/${id}/route`, {
      stops: ['12 Elm St, Omaha, NE', EPPLEY.address],
    });
    expect((typed.body.route?.stops as Record<string, unknown>[])[1]).toMatchObject({
      pinned: false,
      place: null,
    });
    expect(s.dispatched).toHaveLength(2);
  });

  it('refuses a pick it didn’t seal, made up or from another organization, and logs nothing', async () => {
    const s = setup({ flags: SUGGESTIONS });
    for (const pick of ['v1.made-up', sealPick(secrets, OTHER_ORG, EPPLEY_PIN)]) {
      const res = await s.call('POST', '/v1/mileage/routes', {
        ...drive,
        stops: ['12 Elm St, Omaha, NE', { address: EPPLEY.address, pick }],
      });
      expect(res.status).toBe(422);
      expect(res.body).toMatchObject({
        code: 'invalid_value',
        field: 'stops',
        stop: 1,
        detail:
          'The place picked for the end can’t be used here. Pick it again, or type its address.',
      });
    }
    expect(s.routes.entries.size).toBe(0);
    expect(s.dispatched).toEqual([]);
  });

  it('lists the places the caller’s own drives went to, newest first, each with a pick', async () => {
    const s = setup({ flags: SUGGESTIONS });
    const pick = sealPick(secrets, ORG, EPPLEY_PIN);
    const mine = await s.call('POST', '/v1/mileage/routes', {
      ...drive,
      stops: ['12 Elm St, Omaha, NE', { address: EPPLEY.address, pick }],
    });
    s.routes.measure(mine.body.id as string, [61800]);
    await s.call('POST', '/v1/mileage/routes', drive, 'jordan');
    const res = await s.call('GET', '/v1/me/recent-places');
    expect(res.status).toBe(200);
    const places = res.body.places as Record<string, unknown>[];
    expect(places.map((p) => p.address)).toEqual(['12 Elm St, Omaha, NE', EPPLEY.address]);
    expect(places[1]).toMatchObject({
      ...EPPLEY_PIN,
      lastDriven: drive.date,
      pick: expect.stringMatching(/^v1\./) as unknown,
    });
    // Its pick measures a new stop from the same place.
    const next = await s.call('POST', '/v1/mileage/routes', {
      ...drive,
      stops: ['1520 Harney St', { address: EPPLEY.address, pick: places[1]!.pick }],
    });
    expect((next.body.route?.stops as Record<string, unknown>[])[1]).toMatchObject({
      pinned: true,
      place: EPPLEY_PIN,
    });
  });
});
