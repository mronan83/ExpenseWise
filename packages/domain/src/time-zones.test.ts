import { describe, expect, it } from 'vitest';
import { addDays, addDaysIn, dateIn, LAST_TIME_ZONE, startOfDayIn } from './time-zones.ts';

const at = (iso: string) => new Date(iso);

describe('days in a time zone', () => {
  it('says what date it is in a zone at a moment', () => {
    const moment = at('2026-10-04T03:30:00Z');
    expect(dateIn(moment, 'UTC')).toBe('2026-10-04');
    expect(dateIn(moment, 'America/Chicago')).toBe('2026-10-03');
    expect(dateIn(moment, 'Asia/Tokyo')).toBe('2026-10-04');
    // UTC−12 is where the day ends last.
    expect(dateIn(at('2026-10-04T11:59:59Z'), LAST_TIME_ZONE)).toBe('2026-10-03');
    expect(dateIn(at('2026-10-04T12:00:00Z'), LAST_TIME_ZONE)).toBe('2026-10-04');
  });

  it('counts calendar days, across months and years', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(() => addDays('2026-02-30', 1)).toThrow();
  });

  it('finds when a day begins in a zone', () => {
    expect(startOfDayIn('2026-10-04', 'America/Chicago').toISOString()).toBe(
      '2026-10-04T05:00:00.000Z',
    );
    expect(startOfDayIn('2026-11-02', 'America/Chicago').toISOString()).toBe(
      '2026-11-02T06:00:00.000Z',
    );
    expect(startOfDayIn('2026-10-04', LAST_TIME_ZONE).toISOString()).toBe(
      '2026-10-04T12:00:00.000Z',
    );
  });

  it('keeps the time of day across a clock change', () => {
    // 09:30 in New York on 7 Mar (EST) and on 9 Mar (EDT), 47 hours apart.
    const before = at('2026-03-07T14:30:00Z');
    expect(addDaysIn(before, 2, 'America/New_York').toISOString()).toBe('2026-03-09T13:30:00.000Z');
    // A zone with no clock changes adds whole days, to the millisecond.
    expect(addDaysIn(at('2026-03-07T14:30:00.250Z'), 2, 'UTC').toISOString()).toBe(
      '2026-03-09T14:30:00.250Z',
    );
  });
});
