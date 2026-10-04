import { milesFromMetres, showDateTime } from '@expensewise/domain';
import type { MileageEntry } from './mileage';

/** The feature flag route mileage ships behind (ADR-0032). */
export const ROUTE_MILEAGE_FLAG = 'expenses.route-mileage';

/** Most places one drive goes through, its start and end included (R-ROUTE-STOPS). */
export { ROUTE_MAX_STOPS, ROUTE_ADDRESS_MAX, PLACE_NAME_MAX } from '@expensewise/domain';

/** One stop: as typed, and where it was found once measured. */
export interface RouteStop {
  address: string;
  place: { label: string; longitude: string; latitude: string } | null;
  /** The leg to it from the stop before, in whole metres; null for the start. */
  legMetres: number | null;
}

/** How a route drive was measured, or why it was not (FR-CAP-04, ADR-0039). */
export interface Route {
  status: 'measuring' | 'measured' | 'failed';
  problem: string | null;
  roundTrip: boolean;
  stops: RouteStop[];
  returnMetres: number | null;
  measured: {
    metres: number;
    miles: string;
    provider: 'openrouteservice';
    profile: string;
    measuredAt: string;
  } | null;
  claimedMiles: string | null;
  reason: string | null;
  attribution: string;
}

/** A route drive, as the expense that claims it. */
export interface RouteDrive extends MileageEntry {
  route: Route;
}

/** A place a person keeps to pick for a stop: only its address is ever used. */
export interface SavedPlace {
  id: string;
  name: string;
  address: string;
}

export interface RouteKeyStatus {
  provider: 'openrouteservice';
  configured: boolean;
  keyHint: string | null;
  verifiedAt: string | null;
  updatedAt: string | null;
}

/** What the form says about what is sent to OpenRouteService (Q32). */
export const WHAT_IS_SENT =
  'Each address is sent to OpenRouteService as typed whenever the drive is measured; never a name, note or purpose.';

/** "4.2 mi": a leg in miles, to the hundredth. */
export const legMiles = (metres: number) => `${milesFromMetres(metres)} mi`;

/** "Measured by OpenRouteService, driving, Oct 4, 2026, 3:00 PM". */
export function measuredBy(measured: NonNullable<Route['measured']>): string {
  const how = measured.profile === 'driving-car' ? 'by car' : measured.profile;
  return `Measured by OpenRouteService, ${how}, ${showDateTime(measured.measuredAt)}`;
}

/** "the start", "stop 2", "the end". */
export function stopLabel(index: number, count: number): string {
  if (index === 0) return 'Start';
  if (index === count - 1) return 'End';
  return `Stop ${index + 1}`;
}
