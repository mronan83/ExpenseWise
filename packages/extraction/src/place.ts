import { NO_DETAILS, type ExpenseDetails } from '@expensewise/domain';
import cityTimezones from 'city-timezones';
import type { NormalizedExtraction, Place } from './normalize.ts';

/**
 * Works out a time zone from where a receipt was printed, offline, so no address leaves
 * ExpenseWise (FR-INT-17, ADR-0030). The data is simplemaps' world cities, about 7,300 of
 * them, through city-timezones.
 */

/** A name to compare: no case, accents, punctuation or spacing. */
const key = (value: string) =>
  value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');

interface Zone {
  readonly zone: string;
  readonly pop: number;
}

const byCity = new Map<string, Zone>();
const byRegion = new Map<string, Zone>();
const byCountry = new Map<string, Set<string>>();
const keep = (map: Map<string, Zone>, k: string, zone: Zone) => {
  const known = map.get(k);
  if (!known || zone.pop > known.pop) map.set(k, zone);
};
for (const c of cityTimezones.cityMapping) {
  if (!c.timezone || !c.iso2) continue;
  const zone = { zone: c.timezone, pop: c.pop };
  keep(byCity, `${c.iso2}|${key(c.city)}`, zone);
  if (c.city_ascii) keep(byCity, `${c.iso2}|${key(c.city_ascii)}`, zone);
  if (c.province) keep(byRegion, `${c.iso2}|${key(c.province)}`, zone);
  if (c.state_ansi) keep(byRegion, `${c.iso2}|${key(c.state_ansi)}`, zone);
  const zones = byCountry.get(c.iso2) ?? new Set<string>();
  zones.add(c.timezone);
  byCountry.set(c.iso2, zones);
}

/**
 * The time zone a place is in: its city's, else its region's most populous city's, else its
 * country's when the country has only one. Null when it can't be known; the person can set it.
 */
export function timeZoneFor(place: Pick<Place, 'city' | 'region' | 'country'>): string | null {
  const { country } = place;
  if (!country) return null;
  if (place.city) {
    const found = byCity.get(`${country}|${key(place.city)}`);
    if (found) return found.zone;
  }
  if (place.region) {
    const found = byRegion.get(`${country}|${key(place.region)}`);
    if (found) return found.zone;
  }
  const zones = byCountry.get(country);
  return zones?.size === 1 ? [...zones][0]! : null;
}

/** The time and place a reading would file its expense with. */
export function detailsOf(reading: NormalizedExtraction | null): ExpenseDetails {
  if (!reading) return NO_DETAILS;
  const place = reading.place?.value ?? null;
  return {
    time: reading.time?.value ?? null,
    timeZone: place ? timeZoneFor(place) : null,
    address: place?.address ?? null,
    city: place?.city ?? null,
    region: place?.region ?? null,
    country: place?.country ?? null,
  };
}
