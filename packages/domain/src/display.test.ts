import { describe, expect, it } from 'vitest';
import { showDate, showDateRange, showDateTime, showDay, showTime } from './display.ts';

describe('how dates read on screen (Q12)', () => {
  it('shows a calendar date as Sep 30, 2026, never moved a day by a time zone', () => {
    expect(showDate('2026-09-30')).toBe('Sep 30, 2026');
    expect(showDate('2026-01-01', 'Pacific/Honolulu')).toBe('Jan 1, 2026');
    expect(showDate('2026-12-31', 'Pacific/Kiritimati')).toBe('Dec 31, 2026');
  });

  it('shows a moment as its date where the viewer is', () => {
    expect(showDate('2026-10-01T03:30:00Z', 'America/Chicago')).toBe('Sep 30, 2026');
    expect(showDate('2026-10-01T03:30:00Z', 'Europe/London')).toBe('Oct 1, 2026');
  });

  it('shows the time as 1:12 PM where it matters, after the date', () => {
    expect(showTime('2026-09-30T18:12:47Z', 'America/Chicago')).toBe('1:12 PM');
    expect(showDateTime('2026-09-30T18:12:47Z', 'America/Chicago')).toBe('Sep 30, 2026, 1:12 PM');
    expect(showDateTime('2026-09-30T04:05:00Z', 'UTC')).toBe('Sep 30, 2026, 4:05 AM');
  });

  it('shows two dates as one range, naming the month and year once where they repeat', () => {
    expect(showDateRange('2026-09-29', '2026-10-01')).toBe('Sep 29 – Oct 1, 2026');
    expect(showDateRange('2026-09-22', '2026-09-25')).toBe('Sep 22 – 25, 2026');
    expect(showDateRange('2026-12-30', '2027-01-02')).toBe('Dec 30, 2026 – Jan 2, 2027');
    expect(showDateRange('2026-09-22', '2026-09-22')).toBe('Sep 22, 2026');
  });

  it('heads a trip’s day with its weekday', () => {
    expect(showDay('2026-09-22')).toBe('Tue, Sep 22, 2026');
  });

  it('uses plain spaces, so every engine shows and wraps it alike', () => {
    for (const text of [
      showDateRange('2026-09-29', '2026-10-01'),
      showTime('2026-09-30T18:12:47Z', 'UTC'),
    ]) {
      expect(text).not.toMatch(/[\u2009\u202f]/);
    }
  });
});
