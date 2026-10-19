import { milesFromMetres, showDateTime } from '@expensewise/domain';
import type { MileageEntry } from './mileage';

/** The feature flag route mileage ships behind (ADR-0032). */
export const ROUTE_MILEAGE_FLAG = 'expenses.route-mileage';

/** The flag place suggestions for a stop ship behind (FR-CAP-14, ADR-0052). */
export const PLACE_SUGGESTIONS_FLAG = 'expenses.place-suggestions';

/** Most places one drive goes through, its start and end included (R-ROUTE-STOPS). */
export {
  ROUTE_MAX_STOPS,
  ROUTE_ADDRESS_MAX,
  PLACE_NAME_MAX,
  ROUTE_NAME_MAX,
  SUGGEST_MIN_CHARS,
  SUGGEST_WAIT_MS,
} from '@expensewise/domain';

/** Where a stop is, to six places: found once measured, or picked from the suggestions. */
export interface StopPlace {
  label: string;
  longitude: string;
  latitude: string;
}

/** One stop: as typed, and where it was found once measured, or where it was picked. */
export interface RouteStop {
  address: string;
  place: StopPlace | null;
  /** Picked from the suggestions: measured from its place, its address never searched (Q53). */
  pinned: boolean;
  /** Sent back with the stop to keep the place it was picked at. */
  pick: string | null;
  /** The leg to it from the stop before, in whole metres; null for the start. */
  legMetres: number | null;
}

/** How a route drive was measured, or why it was not (FR-CAP-04, ADR-0039). */
export interface Route {
  status: 'measuring' | 'measured' | 'failed';
  problem: string | null;
  /** The name its person gave it; null when it goes by its start and end (FR-CAP-15). */
  name: string | null;
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

/** What the form says while places are suggested (Q32, Q53, Q54). */
export const WHAT_IS_SENT_WITH_SUGGESTIONS =
  'What you type in a stop is sent to OpenRouteService to suggest places, and an address you type is sent again whenever the drive is measured. A place you pick is measured from exactly where it is. Never a name, note or purpose, and never where you are.';

/** A place suggested for what is typed in a stop (FR-CAP-14). */
export interface PlaceSuggestion {
  name: string;
  detail: string;
  address: string;
  label: string;
  longitude: string;
  latitude: string;
  pick: string;
}

/** Why a stop has no suggestions from OpenRouteService. */
export type SuggestProblem =
  'no_key' | 'unreadable_key' | 'rejected' | 'limited' | 'unreachable' | 'refused' | 'unavailable';

export interface PlaceSuggestionList {
  places: PlaceSuggestion[];
  problem: SuggestProblem | null;
  attribution: string;
}

/** A place the person's own drives went to, to pick again. */
export interface RecentPlace {
  address: string;
  label: string;
  longitude: string;
  latitude: string;
  lastDriven: string;
  pick: string | null;
}

/** Why no places are suggested, in words, with what to do: type the address instead. */
export function suggestionProblem(problem: SuggestProblem): string {
  switch (problem) {
    case 'no_key':
    case 'unreadable_key':
      return 'Places can’t be suggested until an owner or finance admin saves your organization’s OpenRouteService key in Settings › Mileage. Type the address.';
    case 'rejected':
      return 'OpenRouteService refused your organization’s key, so places can’t be suggested. Type the address.';
    case 'limited':
      return 'Your organization’s OpenRouteService key has used up its suggestions for now. Type the address.';
    default:
      return 'Places can’t be suggested right now. Type the address.';
  }
}

/** A stop on the form: its address, and the place it was picked at, if it was. */
export interface StopDraft {
  address: string;
  /** The seal to send with it, so it is measured from where it was picked. */
  pick: string | null;
  place: StopPlace | null;
}

/** A stop typed, or not yet filled. */
export const typedStop = (address = ''): StopDraft => ({ address, pick: null, place: null });

/** A drive's stop as the form starts from it: picked stops stay picked. */
export const stopDraft = (stop: RouteStop): StopDraft =>
  stop.pinned && stop.pick && stop.place
    ? { address: stop.address, pick: stop.pick, place: stop.place }
    : typedStop(stop.address);

/** A stop as the API takes it: an address typed, or one picked with its pick. */
export const stopBody = (stop: StopDraft) =>
  stop.pick ? { address: stop.address, pick: stop.pick } : stop.address;

/** Whether two stops are the same: the same address, picked at the same place or neither. */
export const sameStop = (a: StopDraft, b: StopDraft) =>
  a.address === b.address &&
  (a.place?.label ?? null) === (b.place?.label ?? null) &&
  (a.place?.longitude ?? null) === (b.place?.longitude ?? null) &&
  (a.place?.latitude ?? null) === (b.place?.latitude ?? null);

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
