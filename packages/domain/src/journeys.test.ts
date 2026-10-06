import { describe, expect, it } from 'vitest';
import {
  applyTravelEdit,
  journeyLine,
  nightsOf,
  NO_TRAVEL,
  sameTravel,
  STAY_MAX_NIGHTS,
  stayLine,
  stayNights,
} from './journeys.ts';

const stay = { ...NO_TRAVEL, checkIn: '2026-09-29', checkOut: '2026-10-01' };

describe('a stay’s nights', () => {
  it('are the days from check-in to check-out: Sep 29 to Oct 1 is 2', () => {
    expect(nightsOf('2026-09-29', '2026-10-01')).toEqual({ sure: true, nights: 2 });
    expect(nightsOf('2026-09-29', '2026-09-30')).toEqual({ sure: true, nights: 1 });
    expect(nightsOf('2026-09-29', '2026-09-29')).toEqual({ sure: true, nights: 0 });
    // Across a year's end and a leap day.
    expect(nightsOf('2027-12-30', '2028-01-02')).toEqual({ sure: true, nights: 3 });
    expect(nightsOf('2028-02-28', '2028-03-01')).toEqual({ sure: true, nights: 2 });
  });

  it('are not sure for a check-out before check-in, or a stay longer than 31 nights', () => {
    expect(STAY_MAX_NIGHTS).toBe(31);
    expect(nightsOf('2026-10-01', '2026-09-29')).toEqual({
      sure: false,
      doubt: 'check_out_before_check_in',
    });
    expect(nightsOf('2026-09-01', '2026-10-02')).toEqual({ sure: true, nights: 31 });
    expect(nightsOf('2026-09-01', '2026-10-03')).toEqual({ sure: false, doubt: 'too_long' });
    // A year misread is the usual cause.
    expect(nightsOf('2025-09-29', '2026-10-01')).toEqual({ sure: false, doubt: 'too_long' });
  });

  it('are worked out from both dates, and unknown until both are known', () => {
    expect(stayNights(stay)).toEqual({ sure: true, nights: 2 });
    expect(stayNights({ checkIn: '2026-09-29', checkOut: null })).toBeNull();
    expect(stayNights({ checkIn: null, checkOut: null })).toBeNull();
    expect(stayNights({ checkIn: '2026-09-31', checkOut: '2026-10-02' })).toBeNull();
  });
});

describe('a journey and a stay, in a line', () => {
  it('reads where a journey went, from either end alone too', () => {
    expect(journeyLine({ journeyFrom: 'SFO', journeyTo: 'ORD' })).toBe('SFO → ORD');
    expect(journeyLine({ journeyFrom: 'Eppley Airfield', journeyTo: null })).toBe(
      'From Eppley Airfield',
    );
    expect(journeyLine({ journeyFrom: null, journeyTo: 'Union Station' })).toBe('To Union Station');
    expect(journeyLine(NO_TRAVEL)).toBeNull();
  });

  it('says the day a ticket departs, beside where it went or alone (FR-EXP-19)', () => {
    const fare = { journeyFrom: 'SFO', journeyTo: 'ORD', departsOn: '2026-10-20' };
    expect(journeyLine(fare)).toBe('SFO → ORD, departs Oct 20, 2026');
    expect(journeyLine({ ...NO_TRAVEL, departsOn: '2026-10-20' })).toBe('Departs Oct 20, 2026');
  });

  it('reads a stay as its nights and dates: 2 nights, Sep 29 – Oct 1, 2026', () => {
    expect(stayLine(stay)).toBe('2 nights, Sep 29 – Oct 1, 2026');
    expect(stayLine({ checkIn: '2026-09-29', checkOut: '2026-09-30' })).toBe(
      '1 night, Sep 29 – 30, 2026',
    );
    expect(stayLine({ checkIn: '2026-09-29', checkOut: '2026-09-29' })).toBe(
      '0 nights, Sep 29, 2026',
    );
    expect(stayLine({ checkIn: '2026-09-29', checkOut: null })).toBe('Check-in Sep 29, 2026');
    expect(stayLine({ checkIn: null, checkOut: '2026-10-01' })).toBe('Check-out Oct 1, 2026');
    expect(stayLine(NO_TRAVEL)).toBeNull();
  });

  it('says a stay’s nights are not sure rather than give a wrong number', () => {
    expect(stayLine({ checkIn: '2026-10-01', checkOut: '2026-09-29' })).toBe(
      'Nights not sure: check-out Sep 29, 2026 is before check-in Oct 1, 2026',
    );
    expect(stayLine({ checkIn: '2025-09-29', checkOut: '2026-10-01' })).toBe(
      'Nights not sure: Sep 29, 2025 – Oct 1, 2026 is more than 31',
    );
  });
});

describe('a person’s edit to a journey and a stay', () => {
  it('sets, tidies and clears fields, and says what changed', () => {
    const current = { ...stay, journeyFrom: 'SFO', journeyTo: 'ORD' };
    expect(
      applyTravelEdit(current, { journeyTo: ' MDW ', journeyFrom: '', checkOut: '2026-10-02' }),
    ).toEqual({
      ok: true,
      value: {
        travel: {
          journeyFrom: null,
          journeyTo: 'MDW',
          departsOn: null,
          checkIn: '2026-09-29',
          checkOut: '2026-10-02',
        },
        changes: [
          { field: 'journeyFrom', from: 'SFO', to: null },
          { field: 'journeyTo', from: 'ORD', to: 'MDW' },
          { field: 'checkOut', from: '2026-10-01', to: '2026-10-02' },
        ],
      },
    });
    expect(applyTravelEdit(current, { journeyFrom: 'SFO' })).toEqual({
      ok: true,
      value: { travel: current, changes: [] },
    });
  });

  it('sets the day a ticket departs, a date that exists, and clears it (FR-EXP-19)', () => {
    const fare = { ...NO_TRAVEL, journeyFrom: 'SFO', journeyTo: 'ORD' };
    const set = applyTravelEdit(fare, { departsOn: ' 2026-10-20 ' });
    expect(set).toMatchObject({
      ok: true,
      value: {
        travel: { departsOn: '2026-10-20' },
        changes: [{ field: 'departsOn', from: null, to: '2026-10-20' }],
      },
    });
    expect(applyTravelEdit(fare, { departsOn: 'Oct 20' })).toMatchObject({
      ok: false,
      error: { field: 'departsOn', message: 'A date is YYYY-MM-DD, such as 2026-09-29.' },
    });
    const flying = { ...fare, departsOn: '2026-10-20' };
    expect(applyTravelEdit(flying, { departsOn: '' })).toMatchObject({
      ok: true,
      value: { travel: { departsOn: null } },
    });
  });

  it('refuses a date that doesn’t exist, an end too long, and a stay that can’t be', () => {
    expect(applyTravelEdit(stay, { checkIn: '2026-09-31' })).toMatchObject({
      ok: false,
      error: { field: 'checkIn' },
    });
    expect(applyTravelEdit(stay, { checkIn: 'Sep 29' })).toMatchObject({ ok: false });
    expect(applyTravelEdit(stay, { journeyTo: 'x'.repeat(201) })).toMatchObject({
      ok: false,
      error: { field: 'journeyTo', message: 'At most 200 characters.' },
    });
    expect(applyTravelEdit(stay, { checkOut: '2026-09-28' })).toEqual({
      ok: false,
      error: { field: 'checkOut', message: 'Check-out is on or after check-in.' },
    });
    expect(applyTravelEdit(stay, { checkIn: '2026-08-01' })).toEqual({
      ok: false,
      error: {
        field: 'checkIn',
        message: 'A stay is at most 31 nights; enter a longer one as two.',
      },
    });
  });

  it('leaves a stay as read alone when the edit doesn’t touch its dates', () => {
    const misread = { ...NO_TRAVEL, checkIn: '2026-10-01', checkOut: '2026-09-29' };
    expect(applyTravelEdit(misread, { journeyTo: 'Hilton Omaha' })).toMatchObject({ ok: true });
    expect(applyTravelEdit(misread, { checkIn: '2026-09-27' })).toMatchObject({ ok: true });
  });

  it('tells two journeys and stays apart', () => {
    expect(sameTravel(stay, { ...stay })).toBe(true);
    expect(sameTravel(stay, { ...stay, journeyTo: 'ORD' })).toBe(false);
  });
});
