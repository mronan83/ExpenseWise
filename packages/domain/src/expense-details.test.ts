import { describe, expect, it } from 'vitest';
import {
  applyDetailsEdit,
  isCountryCode,
  isTimeOfDay,
  isTimeZone,
  NO_DETAILS,
  readTime,
  sameDetails,
} from './expense-details.ts';

const omaha = {
  ...NO_DETAILS,
  time: '18:42',
  timeZone: 'America/Chicago',
  address: '1615 Howard St, Omaha, NE 68102',
  city: 'Omaha',
  region: 'NE',
  country: 'US',
};

describe('time and place values', () => {
  it('reads a time of day as HH:MM, padding the hour and dropping seconds', () => {
    expect(readTime('18:42')).toBe('18:42');
    expect(readTime(' 9:05 ')).toBe('09:05');
    expect(readTime('23:59:30')).toBe('23:59');
    expect(readTime('24:00')).toBeNull();
    expect(readTime('7pm')).toBeNull();
    expect(readTime('18.42')).toBeNull();
    expect(isTimeOfDay('00:00')).toBe(true);
    expect(isTimeOfDay('9:05')).toBe(false);
  });

  it('knows a country code’s shape and a real time zone', () => {
    expect(isCountryCode('US')).toBe(true);
    expect(isCountryCode('us')).toBe(false);
    expect(isCountryCode('USA')).toBe(false);
    expect(isTimeZone('America/Chicago')).toBe(true);
    expect(isTimeZone('Europe/London')).toBe(true);
    expect(isTimeZone('Mars/Olympus')).toBe(false);
    expect(isTimeZone('America/Chicago; drop')).toBe(false);
  });
});

describe('a person’s edit to time and place', () => {
  it('sets, tidies and clears fields, and says what changed', () => {
    const result = applyDetailsEdit(omaha, { time: '7:05', country: 'de', city: '  ' });
    expect(result).toEqual({
      ok: true,
      value: {
        details: { ...omaha, time: '07:05', country: 'DE', city: null },
        changes: [
          { field: 'time', from: '18:42', to: '07:05' },
          { field: 'city', from: 'Omaha', to: null },
          { field: 'country', from: 'US', to: 'DE' },
        ],
      },
    });
  });

  it('returns only the details, whatever else the object it is given holds', () => {
    const expense = { ...omaha, merchant: 'Uber', amountMinor: 3145 };
    const result = applyDetailsEdit(expense, { time: '19:00' });
    expect(result.ok && result.value.details).toEqual({ ...omaha, time: '19:00' });
  });

  it('changes nothing when the values are already those', () => {
    const result = applyDetailsEdit(omaha, { time: '18:42', region: 'NE' });
    expect(result.ok && result.value.changes).toEqual([]);
  });

  it.each([
    [{ time: '25:00' }, 'time'],
    [{ country: 'USA' }, 'country'],
    [{ timeZone: 'Central' }, 'timeZone'],
    [{ address: 'x'.repeat(301) }, 'address'],
  ])('refuses %j', (edit, field) => {
    const result = applyDetailsEdit(omaha, edit);
    expect(result.ok ? null : result.error.field).toBe(field);
  });

  it('compares two sets of details', () => {
    expect(sameDetails(omaha, { ...omaha })).toBe(true);
    expect(sameDetails(omaha, { ...omaha, time: '18:43' })).toBe(false);
  });
});
