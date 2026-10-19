import { ROUTE_ADDRESS_MAX, SUGGEST_SHOWN, SUGGEST_TIMEOUT_MS } from '@expensewise/domain';

/*
 * OpenRouteService (HeiGIT, on OpenStreetMap data), which measures route drives (ADR-0039):
 * Pelias search finds each stop, and the driving-car directions measure the legs between
 * them. Pelias autocomplete suggests places as a stop is typed (ADR-0052). Its free Standard
 * key allows 1,000 searches, 1,000 suggestions and 2,000 routes a day. The key goes in the
 * Authorization header, never in a URL, so it never reaches a log line; nothing here puts it
 * in an error, and an answer that echoes it has it removed.
 */

/** Where OpenRouteService answers. */
export const OPENROUTESERVICE_URL = 'https://api.openrouteservice.org';

/** How long one call may take, inside the 60 seconds a workflow step may run. */
const TIMEOUT_MS = 15_000;

/** Two points about a kilometre apart in Heidelberg, HeiGIT's home: the key check's route. */
const CHECK_ROUTE = 'start=8.681495,49.41461&end=8.687872,49.420318';

/**
 * Why OpenRouteService gave no usable answer. rejected: it refused the key (401, 403).
 * limited: the key's allowance is used up for now (429). unreachable: no answer, or a failure
 * on its side (5xx), so trying again later may work. refused: it could not do what was asked
 * (another 4xx), such as a stop with no road near it.
 */
export type RouteServiceProblem = 'rejected' | 'limited' | 'unreachable' | 'refused';

export class RouteServiceError extends Error {
  constructor(
    readonly kind: RouteServiceProblem,
    message: string,
    readonly status?: number,
    /** OpenRouteService's own error code, such as 2010 for a point with no road near it. */
    readonly code?: number,
  ) {
    super(message);
    this.name = 'RouteServiceError';
  }
}

/** A stop as OpenRouteService found it. */
export interface GeocodedPlace {
  readonly label: string;
  readonly longitude: number;
  readonly latitude: number;
}

/** What measuring a drive asks of the routing service. */
export interface RoutingClient {
  /** The best match for an address, sent exactly as typed, or null when there is none. */
  find(address: string, country: string | null): Promise<GeocodedPlace | null>;
  /** The driving distance of each leg through the points in order, in metres as given. */
  route(points: readonly (readonly [number, number])[]): Promise<number[]>;
}

export interface OpenRouteServiceOptions {
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

/** OpenRouteService's message from a failed answer, with the key removed if echoed. */
async function serviceMessage(
  res: Response,
  key: string,
): Promise<{ message?: string; code?: number }> {
  const body = (await res.json().catch(() => undefined)) as
    { error?: { message?: unknown; code?: unknown } | string; message?: unknown } | undefined;
  const error = body?.error;
  const raw =
    typeof error === 'string'
      ? error
      : typeof error?.message === 'string'
        ? error.message
        : typeof body?.message === 'string'
          ? body.message
          : undefined;
  const code = typeof error === 'object' && typeof error.code === 'number' ? error.code : undefined;
  return {
    ...(raw ? { message: raw.split(key).join('[key]').slice(0, 300) } : {}),
    ...(code === undefined ? {} : { code }),
  };
}

/** Why a request got no answer: a timeout or a network error code, never the error text. */
function failureDetail(error: unknown, timeoutMs: number): string {
  const name = (error as { name?: unknown }).name;
  if (name === 'TimeoutError' || name === 'AbortError') {
    return `no answer within ${timeoutMs / 1000} seconds`;
  }
  const code = (error as { cause?: { code?: unknown } }).cause?.code;
  return `the request failed${typeof code === 'string' ? ` (${code})` : ''}`;
}

/** Calls OpenRouteService with the key, and turns a failed answer into a RouteServiceError. */
function caller(key: string, options: OpenRouteServiceOptions) {
  const doFetch = options.fetch ?? fetch;
  const base = options.baseUrl ?? OPENROUTESERVICE_URL;
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  return async (path: string, init: { method?: string; body?: unknown } = {}) => {
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, {
        method: init.method ?? 'GET',
        headers: {
          authorization: key,
          accept: 'application/json, application/geo+json',
          ...(init.body ? { 'content-type': 'application/json' } : {}),
        },
        ...(init.body ? { body: JSON.stringify(init.body) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new RouteServiceError(
        'unreachable',
        `No answer from OpenRouteService: ${failureDetail(error, timeoutMs)}`,
      );
    }
    if (res.ok) return (await res.json()) as unknown;
    const { message, code } = await serviceMessage(res, key);
    const kind: RouteServiceProblem =
      res.status === 401 || res.status === 403
        ? 'rejected'
        : res.status === 429
          ? 'limited'
          : res.status >= 500
            ? 'unreachable'
            : 'refused';
    throw new RouteServiceError(
      kind,
      `OpenRouteService answered ${res.status}${message ? `: ${message}` : ''}`,
      res.status,
      code,
    );
  };
}

/** OpenRouteService's answer had no usable distance: a change on its side, not ours to retry. */
const unreadable = (what: string) =>
  new RouteServiceError('refused', `OpenRouteService’s answer has no ${what}`);

/**
 * OpenRouteService with an organization's key. Each address is sent as typed, and nothing
 * else of the drive is sent: no name, note or purpose (Q32). An organization's country, when
 * it keeps one, narrows the search to it.
 */
export function openRouteService(
  key: string,
  options: OpenRouteServiceOptions = {},
): RoutingClient {
  const call = caller(key, options);
  return {
    async find(address, country) {
      const query = new URLSearchParams({ text: address, size: '1' });
      if (country) query.set('boundary.country', country);
      const found = (await call(`/geocode/search?${query.toString()}`)) as {
        features?: {
          geometry?: { coordinates?: unknown };
          properties?: { label?: unknown };
        }[];
      };
      const [best] = found.features ?? [];
      if (!best) return null;
      const [longitude, latitude] = (best.geometry?.coordinates ?? []) as unknown[];
      if (typeof longitude !== 'number' || typeof latitude !== 'number') {
        throw unreadable('coordinates for a place it found');
      }
      const label = typeof best.properties?.label === 'string' ? best.properties.label : address;
      return { label, longitude, latitude };
    },
    async route(points) {
      const answer = (await call('/v2/directions/driving-car', {
        method: 'POST',
        // Instructions bring the distance of each leg; the line drawn on a map is not needed.
        body: { coordinates: points, instructions: true, geometry: false, units: 'm' },
      })) as { routes?: { segments?: { distance?: unknown }[] }[] };
      const segments = answer.routes?.[0]?.segments ?? [];
      if (segments.length !== points.length - 1) throw unreadable('distance for each leg');
      return segments.map((s) => {
        if (typeof s.distance !== 'number') throw unreadable('distance for a leg');
        return s.distance;
      });
    },
  };
}

export type RouteKeyVerdict =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: RouteServiceProblem;
      readonly status?: number;
      /** OpenRouteService's own message, or why there was no answer. Never the key. */
      readonly detail?: string;
    };

/** Checks a key with one cheap call to OpenRouteService, as it is saved (Q31). */
export type RouteKeyVerifier = (key: string) => Promise<RouteKeyVerdict>;

/**
 * Checks a key by asking OpenRouteService for one short route, about a kilometre: one of the
 * key's 2,000 routes a day, and the cheapest call that proves the key works for directions.
 */
export function routeKeyVerifier(options: OpenRouteServiceOptions = {}): RouteKeyVerifier {
  return async (key) => {
    try {
      await caller(key, options)(`/v2/directions/driving-car?${CHECK_ROUTE}`);
      return { ok: true };
    } catch (error) {
      if (!(error instanceof RouteServiceError)) throw error;
      return {
        ok: false,
        reason: error.kind,
        ...(error.status ? { status: error.status } : {}),
        detail: error.message,
      };
    }
  };
}

/** A place OpenRouteService suggests for what is typed in a stop (FR-CAP-14, ADR-0052). */
export interface SuggestedPlace {
  /** Its name: a landmark, a business or a street address, such as Eppley Airfield. */
  readonly name: string;
  /** Where it is, under its name: its street when known, and its town. */
  readonly detail: string;
  /** The stop's address once it is picked: its name, street and town in one line. */
  readonly address: string;
  /** OpenRouteService's own name for it, kept as the place the stop is measured from. */
  readonly label: string;
  readonly longitude: number;
  readonly latitude: number;
}

/** What a stop's suggestions are looked up with: what is typed, and where to look first. */
export interface SuggestQuery {
  readonly text: string;
  /** The organization's country, ISO 3166-1 alpha-2, to look in; null when it keeps none. */
  readonly country: string | null;
  /** A place picked earlier in the drive, to rank places near it first (Q54). */
  readonly near: { readonly longitude: number; readonly latitude: number } | null;
}

const text = (value: unknown) =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;

/**
 * A suggestion as a person reads it: its name, then its street (when the name isn't already
 * one) and the rest of its label, its town and region, beneath. Its address is both in one
 * line, so a picked landmark's stop says where it is.
 */
export function suggestedPlace(feature: {
  geometry?: { coordinates?: unknown };
  properties?: Record<string, unknown>;
}): SuggestedPlace | null {
  const [longitude, latitude] = (feature.geometry?.coordinates ?? []) as unknown[];
  if (typeof longitude !== 'number' || typeof latitude !== 'number') return null;
  const props = feature.properties ?? {};
  const label = text(props.label) ?? text(props.name);
  if (!label) return null;
  const name = text(props.name) ?? label.split(',')[0]!.trim();
  const rest = label.startsWith(`${name}, `)
    ? label.slice(name.length + 2)
    : label === name
      ? ''
      : label;
  const streetName = text(props.street);
  const number = text(props.housenumber);
  const street = streetName && number ? `${number} ${streetName}` : streetName;
  const showStreet = street !== undefined && !name.includes(street) && !rest.includes(street);
  const detail = [showStreet ? street : undefined, rest].filter(Boolean).join(', ');
  const address = [name, detail].filter(Boolean).join(', ').slice(0, ROUTE_ADDRESS_MAX).trim();
  return { name, detail, address, label: label.slice(0, 300), longitude, latitude };
}

/**
 * Places for what is typed in a stop, best first, at most SUGGEST_SHOWN: Pelias autocomplete,
 * inside the organization's country when it keeps one, nearest the place given first. Only
 * the text typed and that place are sent (Q32, Q54). One lookup is one of the key's 1,000
 * suggestions a day; it waits SUGGEST_TIMEOUT_MS at most, as the person is waiting.
 */
export async function suggestPlaces(
  key: string,
  query: SuggestQuery,
  options: OpenRouteServiceOptions = {},
): Promise<SuggestedPlace[]> {
  const call = caller(key, { timeoutMs: SUGGEST_TIMEOUT_MS, ...options });
  const params = new URLSearchParams({ text: query.text });
  if (query.country) params.set('boundary.country', query.country);
  if (query.near) {
    params.set('focus.point.lon', query.near.longitude.toFixed(6));
    params.set('focus.point.lat', query.near.latitude.toFixed(6));
  }
  const found = (await call(`/geocode/autocomplete?${params.toString()}`)) as {
    features?: { geometry?: { coordinates?: unknown }; properties?: Record<string, unknown> }[];
  };
  const places: SuggestedPlace[] = [];
  const seen = new Set<string>();
  for (const feature of found.features ?? []) {
    const place = suggestedPlace(feature);
    if (!place || seen.has(place.address.toLowerCase())) continue;
    seen.add(place.address.toLowerCase());
    places.push(place);
    if (places.length === SUGGEST_SHOWN) break;
  }
  return places;
}

/** Why a stop has no suggestions: no usable key, or OpenRouteService's own answer. */
export type SuggestProblem = 'no_key' | 'unreadable_key' | RouteServiceProblem;

/** Suggestions for one organization's stop, with its own key, or why there are none. */
export type PlaceSuggester = (
  orgId: string,
  query: SuggestQuery,
) => Promise<
  | { readonly ok: true; readonly places: readonly SuggestedPlace[] }
  | { readonly ok: false; readonly reason: SuggestProblem }
>;

/**
 * Suggests places with each organization's own OpenRouteService key (ADR-0052), read as the
 * measuring workflow reads it. A missing or unreadable key, or a failed answer, is a reason,
 * never an error: the person goes on typing the address.
 */
export function placeSuggester(deps: {
  readonly routeKey: (
    orgId: string,
  ) => Promise<{ readonly key: string } | 'no_key' | 'unreadable_key'>;
  readonly service?: OpenRouteServiceOptions;
}): PlaceSuggester {
  return async (orgId, query) => {
    const stored = await deps.routeKey(orgId);
    if (stored === 'no_key' || stored === 'unreadable_key') return { ok: false, reason: stored };
    try {
      return { ok: true, places: await suggestPlaces(stored.key, query, deps.service) };
    } catch (error) {
      if (error instanceof RouteServiceError) return { ok: false, reason: error.kind };
      throw error;
    }
  };
}
