import type { NormalizedExtraction } from './normalize.ts';

/** Fields that must be read with high confidence for an expense to skip review. */
export const READY_FIELDS = ['merchant', 'date', 'currency', 'total'] as const;
export type ReadyField = (typeof READY_FIELDS)[number];

/** The pipeline would file this reading as Ready, with no human look (ADR-0006). */
export function isAutoReady(n: NormalizedExtraction): boolean {
  return n.problems.length === 0 && READY_FIELDS.every((f) => n[f]?.confidence === 'high');
}

/** Store and brand names match loosely: case, punctuation and "&" vs "and" don't count. */
export function sameMerchant(expected: string, actual: string): boolean {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/&/g, ' and ')
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\b(the|inc|llc|ltd)\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  const a = norm(expected);
  const b = norm(actual);
  if (!a || !b) return false;
  if (a === b || a.includes(b) || b.includes(a)) return true;
  return levenshtein(a, b) * 100 <= Math.max(a.length, b.length) * 15;
}

function levenshtein(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        (previous[j] ?? 0) + 1,
        (current[j - 1] ?? 0) + 1,
        (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}

/**
 * Where two readings of the same document differ on the fields that decide filing. Two
 * models agreeing is strong evidence both are right; any difference needs a human look.
 * A field both left empty agrees.
 */
export function readingDifferences(a: NormalizedExtraction, b: NormalizedExtraction): ReadyField[] {
  const same: Record<ReadyField, boolean> = {
    merchant:
      a.merchant === null || b.merchant === null
        ? a.merchant === b.merchant
        : sameMerchant(a.merchant.value, b.merchant.value),
    date: a.date?.value === b.date?.value,
    currency: a.currency?.value === b.currency?.value,
    total:
      a.total?.value.amountMinor === b.total?.value.amountMinor &&
      a.total?.value.currency === b.total?.value.currency,
  };
  return READY_FIELDS.filter((f) => !same[f]);
}
