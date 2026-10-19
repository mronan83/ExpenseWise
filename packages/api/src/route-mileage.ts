import {
  changeRouteDrive,
  claimMilesForRoute,
  deleteRouteKey,
  getExpense,
  getRouteDrive,
  getRouteKey,
  listSavedPlaces,
  logRouteMileage,
  recentPlaces,
  removePlace,
  savePlace,
  saveRouteKey,
  withOrg,
  type ChangeRouteDriveResult,
  type ClaimRouteMilesResult,
  type Database,
  type ExpenseRecord,
  type LogRouteMileageResult,
  type MileageRecord,
  type RecentPlace,
  type RouteKeyWrite,
  type RouteRecord,
  type SavedPlace,
  type SavePlaceResult,
  type StoredRouteKey,
} from '@expensewise/db';
import {
  isStopPin,
  RECENT_PLACES,
  type IsoDate,
  type RouteDriveInput,
  type RouteProvider,
  type StopPin,
} from '@expensewise/domain';
import { asCaller } from './caller.ts';
import { SecretBoxError, type SecretBox } from './secret-box.ts';

/** A route drive: the expense that claims it, the drive, and its route. */
export interface RouteDriveEntry {
  readonly expense: ExpenseRecord;
  readonly mileage: MileageRecord;
  readonly route: RouteRecord;
}

/**
 * What the API needs from the database for route drives and saved places (FR-CAP-04). Every
 * call names the member: a member's drives and places are their own. Tests use a fake.
 */
export interface RouteMileageStore {
  /** Logs a route drive; the expense, its log, route, stops, request and audit commit together. */
  log(
    orgId: string,
    memberId: string,
    input: RouteDriveInput,
    actorUserId: string,
    today: IsoDate,
  ): Promise<LogRouteMileageResult>;
  /** One of the member's route drives, or undefined. */
  get(orgId: string, memberId: string, expenseId: string): Promise<RouteDriveEntry | undefined>;
  change(
    orgId: string,
    memberId: string,
    expenseId: string,
    input: RouteDriveInput,
    actorUserId: string,
    today: IsoDate,
  ): Promise<ChangeRouteDriveResult>;
  claim(
    orgId: string,
    memberId: string,
    expenseId: string,
    input: { readonly miles: string; readonly reason?: string | null },
    actorUserId: string,
    today: IsoDate,
  ): Promise<ClaimRouteMilesResult>;
  places(orgId: string, memberId: string): Promise<SavedPlace[]>;
  /** The places the member's own drives went to, newest first, once each (FR-CAP-14). */
  recentPlaces(orgId: string, memberId: string): Promise<RecentPlace[]>;
  /** Saves a new place (placeId null) or changes one of the member's. */
  savePlace(
    orgId: string,
    memberId: string,
    placeId: string | null,
    input: { readonly name?: string; readonly address?: string },
    actorUserId: string,
  ): Promise<SavePlaceResult>;
  removePlace(
    orgId: string,
    memberId: string,
    placeId: string,
    actorUserId: string,
  ): Promise<boolean>;
}

/** Route drives and saved places on Postgres, as expensewise_app and as the caller. */
export function dbRouteMileageStore(db: Database): RouteMileageStore {
  // As the caller, so row-level security shows and changes only what their role allows (ADR-0035).
  const inOrg = asCaller(db);
  return {
    log: (orgId, memberId, input, actor, today) =>
      inOrg(orgId, (tx) => logRouteMileage(tx, orgId, memberId, input, actor, today)),
    get: (orgId, memberId, expenseId) =>
      inOrg(orgId, async (tx) => {
        const found = await getRouteDrive(tx, memberId, expenseId);
        const expense = found && (await getExpense(tx, expenseId));
        return found && expense ? { ...found, expense } : undefined;
      }),
    change: (orgId, memberId, expenseId, input, actor, today) =>
      inOrg(orgId, (tx) => changeRouteDrive(tx, orgId, memberId, expenseId, input, actor, today)),
    claim: (orgId, memberId, expenseId, input, actor, today) =>
      inOrg(orgId, (tx) => claimMilesForRoute(tx, orgId, memberId, expenseId, input, actor, today)),
    places: (orgId, memberId) => inOrg(orgId, (tx) => listSavedPlaces(tx, memberId)),
    recentPlaces: (orgId, memberId) =>
      inOrg(orgId, (tx) => recentPlaces(tx, memberId, RECENT_PLACES)),
    savePlace: (orgId, memberId, placeId, input, actor) =>
      inOrg(orgId, (tx) => savePlace(tx, orgId, memberId, placeId, input, actor)),
    removePlace: (orgId, memberId, placeId, actor) =>
      inOrg(orgId, (tx) => removePlace(tx, orgId, memberId, placeId, actor)),
  };
}

/** The organization's key for measuring routes (Q31). Owners and finance admins only. */
export interface RouteKeyStore {
  get(orgId: string): Promise<StoredRouteKey | undefined>;
  /** Stores it, replacing any earlier one, with its audit event. */
  save(orgId: string, key: RouteKeyWrite, actorUserId: string): Promise<StoredRouteKey>;
  /** Removes it with its audit event; false when there was none. */
  remove(orgId: string, actorUserId: string): Promise<boolean>;
}

/** The route key on Postgres, as the caller. */
export function dbRouteKeyStore(db: Database): RouteKeyStore {
  const inOrg = asCaller(db);
  return {
    get: (orgId) => inOrg(orgId, (tx) => getRouteKey(tx, 'openrouteservice')),
    save: (orgId, key, actor) => inOrg(orgId, (tx) => saveRouteKey(tx, orgId, key, actor)),
    remove: (orgId, actor) =>
      inOrg(orgId, (tx) => deleteRouteKey(tx, orgId, 'openrouteservice', actor)),
  };
}

/** Binds a route key's ciphertext to its organization and provider (ADR-0039, as ADR-0015). */
export const routeSealContext = (orgId: string, provider: RouteProvider) =>
  `${orgId}:route:${provider}`;

/**
 * Reads an organization's OpenRouteService key for the measuring workflow, decrypted. The
 * plaintext stays in memory for the call that needs it; it is never logged or returned from a
 * step. The workflow acts for the system, so no member is named.
 */
export function storedRouteKeyReader(db: Database, secrets: SecretBox) {
  return async (orgId: string): Promise<{ key: string } | 'no_key' | 'unreadable_key'> => {
    const stored = await withOrg(db, orgId, (tx) => getRouteKey(tx, 'openrouteservice'));
    if (!stored) return 'no_key';
    try {
      return { key: secrets.open(stored.ciphertext, routeSealContext(orgId, stored.provider)) };
    } catch (error) {
      if (error instanceof SecretBoxError) return 'unreadable_key';
      throw error;
    }
  };
}

/**
 * How OpenRouteService answered a key's check (ADR-0039): the same shape the workflows'
 * `routeKeyVerifier()` gives, which the server passes in.
 */
export type RouteKeyVerdict =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: 'rejected' | 'limited' | 'unreachable' | 'refused';
      readonly status?: number;
      readonly detail?: string;
    };

/** Checks a key with one cheap call to OpenRouteService, as it is saved. Never logs the key. */
export type RouteKeyVerifier = (key: string) => Promise<RouteKeyVerdict>;

/** A place OpenRouteService suggests for a stop, as the workflows' `suggestPlaces()` gives it. */
export interface SuggestedPlace {
  readonly name: string;
  readonly detail: string;
  readonly address: string;
  readonly label: string;
  readonly longitude: number;
  readonly latitude: number;
}

/** Why a stop has no suggestions from OpenRouteService. */
export type SuggestProblem =
  'no_key' | 'unreadable_key' | 'rejected' | 'limited' | 'unreachable' | 'refused';

/**
 * Suggests places for what is typed in a stop with the organization's own key (ADR-0052): the
 * shape the workflows' `placeSuggester()` gives, which the server passes in. Never throws for
 * a missing key or a failed answer; it says why.
 */
export type PlaceSuggester = (
  orgId: string,
  query: {
    readonly text: string;
    readonly country: string | null;
    readonly near: { readonly longitude: number; readonly latitude: number } | null;
  },
) => Promise<
  | { readonly ok: true; readonly places: readonly SuggestedPlace[] }
  | { readonly ok: false; readonly reason: SuggestProblem }
>;

/** Binds a pick's seal to its organization: a pick made in one never opens in another. */
export const pickSealContext = (orgId: string) => `${orgId}:route:pick`;

/**
 * Seals the place a stop can be picked at (Q53), so the stop is measured from where the server
 * suggested, found or kept it, and never from a point a caller made up: a pick is tamper-proof
 * and opens only for its organization.
 */
export const sealPick = (secrets: SecretBox, orgId: string, pin: StopPin): string =>
  secrets.seal(
    JSON.stringify({ label: pin.label, longitude: pin.longitude, latitude: pin.latitude }),
    pickSealContext(orgId),
  );

/** The place a pick was sealed for, or null when it doesn't open here or isn't whole. */
export function openPick(
  secrets: SecretBox | undefined,
  orgId: string,
  pick: string,
): StopPin | null {
  if (!secrets) return null;
  try {
    const pin = JSON.parse(secrets.open(pick, pickSealContext(orgId))) as Partial<StopPin>;
    if (
      typeof pin.label !== 'string' ||
      typeof pin.longitude !== 'string' ||
      typeof pin.latitude !== 'string'
    ) {
      return null;
    }
    const opened = { label: pin.label, longitude: pin.longitude, latitude: pin.latitude };
    return isStopPin(opened) ? opened : null;
  } catch (error) {
    if (error instanceof SecretBoxError || error instanceof SyntaxError) return null;
    throw error;
  }
}
