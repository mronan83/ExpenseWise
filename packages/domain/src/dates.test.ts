import { describe, expect, it } from 'vitest';
import { assertIsoDate, isIsoDate } from './dates.ts';

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
