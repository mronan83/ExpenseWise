import {
  mileageRate,
  newId,
  type MileageRateTable,
  type RouteDriveInput,
} from '@expensewise/domain';
import { and, asc, eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { withMember, withOrg } from '../src/client.ts';
import { getExpense } from '../src/expenses.ts';
import { editMileage } from '../src/mileage.ts';
import {
  changeRouteDrive,
  claimMilesForRoute,
  getRouteDrive,
  logRouteMileage,
  recordRouteMeasurement,
  ROUTE_MEASURE_REQUESTED,
  routeToMeasure,
  type RouteOutcome,
} from '../src/mileage-routes.ts';
import { deleteRouteKey, getRouteKey, saveRouteKey } from '../src/route-keys.ts';
import { listSavedPlaces, removePlace, savePlace } from '../src/saved-places.ts';
import {
  auditEvents,
  expenses,
  members,
  mileageRoutes,
  mileageRouteStops,
  organizations,
  outboxEvents,
  routeServiceKeys,
  savedPlaces,
} from '../src/schema.ts';
import { createTrip } from '../src/trips.ts';
import { connectAs, expectDbError, seedOrg } from './helpers.ts';

const app = connectAs('app');
afterAll(async () => {
  await app.pool.end();
});

const TODAY = '2026-10-04';
const NOW = new Date('2026-10-04T15:00:00Z');
const toClient: RouteDriveInput = {
  date: '2026-09-29',
  purpose: 'Client visit at Acme',
  stops: ['12 Elm St, Omaha, NE', 'Acme HQ, 1520 Harney St, Omaha', 'Eppley Airfield, Omaha'],
};

/** What OpenRouteService would have answered for `toClient`: three places, two legs. */
const measured = (legs: number[] = [9_400, 52_400]): RouteOutcome => ({
  kind: 'measured',
  provider: 'openrouteservice',
  profile: 'driving-car',
  places: [
    { label: '12 Elm Street, Omaha, NE, USA', longitude: '-95.934502', latitude: '41.256537' },
    { label: '1520 Harney Street, Omaha, NE, USA', longitude: '-95.936117', latitude: '41.257163' },
    { label: 'Eppley Airfield, Omaha, NE, USA', longitude: '-95.894069', latitude: '41.303166' },
  ],
  legs,
  measuredAt: NOW,
});

/** Who a store's transaction acts for. */
interface Who {
  readonly memberId: string;
  readonly role: 'owner' | 'member';
}

async function workspace(name: string) {
  const org = await seedOrg(app.db, name);
  const owner: Who = { memberId: org.memberId, role: 'owner' };
  /** As the system, as the measuring workflow is. */
  const inOrg = <T>(work: Parameters<typeof withOrg<T>>[2]) => withOrg(app.db, org.orgId, work);
  /** As a member, as the API's stores are (ADR-0035). */
  const as = <T>(who: Who, work: Parameters<typeof withOrg<T>>[2]) =>
    withMember(app.db, { orgId: org.orgId, ...who }, work);
  const log = async (input: Partial<RouteDriveInput> = {}, who = owner) => {
    const logged = await as(who, (tx) =>
      logRouteMileage(tx, org.orgId, who.memberId, { ...toClient, ...input }, org.userId, TODAY),
    );
    if (logged.status !== 'logged') throw new Error(`expected a drive, got ${logged.status}`);
    return logged;
  };
  const record = (id: string, requestId: string, outcome: RouteOutcome, rates?: MileageRateTable) =>
    inOrg((tx) => recordRouteMeasurement(tx, org.orgId, id, requestId, outcome, NOW, rates));
  const change = (id: string, input: RouteDriveInput, who = owner) =>
    as(who, (tx) => changeRouteDrive(tx, org.orgId, who.memberId, id, input, org.userId, TODAY));
  const claim = (id: string, input: { miles: string; reason?: string | null }, who = owner) =>
    as(who, (tx) => claimMilesForRoute(tx, org.orgId, who.memberId, id, input, org.userId, TODAY));
  const drive = (id: string, who = owner) => as(who, (tx) => getRouteDrive(tx, who.memberId, id));
  const expense = (id: string) => inOrg((tx) => getExpense(tx, id));
  const audit = (entityId: string) =>
    inOrg((tx) =>
      tx
        .select({ action: auditEvents.action, payload: auditEvents.payload })
        .from(auditEvents)
        .where(eq(auditEvents.entityId, entityId))
        .orderBy(asc(auditEvents.sequence)),
    );
  const colleague = async () => {
    const id = newId();
    await inOrg((tx) =>
      tx.insert(members).values({
        id,
        orgId: org.orgId,
        userId: `user_${id}`,
        email: `${id}@example.com`,
        displayName: 'Jordan',
        role: 'member',
      }),
    );
    const jordan: Who = { memberId: id, role: 'member' };
    return jordan;
  };
  return { org, owner, inOrg, as, log, record, change, claim, drive, expense, audit, colleague };
}

describe('logging a route drive (FR-CAP-04, ADR-0039)', () => {
  it('logs a route drive as processing, with its stops as typed, the rate copied on and a request to measure it', async () => {
    const w = await workspace('route-log');
    const trip = await w.as(w.owner, (tx) =>
      createTrip(
        tx,
        w.org.orgId,
        w.org.memberId,
        { name: 'Omaha', startDate: '2026-09-29', endDate: '2026-10-01' },
        w.org.userId,
      ),
    );
    const { expenseId: id, event } = await w.log();

    expect(await w.expense(id)).toMatchObject({
      status: 'processing',
      source: 'mileage',
      merchant: 'Eppley Airfield, Omaha',
      transactionDate: '2026-09-29',
      amountMinor: null,
      justification: 'Client visit at Acme',
      tripId: trip.status === 'saved' ? trip.tripId : 'no trip',
    });
    const found = await w.drive(id);
    expect(found?.mileage).toMatchObject({
      method: 'route',
      destination: 'Eppley Airfield, Omaha',
      miles: '0',
      rate: { perUnit: '0.7250', effectiveFrom: '2026-01-01', source: 'irs-business' },
    });
    expect(found?.route).toMatchObject({
      status: 'measuring',
      roundTrip: false,
      requestId: event.outboxId,
      measuredMiles: null,
      stops: toClient.stops!.map((address, position) => ({
        position,
        address,
        label: null,
        legMetres: null,
      })),
    });
    const [queued] = await w.inOrg((tx) =>
      tx.select().from(outboxEvents).where(eq(outboxEvents.id, event.outboxId)),
    );
    expect(queued).toMatchObject({ topic: ROUTE_MEASURE_REQUESTED, payload: { expenseId: id } });
    expect((await w.audit(id))[0]).toMatchObject({
      action: 'expense.created',
      payload: { method: 'route', status: 'processing', stops: toClient.stops, roundTrip: false },
    });
  });

  it('refuses a route drive that is not valid, and records nothing', async () => {
    const w = await workspace('route-invalid');
    const result = await w.as(w.owner, (tx) =>
      logRouteMileage(
        tx,
        w.org.orgId,
        w.org.memberId,
        { ...toClient, stops: ['Home'] },
        w.org.userId,
        TODAY,
      ),
    );
    expect(result).toMatchObject({ status: 'invalid', problem: { field: 'stops' } });
    expect(await w.inOrg((tx) => tx.select().from(mileageRoutes))).toEqual([]);
    expect(await w.inOrg((tx) => tx.select().from(expenses))).toEqual([]);
  });
});

describe('recording a measurement', () => {
  it('records each stop’s place and leg, the metres, the miles and the source, and claims those miles at the rate on the day', async () => {
    const w = await workspace('route-measured');
    const { expenseId: id, event } = await w.log();
    const stops = await w.inOrg((tx) => routeToMeasure(tx, id, event.outboxId));
    expect(stops).toEqual({ stops: toClient.stops, roundTrip: false, country: null });

    // 9,400 m + 52,400 m = 61,800 m, 38.4 mi
    expect(await w.record(id, event.outboxId, measured())).toEqual({
      status: 'measured',
      miles: '38.4',
    });
    const { route, mileage } = (await w.drive(id))!;
    expect(route).toMatchObject({
      status: 'measured',
      provider: 'openrouteservice',
      profile: 'driving-car',
      measuredAt: NOW,
      distanceMetres: 61_800,
      returnMetres: null,
      measuredMiles: '38.4',
      milesReason: null,
      problem: null,
    });
    expect(route.stops.map((s) => [s.label, s.longitude, s.legMetres])).toEqual([
      ['12 Elm Street, Omaha, NE, USA', '-95.934502', null],
      ['1520 Harney Street, Omaha, NE, USA', '-95.936117', 9_400],
      ['Eppley Airfield, Omaha, NE, USA', '-95.894069', 52_400],
    ]);
    expect(mileage.miles).toBe('38.4');
    // 38.4 mi × $0.725
    expect(await w.expense(id)).toMatchObject({ status: 'ready', amountMinor: 2784 });
    expect((await w.audit(id)).at(-1)).toMatchObject({
      action: 'expense.route_measured',
      payload: { provider: 'openrouteservice', distanceMetres: 61_800, miles: '38.4' },
    });
    // Measured once: the request is spent.
    expect(await w.inOrg((tx) => routeToMeasure(tx, id, event.outboxId))).toBeUndefined();
    expect(await w.record(id, event.outboxId, measured())).toEqual({ status: 'stale' });
  });

  it('measures a round trip back to its start, and looks addresses up in the organization’s country', async () => {
    const w = await workspace('route-round');
    await w.inOrg((tx) => tx.update(organizations).set({ country: 'US' }));
    const { expenseId: id, event } = await w.log({ roundTrip: true });
    expect(await w.inOrg((tx) => routeToMeasure(tx, id, event.outboxId))).toMatchObject({
      roundTrip: true,
      country: 'US',
    });
    expect(await w.record(id, event.outboxId, measured([9_400, 52_400, 60_000]))).toEqual({
      status: 'measured',
      // 121,800 m is 75.68 mi
      miles: '75.68',
    });
    expect((await w.drive(id))?.route).toMatchObject({
      distanceMetres: 121_800,
      returnMetres: 60_000,
    });
  });

  it('keeps the distance it was measured at and its source when the rates change later, and never measures it again on its own', async () => {
    const w = await workspace('route-snapshot');
    const { expenseId: id, event } = await w.log();
    await w.record(id, event.outboxId, measured());
    const later: MileageRateTable = {
      rates: [
        mileageRate({
          currency: 'USD',
          perUnit: '0.90',
          unit: 'mi',
          effectiveFrom: '2026-01-01',
          source: 'org-policy',
        }),
      ],
      through: '2026-12-31',
    };
    expect(await w.record(id, event.outboxId, measured([1, 1]), later)).toEqual({
      status: 'stale',
    });
    expect(await w.change(id, { purpose: 'Acme onsite' })).toMatchObject({
      status: 'changed',
      remeasured: false,
      event: null,
    });
    expect(await w.change(id, { stops: [...toClient.stops!] })).toEqual({ status: 'unchanged' });
    const { route } = (await w.drive(id))!;
    expect(route).toMatchObject({ status: 'measured', distanceMetres: 61_800, measuredAt: NOW });
    expect((await w.expense(id))?.amountMinor).toBe(2784);
  });

  it('asks for a look, with the reason, when a stop can’t be found, the route is too long or measures nothing', async () => {
    const w = await workspace('route-failed');
    const { expenseId: id, event } = await w.log();
    const problem = 'We couldn’t find “Acme HQ, 1520 Harney St, Omaha” on the map.';
    expect(await w.record(id, event.outboxId, { kind: 'failed', problem })).toEqual({
      status: 'failed',
      problem,
    });
    expect((await w.drive(id))?.route).toMatchObject({ status: 'failed', problem });
    expect(await w.expense(id)).toMatchObject({ status: 'needs_review', amountMinor: null });
    expect((await w.audit(id)).at(-1)).toMatchObject({
      action: 'expense.route_not_measured',
      payload: { problem },
    });

    const far = await w.log();
    const tooFar = await w.record(far.expenseId, far.event.outboxId, measured([9_400, 1_700_000]));
    expect(tooFar.status).toBe('failed');
    expect(tooFar.status === 'failed' && tooFar.problem).toMatch(
      /^The route measures 1062\.17 miles\. One entry claims at most 1000/,
    );
    const nowhere = await w.log();
    const same = await w.record(nowhere.expenseId, nowhere.event.outboxId, measured([0, 0]));
    expect(same.status === 'failed' && same.problem).toMatch(/same place/);
    expect((await w.drive(nowhere.expenseId))?.route.stops[1]?.label).toBe(
      '1520 Harney Street, Omaha, NE, USA',
    );
  });
});

describe('changing a route drive before it is submitted', () => {
  it('measures it again when its stops change, and never records the measurement asked for before', async () => {
    const w = await workspace('route-remeasure');
    const { expenseId: id, event: first } = await w.log();
    await w.record(id, first.outboxId, measured());
    const changed = await w.change(id, {
      stops: ['12 Elm St, Omaha, NE', 'Eppley Airfield, Omaha'],
    });
    expect(changed).toMatchObject({ status: 'changed', remeasured: true });
    if (changed.status !== 'changed' || !changed.event) throw new Error('not measured again');
    expect(await w.expense(id)).toMatchObject({ status: 'processing', amountMinor: null });
    expect((await w.drive(id))?.route).toMatchObject({
      status: 'measuring',
      requestId: changed.event.outboxId,
      distanceMetres: null,
      stops: [{ address: '12 Elm St, Omaha, NE' }, { address: 'Eppley Airfield, Omaha' }],
    });
    expect(await w.record(id, first.outboxId, measured())).toEqual({ status: 'stale' });
  });

  it('prices the miles claimed again at the rate on its new date, and measures a drive that couldn’t be measured again on request', async () => {
    const w = await workspace('route-date');
    const { expenseId: id, event } = await w.log();
    await w.record(id, event.outboxId, measured());
    expect(await w.change(id, { date: '2025-12-30' })).toMatchObject({ remeasured: false });
    // 38.4 mi × $0.70
    expect((await w.expense(id))?.amountMinor).toBe(2688);
    expect((await w.drive(id))?.mileage.rate.perUnit).toBe('0.7000');

    const failed = await w.log();
    await w.record(failed.expenseId, failed.event.outboxId, { kind: 'failed', problem: 'No key.' });
    const again = await w.change(failed.expenseId, { stops: [...toClient.stops!] });
    expect(again).toMatchObject({ status: 'changed', remeasured: true });
    expect((await w.drive(failed.expenseId))?.route).toMatchObject({
      status: 'measuring',
      problem: null,
    });
  });

  it('claims other miles only with a reason, keeps the miles measured, and claims those again with none', async () => {
    const w = await workspace('route-claim');
    const { expenseId: id, event } = await w.log();
    expect(await w.claim(id, { miles: '40', reason: 'detour' })).toEqual({ status: 'measuring' });
    await w.record(id, event.outboxId, measured());

    expect(await w.claim(id, { miles: '41' })).toMatchObject({
      status: 'invalid',
      problem: { field: 'reason' },
    });
    expect(await w.claim(id, { miles: '41', reason: 'Road closed at the bridge' })).toEqual({
      status: 'claimed',
      miles: '41',
      reason: 'Road closed at the bridge',
    });
    // 41 mi × $0.725 = $29.725
    expect(await w.expense(id)).toMatchObject({ status: 'ready', amountMinor: 2973 });
    expect((await w.drive(id))?.route).toMatchObject({
      measuredMiles: '38.4',
      distanceMetres: 61_800,
      milesReason: 'Road closed at the bridge',
    });
    expect((await w.audit(id)).at(-1)).toMatchObject({
      action: 'expense.edited',
      payload: {
        method: 'route',
        changes: [{ field: 'miles', from: '38.4', to: '41' }],
        reason: 'Road closed at the bridge',
        measuredMiles: '38.4',
        amountMinor: 2973,
        previousAmountMinor: 2784,
      },
    });
    expect(await w.claim(id, { miles: '38.4' })).toEqual({
      status: 'claimed',
      miles: '38.4',
      reason: null,
    });
    expect(await w.claim(id, { miles: '38.40' })).toEqual({ status: 'unchanged' });
  });

  it('takes miles entered by hand, with a reason, for a drive that couldn’t be measured', async () => {
    const w = await workspace('route-by-hand');
    const { expenseId: id, event } = await w.log();
    await w.record(id, event.outboxId, { kind: 'failed', problem: 'A stop can’t be found.' });
    expect(await w.claim(id, { miles: '12.5' })).toMatchObject({ status: 'invalid' });
    expect(await w.claim(id, { miles: '12.5', reason: 'From the odometer' })).toMatchObject({
      status: 'claimed',
    });
    expect(await w.expense(id)).toMatchObject({ status: 'ready', amountMinor: 906 });
    expect((await w.drive(id))?.route).toMatchObject({
      status: 'failed',
      milesReason: 'From the odometer',
    });
  });

  it('refuses a change once it is submitted, and a change as a drive logged by hand', async () => {
    const w = await workspace('route-locked');
    const { expenseId: id, event } = await w.log();
    await w.record(id, event.outboxId, measured());
    expect(
      await w.inOrg((tx) =>
        editMileage(tx, w.org.orgId, w.org.memberId, id, { miles: '50' }, w.org.userId, TODAY),
      ),
    ).toEqual({ status: 'route' });
    for (const status of ['submitted', 'approved'] as const) {
      await w.inOrg((tx) => tx.update(expenses).set({ status }).where(eq(expenses.id, id)));
      expect(await w.change(id, { stops: ['A', 'B'] })).toEqual({
        status: 'not_editable',
        current: status,
      });
      expect(await w.claim(id, { miles: '50', reason: 'x' })).toEqual({
        status: 'not_editable',
        current: status,
      });
    }
    expect((await w.expense(id))?.amountMinor).toBe(2784);
  });
});

describe('the route tables’ own rules', () => {
  it('holds a measurement whole, a failure to its reason, and each stop’s place and leg together', async () => {
    const w = await workspace('route-constraints');
    const { expenseId: id } = await w.log();
    await expectDbError(
      w.inOrg((tx) =>
        tx.update(mileageRoutes).set({ status: 'measured' }).where(eq(mileageRoutes.expenseId, id)),
      ),
      /mileage_routes_measured_whole/,
    );
    await expectDbError(
      w.inOrg((tx) =>
        tx.update(mileageRoutes).set({ status: 'failed' }).where(eq(mileageRoutes.expenseId, id)),
      ),
      /mileage_routes_problem_when_failed/,
    );
    await expectDbError(
      w.inOrg((tx) =>
        tx
          .update(mileageRouteStops)
          .set({ label: 'Somewhere' })
          .where(eq(mileageRouteStops.expenseId, id)),
      ),
      /mileage_route_stops_place_whole/,
    );
    await expectDbError(
      w.inOrg((tx) =>
        tx
          .update(mileageRouteStops)
          .set({ legMetres: 10 })
          .where(and(eq(mileageRouteStops.expenseId, id), eq(mileageRouteStops.position, 0))),
      ),
      /mileage_route_stops_leg/,
    );
    await expectDbError(
      w.inOrg((tx) =>
        tx.insert(mileageRouteStops).values({
          orgId: w.org.orgId,
          expenseId: id,
          position: 25,
          address: 'One too many',
        }),
      ),
      /mileage_route_stops_position_range/,
    );
  });
});

describe('a member’s route drives and places are their own', () => {
  it('shows a member only their own route drives and stops, and refuses a change to anyone else’s', async () => {
    const w = await workspace('route-members');
    const jordan = await w.colleague();
    const theirs = await w.log({}, jordan);
    const mine = await w.log();

    const seen = await w.as(jordan, (tx) => tx.select().from(mileageRoutes));
    expect(seen.map((r) => r.expenseId)).toEqual([theirs.expenseId]);
    expect(
      (await w.as(jordan, (tx) => tx.select().from(mileageRouteStops))).every(
        (s) => s.expenseId === theirs.expenseId,
      ),
    ).toBe(true);
    expect(await w.drive(mine.expenseId, jordan)).toBeUndefined();
    // The owner sees Jordan's, but changes only their own (ADR-0035).
    expect(await w.drive(theirs.expenseId)).toBeUndefined();
    expect(await w.as(w.owner, (tx) => tx.select().from(mileageRoutes))).toHaveLength(2);
    await expectDbError(
      w.as(w.owner, (tx) =>
        tx
          .update(mileageRoutes)
          .set({ roundTrip: true })
          .where(eq(mileageRoutes.expenseId, theirs.expenseId)),
      ),
      /own_records/,
    );
    await expectDbError(
      w.as(w.owner, (tx) =>
        tx.delete(mileageRouteStops).where(eq(mileageRouteStops.expenseId, theirs.expenseId)),
      ),
      /own_records/,
    );
  });

  it('keeps each member’s saved places to them, by name once, and the trail without their addresses', async () => {
    const w = await workspace('route-places');
    const jordan = await w.colleague();
    const save = (who: Who, id: string | null, input: { name?: string; address?: string }) =>
      w.as(who, (tx) => savePlace(tx, w.org.orgId, who.memberId, id, input, w.org.userId));

    const home = await save(w.owner, null, { name: 'Home', address: '12 Elm St, Omaha, NE' });
    if (home.status !== 'saved') throw new Error('not saved');
    expect(await save(w.owner, null, { name: 'home', address: 'Elsewhere' })).toEqual({
      status: 'taken',
    });
    await save(w.owner, null, { name: 'Office', address: '1520 Harney St, Omaha' });
    await save(jordan, null, { name: 'Home', address: '9 Pine Rd, Lincoln, NE' });
    expect(
      (await w.as(w.owner, (tx) => listSavedPlaces(tx, w.org.memberId))).map((p) => p.name),
    ).toEqual(['Home', 'Office']);
    expect(await w.as(jordan, (tx) => tx.select().from(savedPlaces))).toHaveLength(1);
    expect(await save(jordan, home.place.id, { address: 'Mine now' })).toEqual({
      status: 'missing',
    });
    await expectDbError(
      w.as(jordan, (tx) =>
        tx.insert(savedPlaces).values({
          orgId: w.org.orgId,
          memberId: w.org.memberId,
          name: 'Planted',
          address: 'x',
        }),
      ),
      /own_records/,
    );

    expect(await save(w.owner, home.place.id, { address: '14 Oak Ave, Omaha' })).toMatchObject({
      status: 'saved',
      place: { name: 'Home', address: '14 Oak Ave, Omaha' },
    });
    expect(
      await w.as(w.owner, (tx) =>
        removePlace(tx, w.org.orgId, w.org.memberId, home.place.id, w.org.userId),
      ),
    ).toBe(true);
    const trail = await w.audit(home.place.id);
    expect(trail.map((e) => e.action)).toEqual([
      'saved_place.added',
      'saved_place.changed',
      'saved_place.removed',
    ]);
    expect(JSON.stringify(trail)).not.toMatch(/Elm|Oak/);
  });

  it('keeps route drives, places and keys inside their organization', async () => {
    const w = await workspace('route-tenant-a');
    const other = await workspace('route-tenant-b');
    await w.log();
    await w.as(w.owner, (tx) =>
      savePlace(tx, w.org.orgId, w.org.memberId, null, { name: 'Home', address: 'x' }, 'u'),
    );
    await w.inOrg((tx) =>
      saveRouteKey(
        tx,
        w.org.orgId,
        {
          provider: 'openrouteservice',
          ciphertext: 'v1.sealed',
          keyHint: 'wxyz',
          verifiedAt: NOW,
          memberId: w.org.memberId,
        },
        w.org.userId,
      ),
    );
    for (const table of [mileageRoutes, mileageRouteStops, savedPlaces, routeServiceKeys]) {
      expect(await other.inOrg((tx) => tx.select().from(table))).toEqual([]);
    }
  });
});

describe('the organization’s route key (Q31)', () => {
  it('keeps one key per provider as ciphertext and its last four characters, replaced or removed with its audit event', async () => {
    const w = await workspace('route-key');
    const write = (keyHint: string) =>
      w.inOrg((tx) =>
        saveRouteKey(
          tx,
          w.org.orgId,
          {
            provider: 'openrouteservice',
            ciphertext: `v1.sealed-${keyHint}`,
            keyHint,
            verifiedAt: NOW,
            memberId: w.org.memberId,
          },
          w.org.userId,
        ),
      );
    await write('abcd');
    expect(await write('wxyz')).toMatchObject({ keyHint: 'wxyz', ciphertext: 'v1.sealed-wxyz' });
    expect(await w.inOrg((tx) => tx.select().from(routeServiceKeys))).toHaveLength(1);
    expect(await w.inOrg((tx) => getRouteKey(tx, 'openrouteservice'))).toMatchObject({
      keyHint: 'wxyz',
      verifiedAt: NOW,
    });
    await expectDbError(
      w.inOrg((tx) => tx.update(routeServiceKeys).set({ keyHint: 'toolong' })),
      /route_service_keys_hint_short/,
    );
    expect(
      await w.inOrg((tx) => deleteRouteKey(tx, w.org.orgId, 'openrouteservice', w.org.userId)),
    ).toBe(true);
    expect(
      await w.inOrg((tx) => deleteRouteKey(tx, w.org.orgId, 'openrouteservice', w.org.userId)),
    ).toBe(false);
    const trail = await w.audit('openrouteservice');
    expect(trail.map((e) => e.action)).toEqual([
      'route_service_key.saved',
      'route_service_key.saved',
      'route_service_key.removed',
    ]);
    expect(JSON.stringify(trail)).not.toMatch(/sealed/);
  });
});
