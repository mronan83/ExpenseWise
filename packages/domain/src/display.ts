import { isIsoDate } from './dates.ts';

/*
 * How a date or a time reads on screen (Q12, NFR-UX-06): Sep 30, 2026, and 1:12 PM where the
 * time matters. One formatter, so every screen reads the same whatever the phone's own
 * settings. Forms keep the phone's date picker, and a model's reading keeps each date exactly
 * as it was read; neither goes through here.
 */

const LOCALE = 'en-US';
const DATE: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', year: 'numeric' };
const TIME: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' };

/** The thin and narrow spaces some engines put in ranges and times, as plain spaces. */
const plain = (text: string) => text.replace(/[\u2009\u202f]/g, ' ');

/**
 * A calendar date is shown as written: built at noon UTC and formatted in UTC, so no time zone
 * moves it a day. A moment is shown in the given time zone, by default the viewer's own.
 */
function parts(value: string, timeZone?: string): { at: Date; timeZone?: string } {
  if (isIsoDate(value)) return { at: new Date(`${value}T12:00:00Z`), timeZone: 'UTC' };
  return { at: new Date(value), ...(timeZone ? { timeZone } : {}) };
}

/** "Sep 30, 2026", from a calendar date (2026-09-30) or a moment (an ISO timestamp). */
export function showDate(value: string, timeZone?: string): string {
  const { at, timeZone: zone } = parts(value, timeZone);
  return plain(at.toLocaleDateString(LOCALE, { ...DATE, timeZone: zone }));
}

/** "1:12 PM", the time of a moment. */
export function showTime(at: string, timeZone?: string): string {
  return plain(new Date(at).toLocaleTimeString(LOCALE, { ...TIME, timeZone }));
}

/** "Sep 30, 2026, 1:12 PM", for when something happened and the time matters. */
export function showDateTime(at: string, timeZone?: string): string {
  return plain(new Date(at).toLocaleString(LOCALE, { ...DATE, ...TIME, timeZone }));
}

/** "Sep 29 – Oct 1, 2026", or "Sep 22 – 25, 2026" within a month, for two calendar dates. */
export function showDateRange(from: string, to: string): string {
  const format = new Intl.DateTimeFormat(LOCALE, { ...DATE, timeZone: 'UTC' });
  return plain(format.formatRange(parts(from).at, parts(to).at));
}

/** "Mon, Sep 22, 2026": a calendar date with its weekday, as a trip's days are headed. */
export function showDay(date: string): string {
  return plain(
    parts(date).at.toLocaleDateString(LOCALE, { ...DATE, weekday: 'short', timeZone: 'UTC' }),
  );
}
