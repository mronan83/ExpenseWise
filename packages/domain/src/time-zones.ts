import { assertIsoDate, type IsoDate } from './dates.ts';

const DAY_MS = 86_400_000;

/**
 * UTC−12, where the day ends last (a POSIX name, so the sign is flipped). A day counted here
 * is over everywhere. The rules count in it when an organization keeps no time zone (ADR-0029).
 */
export const LAST_TIME_ZONE = 'Etc/GMT+12';

const formatters = new Map<string, Intl.DateTimeFormat>();

/** The wall clock in a zone at a moment: year, month, day, hour, minute and second. */
function clock(at: number, timeZone: string): number[] {
  let format = formatters.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(timeZone, format);
  }
  const parts = format.formatToParts(new Date(at));
  return ['year', 'month', 'day', 'hour', 'minute', 'second'].map((type) =>
    Number(parts.find((p) => p.type === type)?.value),
  );
}

/** How far a zone's clock is ahead of UTC at a moment, in milliseconds. */
function offsetAt(at: number, timeZone: string): number {
  const [y = 0, mo = 1, d = 1, h = 0, mi = 0, s = 0] = clock(at, timeZone);
  const wall = Date.UTC(y, mo - 1, d, h, mi, s);
  return wall - (at - (((at % 1000) + 1000) % 1000));
}

/**
 * The moment a zone's clock reads `wall` (a wall time written as if in UTC). Where the clock
 * skips that time, as when it goes forward, a moment up to an hour away.
 */
function momentOf(wall: number, timeZone: string): number {
  const guess = wall - offsetAt(wall, timeZone);
  return wall - offsetAt(guess, timeZone);
}

const isoOf = (y: number, m: number, d: number) =>
  `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/** The calendar date in a zone at a moment. */
export function dateIn(at: Date, timeZone: string): IsoDate {
  const [y = 0, m = 1, d = 1] = clock(at.getTime(), timeZone);
  return isoOf(y, m, d);
}

/** A date a number of days on (or back, when negative). */
export function addDays(day: IsoDate, days: number): IsoDate {
  const [y = 0, m = 1, d = 1] = assertIsoDate(day).split('-').map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + days));
  return isoOf(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate());
}

/** When a day begins in a zone: its midnight. */
export function startOfDayIn(day: IsoDate, timeZone: string): Date {
  const [y = 0, m = 1, d = 1] = assertIsoDate(day).split('-').map(Number);
  return new Date(momentOf(Date.UTC(y, m - 1, d), timeZone));
}

/**
 * The same time on a zone's clock some calendar days on, so a day that is 23 or 25 hours long
 * when the clocks change still counts as one day.
 */
export function addDaysIn(at: Date, days: number, timeZone: string): Date {
  const wall = at.getTime() + offsetAt(at.getTime(), timeZone);
  return new Date(momentOf(wall + days * DAY_MS, timeZone));
}
