import { describe, expect, it } from 'vitest';
import { assertIsoDate, daysBetween, isIsoDate } from './dates.ts';

describe('isIsoDate', () => {
  it.each(['2026-09-24', '2024-02-29', '1999-12-31'])('accepts %s', (value) => {
    expect(isIsoDate(value)).toBe(true);
  });

  it.each(['2026-02-30', '2025-02-29', '2026-13-01', '2026-9-1', '2026-09-24T10:00:00Z', ''])(
    'rejects %j',
    (value) => {
      expect(isIsoDate(value)).toBe(false);
    },
  );

  it('assertIsoDate throws a domain error', () => {
    expect(() => assertIsoDate('2026-02-30')).toThrow(/Not a valid calendar date/);
    expect(assertIsoDate('2026-09-24')).toBe('2026-09-24');
  });
});

describe('daysBetween', () => {
  it.each([
    ['2026-09-22', '2026-09-25', 3],
    ['2026-09-25', '2026-09-22', -3],
    ['2026-09-22', '2026-09-22', 0],
    ['2024-02-28', '2024-03-01', 2],
    ['2026-12-31', '2027-01-01', 1],
    ['2026-03-07', '2026-03-09', 2],
  ])('counts %s to %s as %i', (from, to, days) => {
    expect(daysBetween(from, to)).toBe(days);
  });

  it('refuses a date that does not exist', () => {
    expect(() => daysBetween('2026-02-30', '2026-03-01')).toThrow(/Not a valid calendar date/);
  });
});
