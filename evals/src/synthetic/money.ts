import { divRound, formatUnits } from '@expensewise/domain';

/** Cents as a decimal string: 12345 → "123.45". */
export const dollars = (cents: number): string => formatUnits(BigInt(cents), 2);

/** A percentage of an amount in cents, rounded half up, with the rate in basis points. */
export function percentOf(cents: number, basisPoints: number): number {
  return Number(divRound(BigInt(cents) * BigInt(basisPoints), 10_000n, 'half-up'));
}

/** Adds days to an ISO date without time zones getting involved. */
export function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d + days));
  return date.toISOString().slice(0, 10);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-09-14" → "14 Sep 2026" or "09/14/2026", to vary how dates are printed. */
export function printedDate(iso: string, style: 'dmy' | 'us'): string {
  const [y, m, d] = iso.split('-') as [string, string, string];
  return style === 'us' ? `${m}/${d}/${y}` : `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

export const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
