import { describe, expect, it } from 'vitest';
import {
  applyPlaceInput,
  applyRouteDriveInput,
  checkRouteStops,
  claimRouteMiles,
  milesFromMetres,
  MILLIMETRES_PER_MILE,
  PLACE_NAME_MAX,
  ROUTE_ADDRESS_MAX,
  ROUTE_MAX_STOPS,
  ROUTE_REASON_MAX,
  routePoints,
  stopName,
  wholeMetres,
  type RouteDriveValues,
} from './route-mileage.ts';

describe('miles from a measured distance (ADR-0039)', () => {
  it('turns whole metres into hundredths of a mile, exactly, rounding half up', () => {
    expect(MILLIMETRES_PER_MILE).toBe(1_609_344);
    expect(milesFromMetres(0)).toBe('0');
    // 1,609 m is 0.99972 mi
    expect(milesFromMetres(1609)).toBe('1');
    expect(milesFromMetres(1_609_344)).toBe('1000');
    // 804 m is 0.49958 mi
    expect(milesFromMetres(804)).toBe('0.5');
    // 61,800 m is 38.4007 mi
    expect(milesFromMetres(61_800)).toBe('38.4');
    // 25,146 m is exactly 15.625 mi: half a hundredth, rounded up
    expect(milesFromMetres(25_146)).toBe('15.63');
    expect(milesFromMetres(25_145)).toBe('15.62');
  });

  it('refuses anything that is not a whole, non-negative number of metres', () => {
    expect(() => milesFromMetres(-1)).toThrow(/whole metres/);
    expect(() => milesFromMetres(12.5)).toThrow(/whole metres/);
    expect(() => milesFromMetres(Number.NaN)).toThrow(/whole metres/);
  });

  it('reads a distance in metres to the whole metre, half up, through its digits', () => {
    expect(wholeMetres(12345.4)).toBe(12345);
    expect(wholeMetres(12345.5)).toBe(12346);
    expect(wholeMetres(0.5)).toBe(1);
    expect(wholeMetres(0.0000001)).toBe(0);
    expect(wholeMetres(1830)).toBe(1830);
    expect(() => wholeMetres(-0.1)).toThrow(/in metres/);
    expect(() => wholeMetres(Number.POSITIVE_INFINITY)).toThrow(/in metres/);
  });
});

describe('a route’s stops (FR-CAP-04)', () => {
  it('keeps each address as typed, trimmed, from a start to an end', () => {
    expect(checkRouteStops(['  12 Elm St,  Omaha ', 'Eppley Airfield'])).toEqual({
      ok: true,
      value: ['12 Elm St, Omaha', 'Eppley Airfield'],
    });
  });

  it('needs a start and an end, at most the most stops, and an address for each', () => {
    expect(checkRouteStops(['Home'])).toMatchObject({ ok: false, error: { field: 'stops' } });
    const many = Array.from({ length: ROUTE_MAX_STOPS + 1 }, (_, i) => `Stop ${i}`);
    expect(checkRouteStops(many.slice(0, ROUTE_MAX_STOPS)).ok).toBe(true);
    const tooMany = checkRouteStops(many);
    expect(tooMany.ok).toBe(false);
    if (!tooMany.ok) expect(tooMany.error.message).toMatch(/at most 25 places/);
    expect(checkRouteStops(['Home', ' ', 'Office'])).toEqual({
      ok: false,
      error: { field: 'stops', message: 'Enter the address of stop 2, or remove it.', stop: 1 },
    });
    expect(checkRouteStops(['Home', 'x'.repeat(ROUTE_ADDRESS_MAX + 1)])).toMatchObject({
      ok: false,
      error: { stop: 1, message: /the end to 200 characters/ },
    });
  });

  it('names each stop as the form does, and ends a round trip back at its start', () => {
    expect([0, 1, 2].map((i) => stopName(i, 3))).toEqual(['the start', 'stop 2', 'the end']);
    expect(routePoints(['A', 'B', 'C'], true)).toEqual(['A', 'B', 'C', 'A']);
    expect(routePoints(['A', 'B'], false)).toEqual(['A', 'B']);
  });
});

const TODAY = '2026-10-04';
const drive = {
  date: '2026-09-29',
  purpose: 'Client visit at Acme',
  stops: ['12 Elm St, Omaha', 'Eppley Airfield'],
};

describe('a route drive, logged and changed', () => {
  it('needs a date, a purpose and stops, and copies the rate in force on the date', () => {
    const logged = applyRouteDriveInput(null, drive, TODAY);
    if (!logged.ok) throw new Error(logged.error.message);
    expect(logged.value.values).toEqual({ ...drive, roundTrip: false });
    expect(logged.value.remeasure).toBe(true);
    expect(logged.value.rate).toMatchObject({ perUnit: '0.725', effectiveFrom: '2026-01-01' });
    expect(applyRouteDriveInput(null, { ...drive, purpose: ' ' }, TODAY)).toMatchObject({
      ok: false,
      error: { field: 'purpose' },
    });
    expect(applyRouteDriveInput(null, { ...drive, date: '2026-10-06' }, TODAY)).toMatchObject({
      ok: false,
      error: { field: 'date', message: /can’t be after today/ },
    });
    expect(
      applyRouteDriveInput(null, { ...drive, date: '2027-01-02' }, '2027-01-02'),
    ).toMatchObject({ ok: false, error: { field: 'date', message: /after 2026-12-31 yet/ } });
    expect(applyRouteDriveInput(null, { date: drive.date, purpose: 'x' }, TODAY)).toMatchObject({
      ok: false,
      error: { field: 'stops' },
    });
  });

  it('measures again only when the stops or the round trip change', () => {
    const current: RouteDriveValues = { ...drive, roundTrip: false };
    const renamed = applyRouteDriveInput(current, { purpose: 'Acme onsite' }, TODAY);
    expect(renamed.ok && renamed.value.remeasure).toBe(false);
    expect(renamed.ok && renamed.value.rate).toBeNull();
    const same = applyRouteDriveInput(current, { stops: [...drive.stops] }, TODAY);
    expect(same.ok && same.value.changes).toEqual([]);
    const round = applyRouteDriveInput(current, { roundTrip: true }, TODAY);
    expect(round.ok && round.value.remeasure).toBe(true);
    expect(round.ok && round.value.changes).toEqual([
      { field: 'roundTrip', from: false, to: true },
    ]);
    const moved = applyRouteDriveInput(current, { date: '2025-12-31' }, TODAY);
    expect(moved.ok && moved.value.remeasure).toBe(false);
    expect(moved.ok && moved.value.rate?.perUnit).toBe('0.70');
  });
});

describe('the miles claimed for a route drive (Q33)', () => {
  it('pays the measured miles at the rate on the drive’s date, with no reason needed', () => {
    const claimed = claimRouteMiles({ miles: '38.40' }, '38.4', '2026-09-29', TODAY);
    if (!claimed.ok) throw new Error(claimed.error.message);
    expect(claimed.value.miles).toBe('38.4');
    expect(claimed.value.reason).toBeNull();
    // 38.4 × $0.725
    expect(claimed.value.claim.amount).toEqual({ amountMinor: 2784, currency: 'USD' });
    const back = claimRouteMiles({ miles: '38.4', reason: 'no longer' }, '38.4', drive.date, TODAY);
    expect(back.ok && back.value.reason).toBeNull();
  });

  it('needs a reason for other miles, or for miles entered by hand, and keeps it short', () => {
    expect(claimRouteMiles({ miles: '41' }, '38.4', drive.date, TODAY)).toEqual({
      ok: false,
      error: {
        field: 'reason',
        message: 'Say why you claim 41 miles rather than the 38.4 measured.',
      },
    });
    expect(claimRouteMiles({ miles: '41' }, null, drive.date, TODAY)).toMatchObject({
      ok: false,
      error: { field: 'reason', message: /by hand/ },
    });
    const long = claimRouteMiles(
      { miles: '41', reason: 'x'.repeat(ROUTE_REASON_MAX + 1) },
      '38.4',
      drive.date,
      TODAY,
    );
    expect(long).toMatchObject({ ok: false, error: { message: /500 characters/ } });
    const detour = claimRouteMiles(
      { miles: '41', reason: ' Road closed at the bridge ' },
      '38.4',
      drive.date,
      TODAY,
    );
    expect(detour.ok && detour.value).toMatchObject({
      miles: '41',
      reason: 'Road closed at the bridge',
      claim: { amount: { amountMinor: 2973 } },
    });
  });

  it('refuses miles a drive logged by hand would refuse', () => {
    expect(
      claimRouteMiles({ miles: '1000.5', reason: 'x' }, null, drive.date, TODAY),
    ).toMatchObject({ ok: false, error: { field: 'miles', message: /at most 1000 miles/ } });
    expect(claimRouteMiles({ miles: '0', reason: 'x' }, null, drive.date, TODAY)).toMatchObject({
      ok: false,
      error: { field: 'miles' },
    });
  });
});

describe('saved places', () => {
  it('keeps a name and an address, each trimmed, and changes either', () => {
    expect(applyPlaceInput(null, { name: ' Home ', address: '12  Elm St' })).toEqual({
      ok: true,
      value: { name: 'Home', address: '12 Elm St' },
    });
    expect(
      applyPlaceInput({ name: 'Home', address: '12 Elm St' }, { address: '14 Oak Ave' }),
    ).toEqual({ ok: true, value: { name: 'Home', address: '14 Oak Ave' } });
  });

  it('refuses a place with no name or address, or one too long', () => {
    expect(applyPlaceInput(null, { name: '', address: 'x' })).toMatchObject({
      ok: false,
      error: { field: 'name' },
    });
    expect(
      applyPlaceInput(null, { name: 'x'.repeat(PLACE_NAME_MAX + 1), address: 'x' }),
    ).toMatchObject({ ok: false, error: { field: 'name' } });
    expect(applyPlaceInput(null, { name: 'Home' })).toMatchObject({
      ok: false,
      error: { field: 'address' },
    });
  });
});
