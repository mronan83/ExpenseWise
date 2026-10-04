import type { ExtractionRunRecord, ReceiptRecord } from '@expensewise/db';
import { captureMs, captureTime } from '@expensewise/domain';
import { sourcesOf } from '@expensewise/extraction';
import { latestRuns } from './receipt-views.ts';

/**
 * The line of the receipt each field of a reading was read from (GAP-14), keyed as the
 * reading's fields are. Null for a reading made without them: before the organization switched
 * `receipts.field-sources` on, or one that failed.
 */
export function sourcesView(run: ExtractionRunRecord | undefined) {
  const s = run && run.outcome !== 'failed' ? sourcesOf(run.output) : null;
  return s
    ? {
        merchant: s.merchant,
        date: s.date,
        time: s.time,
        address: s.address,
        currency: s.currency,
        total: s.total,
        subtotal: s.subtotal,
        taxTotal: s.taxes,
        tip: s.tip,
        fees: s.fees,
        cardLastFour: s.cardLastFour,
      }
    : null;
}

/**
 * A receipt's readings with the line each field was read from, for an organization that has
 * `receipts.field-sources` on. With it off the readings are shown as they always were, with no
 * `sources` at all.
 */
export function withSources<R extends { readonly model: string; readonly state: string }>(
  receipt: ReceiptRecord,
  runs: readonly ExtractionRunRecord[],
  readings: readonly R[],
): (R & { sources: ReturnType<typeof sourcesView> })[] {
  const latest = latestRuns(receipt.id, runs);
  return readings.map((reading) => ({
    ...reading,
    sources:
      reading.state === 'pending'
        ? null
        : sourcesView(latest.find((run) => run.model === reading.model)),
  }));
}

/**
 * The 95th-percentile time from capture to read over these receipts, with how many it is over
 * and the 30-second goal (NFR-PERF-01). A receipt still being read for the first time has no
 * time yet and doesn't count.
 */
export function captureTimeOf(receipts: readonly ReceiptRecord[]) {
  return captureTime(
    receipts.flatMap((r) => (r.settledAt ? [captureMs(r.createdAt, r.settledAt)] : [])),
  );
}
