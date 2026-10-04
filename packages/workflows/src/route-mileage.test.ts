import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { InngestTestEngine } from '@inngest/test';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createWorkflowClient } from './functions.ts';
import {
  openRouteService,
  RouteServiceError,
  routeKeyVerifier,
  type RoutingClient,
} from './openrouteservice.ts';
import {
  failureProblem,
  measureRoute,
  ROUTE_MEASURE_RETRIES,
  ROUTE_PROBLEMS,
  routeMeasuringFunction,
  type MeasuredOutcome,
  type RouteMeasuringPorts,
  type RouteRequest,
} from './route-mileage.ts';

const KEY = 'ors-test-key-0000-wxyz';
const ORG = '0192f7a0-0000-7000-8000-0000000000a1';
const DRIVE = '0192f7a0-0000-7000-8000-0000000000d1';
const REQUEST = '0192f7a0-0000-7000-8000-0000000000e1';
const NOW = new Date('2026-10-04T15:00:00.000Z');

/** Places the stand-in knows, by the address as typed: longitude, latitude, label. */
const PLACES: Record<string, [number, number, string]> = {
  '12 Elm St, Omaha, NE': [-95.9345021, 41.2565369, '12 Elm Street, Omaha, NE, USA'],
  'Acme HQ, 1520 Harney St': [-95.9361172, 41.2571634, '1520 Harney Street, Omaha, NE, USA'],
  'Eppley Airfield': [-95.894069, 41.303166, 'Eppley Airfield, Omaha, NE, USA'],
  'Middle of the lake': [-95.8, 41.4, 'Lake Manawa, IA, USA'],
};
const pointKey = (p: readonly unknown[]) => p.slice(0, 2).join(',');
/** The driving distance of each leg the stand-in knows, in metres as OpenRouteService gives. */
const LEGS: Record<string, number> = {
  [`${pointKey(PLACES['12 Elm St, Omaha, NE']!)}>${pointKey(PLACES['Acme HQ, 1520 Harney St']!)}`]: 9400.4,
  [`${pointKey(PLACES['Acme HQ, 1520 Harney St']!)}>${pointKey(PLACES['Eppley Airfield']!)}`]: 52399.5,
  [`${pointKey(PLACES['Eppley Airfield']!)}>${pointKey(PLACES['12 Elm St, Omaha, NE']!)}`]: 60000,
};

interface Seen {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | undefined;
  readonly body: unknown;
}

/**
 * A stand-in for OpenRouteService over HTTP: Pelias search, the driving-car directions, and
 * its answers to a refused key, a used-up allowance and a failure on its side. Tests never
 * call the real service.
 */
const fake = {
  mode: 'ok' as 'ok' | 'limited' | 'down',
  seen: [] as Seen[],
  url: '',
};
const server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    const url = new URL(req.url ?? '/', 'http://fake');
    const text = Buffer.concat(chunks).toString('utf8');
    const body = text ? (JSON.parse(text) as { coordinates?: number[][] }) : undefined;
    fake.seen.push({
      method: req.method ?? '',
      url: req.url ?? '',
      authorization: req.headers.authorization,
      body,
    });
    const answer = (status: number, json: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(json));
    };
    if (req.headers.authorization !== KEY) {
      return answer(403, { error: 'Access to this API has been disallowed' });
    }
    if (fake.mode === 'limited') return answer(429, { error: 'Rate limit exceeded' });
    if (fake.mode === 'down') return answer(503, { error: 'Service unavailable' });
    if (url.pathname === '/geocode/search') {
      const found = PLACES[url.searchParams.get('text') ?? ''];
      return answer(200, {
        type: 'FeatureCollection',
        features: found
          ? [
              {
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [found[0], found[1]] },
                properties: { label: found[2], confidence: 1 },
              },
            ]
          : [],
      });
    }
    if (url.pathname === '/v2/directions/driving-car' && req.method === 'GET') {
      return answer(200, { type: 'FeatureCollection', features: [] });
    }
    if (url.pathname === '/v2/directions/driving-car' && req.method === 'POST') {
      const points = body?.coordinates ?? [];
      const segments = [];
      for (let i = 1; i < points.length; i++) {
        const leg = LEGS[`${pointKey(points[i - 1]!)}>${pointKey(points[i]!)}`];
        if (leg === undefined) {
          return answer(404, {
            error: {
              code: 2010,
              message: `Could not find routable point within a radius of 350.0 meters of specified coordinate ${i}: ${pointKey(points[i]!)}.`,
            },
          });
        }
        segments.push({ distance: leg, duration: leg / 15, steps: [] });
      }
      const distance = segments.reduce((sum, s) => sum + s.distance, 0);
      return answer(200, { routes: [{ summary: { distance }, segments }] });
    }
    return answer(404, { error: 'Not found' });
  });
});

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
beforeEach(() => {
  fake.mode = 'ok';
  fake.seen = [];
});

const request: RouteRequest = { orgId: ORG, expenseId: DRIVE, requestId: REQUEST };
const STOPS = ['12 Elm St, Omaha, NE', 'Acme HQ, 1520 Harney St', 'Eppley Airfield'];

/** Measuring with the stand-in, and the drive and its outcomes in memory. */
function world(
  drive: { stops?: string[]; roundTrip?: boolean; country?: string | null } | null = {},
  /** key: the organization's key, or 'no_key' or 'unreadable_key' for why there is none. */
  options: { key?: string; enabled?: boolean } = {},
) {
  const settled: MeasuredOutcome[] = [];
  const ports: RouteMeasuringPorts = {
    load: () =>
      Promise.resolve(
        drive === null
          ? undefined
          : {
              stops: drive.stops ?? STOPS,
              roundTrip: drive.roundTrip ?? false,
              country: drive.country ?? null,
            },
      ),
    enabled: () => Promise.resolve(options.enabled ?? true),
    client: () => {
      const key = options.key ?? KEY;
      return Promise.resolve(
        key === 'no_key' || key === 'unreadable_key'
          ? key
          : (openRouteService(key, { baseUrl: fake.url }) satisfies RoutingClient),
      );
    },
    settle: (_request, outcome) => {
      settled.push(outcome);
      return Promise.resolve(
        outcome.kind === 'measured'
          ? { status: 'measured', miles: 'x' }
          : { status: 'failed', problem: outcome.problem },
      );
    },
    now: () => NOW,
  };
  return { ports, settled };
}

describe('OpenRouteService over HTTP (ADR-0039)', () => {
  it('sends each address as typed, with the key in a header and never in the address, narrowed to the country', async () => {
    const ors = openRouteService(KEY, { baseUrl: fake.url });
    expect(await ors.find('12 Elm St, Omaha, NE', 'US')).toEqual({
      label: '12 Elm Street, Omaha, NE, USA',
      longitude: -95.9345021,
      latitude: 41.2565369,
    });
    expect(await ors.find('Nowhere in particular', null)).toBeNull();
    const [search, plain] = fake.seen;
    expect(search?.authorization).toBe(KEY);
    expect(new URL(search!.url, 'http://x').searchParams.toString()).toBe(
      'text=12+Elm+St%2C+Omaha%2C+NE&size=1&boundary.country=US',
    );
    expect(plain?.url).not.toMatch(/boundary/);
    expect(fake.seen.every((s) => !s.url.includes(KEY))).toBe(true);
  });

  it('measures every leg through the points in order, by car', async () => {
    const ors = openRouteService(KEY, { baseUrl: fake.url });
    const points = STOPS.map((s) => [PLACES[s]![0], PLACES[s]![1]] as const);
    expect(await ors.route(points)).toEqual([9400.4, 52399.5]);
    expect(fake.seen[0]).toMatchObject({
      method: 'POST',
      url: '/v2/directions/driving-car',
      body: { coordinates: points.map((p) => [...p]), instructions: true, geometry: false },
    });
  });

  it('checks a key with one short route, and says how OpenRouteService answered', async () => {
    const check = routeKeyVerifier({ baseUrl: fake.url });
    expect(await check(KEY)).toEqual({ ok: true });
    expect(fake.seen).toHaveLength(1);
    expect(fake.seen[0]?.url).toMatch(/^\/v2\/directions\/driving-car\?start=/);
    expect(await check('ors-wrong-key-1234')).toEqual({
      ok: false,
      reason: 'rejected',
      status: 403,
      detail: 'OpenRouteService answered 403: Access to this API has been disallowed',
    });
    fake.mode = 'limited';
    expect(await check(KEY)).toMatchObject({ ok: false, reason: 'limited', status: 429 });
    fake.mode = 'down';
    expect(await check(KEY)).toMatchObject({ ok: false, reason: 'unreachable', status: 503 });
    const nowhere = await routeKeyVerifier({ baseUrl: 'http://127.0.0.1:1' })(KEY);
    expect(nowhere).toMatchObject({ ok: false, reason: 'unreachable' });
    expect(!nowhere.ok && nowhere.detail).toMatch(/^No answer from OpenRouteService/);
  });
});

describe('measuring a route drive (FR-CAP-04)', () => {
  it('finds each stop and measures the route, in whole metres, with the source and when', async () => {
    const w = world();
    expect(await measureRoute(w.ports, request)).toEqual({
      kind: 'measured',
      provider: 'openrouteservice',
      profile: 'driving-car',
      places: [
        { label: '12 Elm Street, Omaha, NE, USA', longitude: '-95.934502', latitude: '41.256537' },
        {
          label: '1520 Harney Street, Omaha, NE, USA',
          longitude: '-95.936117',
          latitude: '41.257163',
        },
        {
          label: 'Eppley Airfield, Omaha, NE, USA',
          longitude: '-95.894069',
          latitude: '41.303166',
        },
      ],
      // 9,400.4 m and 52,399.5 m, each to the whole metre, half up
      legs: [9400, 52400],
      measuredAt: NOW.toISOString(),
    });
    // Three searches, each for an address as typed, then one route: nothing else is sent.
    expect(fake.seen.map((s) => s.method)).toEqual(['GET', 'GET', 'GET', 'POST']);
    const sent = fake.seen.map(
      (s) => `${decodeURIComponent(s.url)} ${JSON.stringify(s.body ?? '')}`,
    );
    expect(sent.join(' ')).not.toMatch(/Acme onsite|Home|purpose/);
  });

  it('measures a round trip back to its start', async () => {
    const w = world({ stops: [STOPS[0]!, STOPS[1]!, STOPS[2]!], roundTrip: true });
    const measured = await measureRoute(w.ports, request);
    expect(measured).toMatchObject({ kind: 'measured', legs: [9400, 52400, 60000] });
    const route = fake.seen.at(-1)?.body as { coordinates: number[][] };
    expect(route.coordinates).toHaveLength(4);
    expect(route.coordinates[3]).toEqual(route.coordinates[0]);
  });

  it('asks for a look, naming the stop, when a stop can’t be found or has no road near it', async () => {
    const missing = await measureRoute(
      world({ stops: [STOPS[0]!, '1 Nowhere Lane', STOPS[2]!] }).ports,
      request,
    );
    expect(missing).toEqual({
      kind: 'failed',
      problem:
        'OpenRouteService couldn’t find stop 2, “1 Nowhere Lane”, on the map. Check its address. Then measure the drive again, or enter its miles by hand.',
    });
    const lake = await measureRoute(
      world({ stops: [STOPS[0]!, 'Middle of the lake'] }).ports,
      request,
    );
    expect(lake).toEqual({
      kind: 'failed',
      problem:
        'OpenRouteService found no road near the end. Check its address. Then measure the drive again, or enter its miles by hand.',
    });
  });

  it('asks for a look without trying again when the key is refused, missing or unreadable, or route mileage is off', async () => {
    expect(await measureRoute(world({}, { key: 'ors-revoked-key-1' }).ports, request)).toEqual({
      kind: 'failed',
      problem: ROUTE_PROBLEMS.rejected,
    });
    expect(fake.seen).toHaveLength(1);
    expect(await measureRoute(world({}, { key: 'no_key' }).ports, request)).toEqual({
      kind: 'failed',
      problem: ROUTE_PROBLEMS.no_key,
    });
    expect(ROUTE_PROBLEMS.no_key).toMatch(/Settings › Mileage/);
    expect(await measureRoute(world({}, { key: 'unreadable_key' }).ports, request)).toMatchObject({
      problem: ROUTE_PROBLEMS.unreadable_key,
    });
    expect(await measureRoute(world({}, { enabled: false }).ports, request)).toMatchObject({
      problem: ROUTE_PROBLEMS.off,
    });
    expect(fake.seen).toHaveLength(1);
  });

  it('tries again when OpenRouteService’s allowance is used up or it is failing, then asks for a look', async () => {
    fake.mode = 'limited';
    const limited = await measureRoute(world().ports, request).catch((e: unknown) => e);
    expect(limited).toBeInstanceOf(RouteServiceError);
    expect(limited).toMatchObject({ kind: 'limited', status: 429 });
    expect(failureProblem(limited as Error)).toBe(ROUTE_PROBLEMS.limited);
    fake.mode = 'down';
    const down = await measureRoute(world().ports, request).catch((e: unknown) => e);
    expect(down).toMatchObject({ kind: 'unreachable', status: 503 });
    expect(failureProblem(down as Error)).toBe(ROUTE_PROBLEMS.unreachable);
    expect(failureProblem(undefined)).toBe(ROUTE_PROBLEMS.unreachable);
  });

  it('measures nothing for a request the drive no longer waits for', async () => {
    const w = world(null);
    expect(await measureRoute(w.ports, request)).toBe('stale');
    expect(fake.seen).toEqual([]);
  });
});

describe('the route-measuring workflow', () => {
  const client = createWorkflowClient();
  const event = {
    name: 'mileage.route_measure_requested',
    data: { orgId: ORG, expenseId: DRIVE, outboxId: REQUEST },
  };

  it('runs on each request to measure, one organization at a time, trying a busy service again', () => {
    const fn = routeMeasuringFunction(client, () => world().ports);
    expect(fn.opts.id).toBe('route-measuring');
    expect(fn.opts.triggers).toEqual([{ event: 'mileage.route_measure_requested' }]);
    expect(fn.opts.retries).toBe(ROUTE_MEASURE_RETRIES);
    expect(ROUTE_MEASURE_RETRIES).toBe(3);
    expect(fn.opts.concurrency).toEqual({ key: 'event.data.orgId', limit: 1 });
  });

  it('records the measurement for the request it was asked for', async () => {
    const w = world();
    const t = new InngestTestEngine({
      function: routeMeasuringFunction(client, () => w.ports),
      events: [event],
    });
    const { result, error } = await t.execute();
    expect(error).toBeUndefined();
    expect(result).toEqual({ status: 'measured', miles: 'x' });
    expect(w.settled).toMatchObject([{ kind: 'measured', legs: [9400, 52400] }]);
  });

  it('records why when the key is refused, in one run', async () => {
    const w = world({}, { key: 'ors-revoked-key-1' });
    const t = new InngestTestEngine({
      function: routeMeasuringFunction(client, () => w.ports),
      events: [event],
    });
    const { error } = await t.execute();
    expect(error).toBeUndefined();
    expect(w.settled).toEqual([{ kind: 'failed', problem: ROUTE_PROBLEMS.rejected }]);
  });

  it('fails the run for the runner to try again when the allowance is used up', async () => {
    fake.mode = 'limited';
    const w = world();
    const t = new InngestTestEngine({
      function: routeMeasuringFunction(client, () => w.ports),
      events: [event],
    });
    const { error } = await t.execute();
    expect(error).toMatchObject({ message: 'OpenRouteService answered 429: Rate limit exceeded' });
    expect(w.settled).toEqual([]);
  });
});
