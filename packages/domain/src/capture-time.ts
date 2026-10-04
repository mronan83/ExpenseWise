/**
 * How long receipts take from capture to being read (NFR-PERF-01): the time from filing a
 * receipt to its first settlement, in whole milliseconds, and the 95th percentile of it.
 */

/** The goal: 95 of every 100 receipts read within 30 seconds of capture (NFR-PERF-01). */
export const CAPTURE_TO_READY_SLO_MS = 30_000;

/** The percentile the goal is held at. */
export const CAPTURE_TO_READY_PERCENTILE = 95;

/**
 * The p-th percentile of whole-millisecond durations, by the nearest-rank method: the
 * smallest duration with at least p in every 100 at or below it. It is always one of the
 * durations measured, so it stays whole milliseconds and is never interpolated. Null when
 * there are none.
 */
export function percentile(durations: readonly number[], p: number): number | null {
  if (!Number.isInteger(p) || p < 1 || p > 100) {
    throw new RangeError(`A percentile is a whole number from 1 to 100, not ${p}`);
  }
  for (const d of durations) {
    if (!Number.isSafeInteger(d) || d < 0) {
      throw new RangeError(`A duration is whole milliseconds, zero or more, not ${d}`);
    }
  }
  if (durations.length === 0) return null;
  const sorted = [...durations].sort((a, b) => a - b);
  // The rank is p% of the count, rounded up, in whole numbers: ceil(p * n / 100).
  const rank = Math.floor((p * sorted.length + 99) / 100);
  return sorted[rank - 1] ?? null;
}

/** Whole milliseconds from filing a receipt to its settlement; never less than zero. */
export function captureMs(filedAt: Date, settledAt: Date): number {
  return Math.max(0, settledAt.getTime() - filedAt.getTime());
}

/** The 95th-percentile time from capture to read, over these receipts, against the goal. */
export interface CaptureTime {
  /** How many receipts it is over: those that have settled. */
  readonly receipts: number;
  readonly p95Ms: number | null;
  readonly sloMs: number;
  /** Whether the 95th percentile is under the goal; null with nothing measured. */
  readonly withinSlo: boolean | null;
}

/** The 95th percentile of these receipts' times from capture to read, against the goal. */
export function captureTime(durations: readonly number[]): CaptureTime {
  const p95Ms = percentile(durations, CAPTURE_TO_READY_PERCENTILE);
  return {
    receipts: durations.length,
    p95Ms,
    sloMs: CAPTURE_TO_READY_SLO_MS,
    withinSlo: p95Ms === null ? null : p95Ms < CAPTURE_TO_READY_SLO_MS,
  };
}
