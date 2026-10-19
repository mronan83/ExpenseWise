import { describe, expect, it } from 'vitest';
import {
  applyPlaceInput,
  applyRouteDriveInput,
  checkRouteStops,
  isStopPin,
  PLACE_LABEL_MAX,
  claimRouteMiles,
  milesFromMetres,
  MILLIMETRES_PER_MILE,
  PLACE_NAME_MAX,
  ROUTE_ADDRESS_MAX,
  ROUTE_MAX_STOPS,
  ROUTE_NAME_MAX,
  ROUTE_REASON_MAX,
  routeDisplayName,
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

describe('a drive’s name (FR-CAP-15, Q55)', () => {
  it('goes by its start and end, a saved place by its name, unless it has a name of its own', () => {
    const stops = ['1520 Harney St, Omaha, NE', 'Acme HQ, 1200 Dodge St', 'Eppley Airfield, Omaha'];
    expect(routeDisplayName({ stops, roundTrip: false })).toBe('1520 Harney St → Eppley Airfield');
    expect(routeDisplayName({ stops, roundTrip: true })).toBe(
      '1520 Harney St → Eppley Airfield and back',
    );
    const saved = new Map([['1520 harney st, omaha, ne', 'Office']]);
    expect(routeDisplayName({ stops, roundTrip: false }, saved)).toBe('Office → Eppley Airfield');
    expect(routeDisplayName({ name: 'Acme visit and the airport', stops, roundTrip: true })).toBe(
      'Acme visit and the airport',
    );
  });

  it('keeps a name trimmed, up to the most characters, and clears it to go back to its stops', () => {
    const named = applyRouteDriveInput(null, { ...drive, name: '  Acme   visit ' }, TODAY);
    expect(named.ok && named.value.values.name).toBe('Acme visit');
    const current: RouteDriveValues = { ...drive, name: 'Acme visit', roundTrip: false };
    const renamed = applyRouteDriveInput(current, { name: 'Acme and back' }, TODAY);
    expect(renamed.ok && renamed.value.changes).toEqual([
      { field: 'name', from: 'Acme visit', to: 'Acme and back' },
    ]);
    // A new name never measures the drive again.
    expect(renamed.ok && renamed.value.remeasure).toBe(false);
    for (const cleared of [null, '  ']) {
      const result = applyRouteDriveInput(current, { name: cleared }, TODAY);
      expect(result.ok && 'name' in result.value.values).toBe(false);
      expect(result.ok && result.value.changes).toEqual([
        { field: 'name', from: 'Acme visit', to: null },
      ]);
    }
    expect(
      applyRouteDriveInput(null, { ...drive, name: 'x'.repeat(ROUTE_NAME_MAX + 1) }, TODAY),
    ).toMatchObject({ ok: false, error: { field: 'name', message: /80 characters/ } });
  });
});

describe('a stop picked from the suggestions (FR-CAP-14, Q53)', () => {
  const eppley = {
    label: 'Eppley Airfield, Omaha, NE, USA',
    longitude: '-95.894069',
    latitude: '41.303166',
  };
  const picked = { address: 'Eppley Airfield, 4501 Abbott Drive, Omaha, NE, USA', pin: eppley };

  it('keeps the place it was picked at beside its address, and none for a stop typed', () => {
    const logged = applyRouteDriveInput(
      null,
      { ...drive, stops: ['12 Elm St, Omaha', picked] },
      TODAY,
    );
    if (!logged.ok) throw new Error(logged.error.message);
    expect(logged.value.values).toMatchObject({
      stops: ['12 Elm St, Omaha', 'Eppley Airfield, 4501 Abbott Drive, Omaha, NE, USA'],
      pins: [null, eppley],
    });
    const typed = applyRouteDriveInput(null, drive, TODAY);
    expect(typed.ok && 'pins' in typed.value.values).toBe(false);
  });

  it('measures again when a stop is picked, or typed over, at the same address', () => {
    const current: RouteDriveValues = {
      ...drive,
      stops: ['12 Elm St, Omaha', picked.address],
      pins: [null, eppley],
      roundTrip: false,
    };
    const same = applyRouteDriveInput(current, { stops: ['12 Elm St, Omaha', picked] }, TODAY);
    expect(same.ok && same.value.changes).toEqual([]);
    const typed = applyRouteDriveInput(
      current,
      { stops: ['12 Elm St, Omaha', picked.address] },
      TODAY,
    );
    expect(typed.ok && typed.value.remeasure).toBe(true);
    const elsewhere = applyRouteDriveInput(
      current,
      { stops: ['12 Elm St, Omaha', { ...picked, pin: { ...eppley, latitude: '41.300000' } }] },
      TODAY,
    );
    expect(elsewhere.ok && elsewhere.value.remeasure).toBe(true);
  });

  it('refuses a picked place that isn’t whole: no name, or a point off the globe or not to six places', () => {
    expect(isStopPin(eppley)).toBe(true);
    for (const pin of [
      { ...eppley, label: ' ' },
      { ...eppley, label: 'x'.repeat(PLACE_LABEL_MAX + 1) },
      { ...eppley, longitude: '-195.000000' },
      { ...eppley, latitude: '91.000000' },
      { ...eppley, latitude: '41.3' },
      { ...eppley, longitude: 'west' },
    ]) {
      expect(isStopPin(pin)).toBe(false);
    }
    expect(
      applyRouteDriveInput(
        null,
        { ...drive, stops: [{ ...picked, pin: { ...eppley, latitude: '91.000000' } }, 'Home'] },
        TODAY,
      ),
    ).toEqual({
      ok: false,
      error: {
        field: 'stops',
        stop: 0,
        message: 'The place picked for the start isn’t whole. Pick it again, or type its address.',
      },
    });
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
