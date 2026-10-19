import {
  applySavedRouteInput,
  newId,
  sameSavedRoute,
  type RouteProblem,
  type RouteStopInput,
  type SavedRouteValues,
  type StopPin,
} from '@expensewise/domain';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { appendAuditEvent } from './audit.ts';
import type { Transaction } from './client.ts';
import { savedRoutes, savedRouteStops } from './schema.ts';

/*
 * Saved routes (FR-CAP-16, #110): a member's own routes to log drives from, each a name, its
 * stops, the places picked for them and whether it is a round trip. A drive logged from one
 * copies them; a route changed or removed later never touches a drive.
 */

/** A saved route, its stops in order. */
export interface SavedRoute {
  readonly id: string;
  readonly name: string;
  readonly roundTrip: boolean;
  readonly stops: readonly { readonly address: string; readonly pin: StopPin | null }[];
}

const valuesOf = (route: SavedRoute): SavedRouteValues => {
  const pins = route.stops.map((s) => s.pin);
  return {
    name: route.name,
    stops: route.stops.map((s) => s.address),
    ...(pins.some((p) => p !== null) ? { pins } : {}),
    roundTrip: route.roundTrip,
  };
};

/** A member's saved routes, by name, each with its stops. Call inside withOrg(). */
export async function listSavedRoutes(tx: Transaction, memberId: string): Promise<SavedRoute[]> {
  const routes = await tx
    .select({ id: savedRoutes.id, name: savedRoutes.name, roundTrip: savedRoutes.roundTrip })
    .from(savedRoutes)
    .where(eq(savedRoutes.memberId, memberId))
    .orderBy(asc(sql`lower(${savedRoutes.name})`), asc(savedRoutes.id));
  if (routes.length === 0) return [];
  const stops = await tx
    .select({
      routeId: savedRouteStops.routeId,
      address: savedRouteStops.address,
      label: savedRouteStops.label,
      longitude: savedRouteStops.longitude,
      latitude: savedRouteStops.latitude,
    })
    .from(savedRouteStops)
    .where(
      inArray(
        savedRouteStops.routeId,
        routes.map((r) => r.id),
      ),
    )
    .orderBy(asc(savedRouteStops.position));
  return routes.map((route) => ({
    ...route,
    stops: stops
      .filter((s) => s.routeId === route.id)
      .map((s) => ({
        address: s.address,
        pin:
          s.label !== null && s.longitude !== null && s.latitude !== null
            ? { label: s.label, longitude: s.longitude, latitude: s.latitude }
            : null,
      })),
  }));
}

export type SaveRouteResult =
  | { readonly status: 'saved'; readonly route: SavedRoute }
  | { readonly status: 'unchanged'; readonly route: SavedRoute }
  | { readonly status: 'invalid'; readonly problem: RouteProblem }
  /** The member already keeps a route of that name. */
  | { readonly status: 'taken' }
  | { readonly status: 'missing' };

const entity = (id: string) => ({ entityType: 'saved_route', entityId: id });

const stopRows = (orgId: string, memberId: string, routeId: string, values: SavedRouteValues) =>
  values.stops.map((address, position) => {
    const pin = values.pins?.[position];
    return { orgId, memberId, routeId, position, address, ...(pin ? pin : {}) };
  });

const routeOf = (id: string, values: SavedRouteValues): SavedRoute => ({
  id,
  name: values.name,
  roundTrip: values.roundTrip,
  stops: values.stops.map((address, i) => ({ address, pin: values.pins?.[i] ?? null })),
});

/**
 * Saves a new route for a member (routeId null), or changes one of theirs, with its audit
 * event. The trail records the route's name, how many stops it has and whether they changed,
 * never the addresses, as for saved places. Call inside withOrg(), as the member.
 */
export async function saveRoute(
  tx: Transaction,
  orgId: string,
  memberId: string,
  routeId: string | null,
  input: {
    readonly name?: string;
    readonly stops?: readonly RouteStopInput[];
    readonly roundTrip?: boolean;
  },
  actorUserId: string,
): Promise<SaveRouteResult> {
  let current: SavedRoute | undefined;
  if (routeId !== null) {
    const [locked] = await tx
      .select({ id: savedRoutes.id })
      .from(savedRoutes)
      .where(and(eq(savedRoutes.id, routeId), eq(savedRoutes.memberId, memberId)))
      .for('update');
    if (!locked) return { status: 'missing' };
    current = (await listSavedRoutes(tx, memberId)).find((r) => r.id === routeId);
    if (!current) return { status: 'missing' };
  }
  const before = current ? valuesOf(current) : null;
  const applied = applySavedRouteInput(before, input);
  if (!applied.ok) return { status: 'invalid', problem: applied.error };
  const values = applied.value;
  if (current && before && sameSavedRoute(before, values)) {
    return { status: 'unchanged', route: current };
  }
  const taken = await tx
    .select({ id: savedRoutes.id })
    .from(savedRoutes)
    .where(
      and(
        eq(savedRoutes.memberId, memberId),
        sql`lower(${savedRoutes.name}) = lower(${values.name})`,
      ),
    );
  if (taken.some((r) => r.id !== current?.id)) return { status: 'taken' };
  const actor = { type: 'user', id: actorUserId } as const;
  if (!current || !before) {
    const id = newId();
    await tx.insert(savedRoutes).values({
      id,
      orgId,
      memberId,
      name: values.name,
      roundTrip: values.roundTrip,
    });
    await tx.insert(savedRouteStops).values(stopRows(orgId, memberId, id, values));
    await appendAuditEvent(tx, orgId, {
      actor,
      ...entity(id),
      action: 'saved_route.added',
      payload: { name: values.name, stops: values.stops.length, roundTrip: values.roundTrip },
    });
    return { status: 'saved', route: routeOf(id, values) };
  }
  // The same stops and picks under the old name and round trip: only those changed.
  const stopsChanged = !sameSavedRoute(
    { ...before, name: values.name, roundTrip: values.roundTrip },
    values,
  );
  await tx
    .update(savedRoutes)
    .set({ name: values.name, roundTrip: values.roundTrip, updatedAt: new Date() })
    .where(eq(savedRoutes.id, current.id));
  if (stopsChanged) {
    await tx.delete(savedRouteStops).where(eq(savedRouteStops.routeId, current.id));
    await tx.insert(savedRouteStops).values(stopRows(orgId, memberId, current.id, values));
  }
  await appendAuditEvent(tx, orgId, {
    actor,
    ...entity(current.id),
    action: 'saved_route.changed',
    payload: {
      ...(before.name === values.name
        ? { name: values.name }
        : { name: { from: before.name, to: values.name } }),
      stops: values.stops.length,
      stopsChanged,
      roundTrip: values.roundTrip,
    },
  });
  return { status: 'saved', route: routeOf(current.id, values) };
}

/** Removes one of a member's routes and its stops, with its audit event. False when none. */
export async function removeRoute(
  tx: Transaction,
  orgId: string,
  memberId: string,
  routeId: string,
  actorUserId: string,
): Promise<boolean> {
  const removed = await tx
    .delete(savedRoutes)
    .where(and(eq(savedRoutes.id, routeId), eq(savedRoutes.memberId, memberId)))
    .returning({ name: savedRoutes.name });
  if (removed.length === 0) return false;
  await appendAuditEvent(tx, orgId, {
    actor: { type: 'user', id: actorUserId },
    ...entity(routeId),
    action: 'saved_route.removed',
    payload: { name: removed[0]!.name },
  });
  return true;
}
