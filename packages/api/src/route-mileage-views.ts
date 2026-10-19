import type { RecentPlace, SavedPlace, SavedRoute, StoredRouteKey } from '@expensewise/db';
import { ROUTE_ATTRIBUTION, sixPlaces, type StopPin } from '@expensewise/domain';
import { mileageEntry } from './mileage-views.ts';
import type { RouteDriveEntry, SuggestedPlace } from './route-mileage.ts';

/** Seals a place so a stop can be picked at it again; null while picks can't be sealed. */
export type PickSealer = (pin: StopPin) => string | null;

/**
 * A route drive (FR-CAP-04): the drive as one logged by hand shows, and its route: each stop
 * as typed and where it was found, how it was measured, the miles claimed and why they differ,
 * and the attribution OpenRouteService's terms ask for (ADR-0039). A stop picked from the
 * suggestions carries its pick, to send back with it and keep where it is measured from.
 */
export function routeDriveView(entry: RouteDriveEntry, sealPick: PickSealer) {
  const { route, expense, mileage } = entry;
  return {
    ...mileageEntry(entry),
    route: {
      status: route.status,
      problem: route.problem,
      name: route.name,
      roundTrip: route.roundTrip,
      stops: route.stops.map((s) => {
        const place =
          s.label === null || s.longitude === null || s.latitude === null
            ? null
            : { label: s.label, longitude: s.longitude, latitude: s.latitude };
        return {
          address: s.address,
          place,
          pinned: s.pinned && place !== null,
          pick: s.pinned && place ? sealPick(place) : null,
          legMetres: s.legMetres,
        };
      }),
      returnMetres: route.returnMetres,
      measured:
        route.status === 'measured' &&
        route.distanceMetres !== null &&
        route.measuredMiles !== null &&
        route.provider !== null &&
        route.profile !== null &&
        route.measuredAt !== null
          ? {
              metres: route.distanceMetres,
              miles: route.measuredMiles,
              provider: route.provider,
              profile: route.profile,
              measuredAt: route.measuredAt.toISOString(),
            }
          : null,
      // Nothing is claimed until it is measured, or its miles are entered by hand.
      claimedMiles: expense.amountMinor === null ? null : mileage.miles,
      reason: route.milesReason,
      attribution: ROUTE_ATTRIBUTION,
    },
  };
}

export const placeView = (p: SavedPlace) => ({ id: p.id, name: p.name, address: p.address });

/** A saved route, each stop picked from the suggestions with its pick (FR-CAP-16). */
export const savedRouteView = (route: SavedRoute, sealPick: PickSealer) => ({
  id: route.id,
  name: route.name,
  roundTrip: route.roundTrip,
  stops: route.stops.map((s) => ({
    address: s.address,
    place: s.pin,
    pick: s.pin ? sealPick(s.pin) : null,
  })),
});

/** A place suggested for a stop, with its pick (FR-CAP-14). */
export function suggestionView(place: SuggestedPlace, pick: string) {
  return {
    name: place.name,
    detail: place.detail,
    address: place.address,
    label: place.label,
    longitude: sixPlaces(place.longitude),
    latitude: sixPlaces(place.latitude),
    pick,
  };
}

/** A place the member drove to, with its pick to measure a new stop from it (FR-CAP-14). */
export function recentPlaceView(place: RecentPlace, sealPick: PickSealer) {
  return {
    address: place.address,
    label: place.label,
    longitude: place.longitude,
    latitude: place.latitude,
    lastDriven: place.lastDriven,
    pick: sealPick(place),
  };
}

export function routeKeyStatus(stored: StoredRouteKey | undefined) {
  return {
    provider: 'openrouteservice' as const,
    configured: stored !== undefined,
    keyHint: stored?.keyHint ?? null,
    verifiedAt: stored?.verifiedAt?.toISOString() ?? null,
    updatedAt: stored?.updatedAt.toISOString() ?? null,
  };
}
