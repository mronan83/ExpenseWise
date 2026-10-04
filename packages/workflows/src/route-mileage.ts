import {
  recordRouteMeasurement,
  ROUTE_MEASURE_REQUESTED,
  ROUTE_MILEAGE_FLAG,
  routeToMeasure,
  type Database,
  type RecordMeasurementResult,
  type RouteToMeasure,
} from '@expensewise/db';
import { ROUTE_PROFILE, routePoints, stopName, wholeMetres } from '@expensewise/domain';
import { NonRetriableError, type Inngest } from 'inngest';
import { featureSwitch } from './features.ts';
import {
  openRouteService,
  RouteServiceError,
  type OpenRouteServiceOptions,
  type RoutingClient,
} from './openrouteservice.ts';
import { checkedDatabase } from './receipt-ports.ts';
import type { KeyProblem } from './receipts.ts';

/*
 * Measuring a route drive (FR-CAP-04, ADR-0039). Saving the drive asks for it through the
 * outbox; this workflow finds each stop with OpenRouteService, routes by car through them in
 * order, back to the start on a round trip, and records the result for the request it was
 * asked for. A stop that can't be found, a missing or refused key, or no road leaves the drive
 * needing a look with the reason in plain words. A busy or used-up OpenRouteService is asked
 * again; once the tries run out, the drive needs a look too.
 */

/** How many times a busy or used-up OpenRouteService is asked again (R-ROUTE-RETRIES). */
export const ROUTE_MEASURE_RETRIES = 3;

/** One request to measure a drive, as the outbox event names it. */
export interface RouteRequest {
  readonly orgId: string;
  readonly expenseId: string;
  /** The outbox event's id: the drive records only the measuring it asked for last. */
  readonly requestId: string;
}

/** What came of measuring, as a step returns it: plain data, the time as text. */
export type MeasuredOutcome =
  | {
      readonly kind: 'measured';
      readonly provider: 'openrouteservice';
      readonly profile: string;
      readonly places: readonly { label: string; longitude: string; latitude: string }[];
      readonly legs: readonly number[];
      readonly measuredAt: string;
    }
  | { readonly kind: 'failed'; readonly problem: string };

/** What measuring needs from the database and the routing service. */
export interface RouteMeasuringPorts {
  /** The stops, while this request is still the one the drive waits for. */
  load(request: RouteRequest): Promise<RouteToMeasure | undefined>;
  /** Whether route mileage is on for the organization: the override first (ADR-0032). */
  enabled(orgId: string): Promise<boolean>;
  /** OpenRouteService with the organization's key, or why there is none. */
  client(orgId: string): Promise<RoutingClient | KeyProblem>;
  settle(request: RouteRequest, outcome: MeasuredOutcome): Promise<RecordMeasurementResult>;
  now?(): Date;
}

const ASK_AN_ADMIN = 'An owner or finance admin can do that in Settings › Mileage.';
const OR_BY_HAND = 'Then measure the drive again, or enter its miles by hand.';

/** Why a drive was not measured, in words its person can act on. */
export const ROUTE_PROBLEMS = {
  off: 'Route mileage was switched off for your organization before this drive was measured. Enter its miles by hand, or measure it again once route mileage is back on.',
  no_key: `Your organization has no OpenRouteService key yet. ${ASK_AN_ADMIN} ${OR_BY_HAND}`,
  unreadable_key: `Your organization’s OpenRouteService key can no longer be read, so it needs saving again. ${ASK_AN_ADMIN} ${OR_BY_HAND}`,
  rejected: `OpenRouteService refused your organization’s key. It may have been revoked; save a new one. ${ASK_AN_ADMIN} ${OR_BY_HAND}`,
  limited:
    'OpenRouteService says your organization’s key has used up its allowance for now, so the drive wasn’t measured. Measure it again later, or enter its miles by hand.',
  unreachable:
    'OpenRouteService could not be reached, so the drive wasn’t measured. Measure it again later, or enter its miles by hand.',
} as const;

/** "No road near the end", or the service's own words, for a route it could not make. */
function refusedProblem(error: RouteServiceError, stops: readonly string[]): string {
  const points = stops.length;
  // 2010: no road near a point; ORS names the point by its place in the request, from 0.
  if (error.code === 2010) {
    const at = /coordinate (\d+)/.exec(error.message);
    const index = at ? Number(at[1]) : undefined;
    const where = index === undefined ? 'one of the stops' : stopName(index % points, points);
    return `OpenRouteService found no road near ${where}. Check its address. ${OR_BY_HAND}`;
  }
  // 2004: longer than OpenRouteService routes in one request (6,000 km).
  if (error.code === 2004) {
    return `The route is longer than OpenRouteService measures at once. Log it in parts, or enter its miles by hand.`;
  }
  return `OpenRouteService couldn’t measure this drive (${error.message}). ${OR_BY_HAND}`;
}

/**
 * Measures one route drive: finds each stop, then routes through them in order. A stop not
 * found, a missing, unreadable or refused key, or a route that can't be made is an outcome to
 * record; a busy or used-up service throws, so the step is tried again. Never logs or returns
 * the key or the addresses.
 */
export async function measureRoute(
  ports: RouteMeasuringPorts,
  request: RouteRequest,
): Promise<MeasuredOutcome | 'stale'> {
  const drive = await ports.load(request);
  if (!drive) return 'stale';
  const failed = (problem: string): MeasuredOutcome => ({ kind: 'failed', problem });
  if (!(await ports.enabled(request.orgId))) return failed(ROUTE_PROBLEMS.off);
  const client = await ports.client(request.orgId);
  if (client === 'no_key' || client === 'unreadable_key') return failed(ROUTE_PROBLEMS[client]);
  try {
    const places = [];
    for (const [i, address] of drive.stops.entries()) {
      const place = await client.find(address, drive.country);
      if (!place) {
        return failed(
          `OpenRouteService couldn’t find ${stopName(i, drive.stops.length)}, “${address}”, on the map. Check its address. ${OR_BY_HAND}`,
        );
      }
      places.push(place);
    }
    const points = routePoints(places, drive.roundTrip).map(
      (p) => [p.longitude, p.latitude] as const,
    );
    const legs = await client.route(points);
    return {
      kind: 'measured',
      provider: 'openrouteservice',
      profile: ROUTE_PROFILE,
      places: places.map((p) => ({
        label: p.label.slice(0, 300),
        longitude: p.longitude.toFixed(6),
        latitude: p.latitude.toFixed(6),
      })),
      legs: legs.map(wholeMetres),
      measuredAt: (ports.now?.() ?? new Date()).toISOString(),
    };
  } catch (error) {
    if (error instanceof RouteServiceError) {
      if (error.kind === 'rejected') return failed(ROUTE_PROBLEMS.rejected);
      if (error.kind === 'refused') return failed(refusedProblem(error, drive.stops));
    }
    // Busy, used up or unreachable: thrown, so the workflow asks again.
    throw error;
  }
}

/** Why the last try failed, as the drive's reason, once the workflow stops trying. */
export function failureProblem(error: { readonly message?: unknown } | undefined): string {
  const message = typeof error?.message === 'string' ? error.message : '';
  return / answered 429\b/.test(message) ? ROUTE_PROBLEMS.limited : ROUTE_PROBLEMS.unreachable;
}

function requestOf(data: unknown): RouteRequest {
  const { orgId, expenseId, outboxId } = (data ?? {}) as Record<string, unknown>;
  if (typeof orgId !== 'string' || typeof expenseId !== 'string' || typeof outboxId !== 'string') {
    throw new NonRetriableError('The event names no orgId, expenseId and outboxId');
  }
  return { orgId, expenseId, requestId: outboxId };
}

/**
 * Measures a route drive when it is saved or its stops change. One organization's drives are
 * measured one at a time, well inside the free key's 40 routes a minute. A busy or used-up
 * OpenRouteService is asked again up to ROUTE_MEASURE_RETRIES times; after that, the drive
 * needs a look.
 */
export function routeMeasuringFunction(client: Inngest, ports: () => RouteMeasuringPorts) {
  return client.createFunction(
    {
      id: 'route-measuring',
      name: 'Measure a route drive',
      triggers: [{ event: ROUTE_MEASURE_REQUESTED }],
      concurrency: { key: 'event.data.orgId', limit: 1 },
      retries: ROUTE_MEASURE_RETRIES,
      onFailure: async ({ event, step }) => {
        const request = requestOf(event.data.event.data);
        const problem = failureProblem(event.data.error);
        await step.run('settle after failure', () =>
          ports().settle(request, { kind: 'failed', problem }),
        );
      },
    },
    async ({ event, step }) => {
      const request = requestOf(event.data);
      const outcome = await step.run('measure the route', () => measureRoute(ports(), request));
      if (outcome === 'stale') return { status: 'stale' as const };
      return step.run('record it', () => ports().settle(request, outcome as MeasuredOutcome));
    },
  );
}

export interface RouteMeasuringDeps {
  /** As expensewise_app: every read and write is scoped to the event's organization. */
  readonly db: Database;
  /** The organization's OpenRouteService key, decrypted (ADR-0039), or why there is none. */
  readonly routeKey: (orgId: string) => Promise<{ readonly key: string } | KeyProblem>;
  /** Where OpenRouteService is, and how to call it: the bench and the tests fake it. */
  readonly service?: OpenRouteServiceOptions;
  /** FLAG_OVERRIDES, read from the environment when not given. */
  readonly flagOverrides?: string;
}

/** Measuring on Postgres and OpenRouteService. */
export function routeMeasuringPorts(deps: RouteMeasuringDeps): RouteMeasuringPorts {
  const { inOrg } = checkedDatabase(deps.db);
  const switchOn = featureSwitch(inOrg, deps.flagOverrides ?? process.env.FLAG_OVERRIDES);
  return {
    load: ({ orgId, expenseId, requestId }) =>
      inOrg(orgId, (tx) => routeToMeasure(tx, expenseId, requestId)),
    enabled: (orgId) => switchOn(orgId, ROUTE_MILEAGE_FLAG),
    async client(orgId) {
      const stored = await deps.routeKey(orgId);
      if (stored === 'no_key' || stored === 'unreadable_key') return stored;
      return openRouteService(stored.key, deps.service);
    },
    settle: ({ orgId, expenseId, requestId }, outcome) =>
      inOrg(orgId, (tx) =>
        recordRouteMeasurement(
          tx,
          orgId,
          expenseId,
          requestId,
          outcome.kind === 'measured'
            ? { ...outcome, measuredAt: new Date(outcome.measuredAt) }
            : outcome,
        ),
      ),
  };
}
