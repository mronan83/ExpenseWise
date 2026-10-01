import { DomainError } from './errors.ts';

/** A calendar date with no time zone, e.g. "2026-09-24". Transaction dates are local dates. */
export type IsoDate = string;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isIsoDate(value: string): boolean {
  const match = ISO_DATE.exec(value);
  if (!match) return false;
  const [, y, m, d] = match.map(Number);
  if (y === undefined || m === undefined || d === undefined) return false;
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

export function assertIsoDate(value: string): IsoDate {
  if (!isIsoDate(value)) {
    throw new DomainError('invalid_date', `Not a valid calendar date (YYYY-MM-DD): "${value}"`);
  }
  return value;
}
