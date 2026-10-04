import type { SavedPlace, StoredRouteKey } from '@expensewise/db';
import { ROUTE_ATTRIBUTION } from '@expensewise/domain';
import { mileageEntry } from './mileage-views.ts';
import type { RouteDriveEntry } from './route-mileage.ts';

/**
 * A route drive (FR-CAP-04): the drive as one logged by hand shows, and its route: each stop
 * as typed and where it was found, how it was measured, the miles claimed and why they differ,
 * and the attribution OpenRouteService's terms ask for (ADR-0039).
 */
export function routeDriveView(entry: RouteDriveEntry) {
  const { route, expense, mileage } = entry;
  return {
    ...mileageEntry(entry),
    route: {
      status: route.status,
      problem: route.problem,
      roundTrip: route.roundTrip,
      stops: route.stops.map((s) => ({
        address: s.address,
        place:
          s.label === null || s.longitude === null || s.latitude === null
            ? null
            : { label: s.label, longitude: s.longitude, latitude: s.latitude },
        legMetres: s.legMetres,
      })),
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

export function routeKeyStatus(stored: StoredRouteKey | undefined) {
  return {
    provider: 'openrouteservice' as const,
    configured: stored !== undefined,
    keyHint: stored?.keyHint ?? null,
    verifiedAt: stored?.verifiedAt?.toISOString() ?? null,
    updatedAt: stored?.updatedAt.toISOString() ?? null,
  };
}
