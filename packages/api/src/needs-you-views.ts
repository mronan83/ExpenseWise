import type {
  DuplicatePairRecord,
  ExtractionRunRecord,
  ReceiptRecord,
  ReceiptReviewRecord,
} from '@expensewise/db';
import { inboxItem } from './receipt-views.ts';
import { reportItem, unjustifiedItem } from './report-views.ts';
import type { ReportsNeedingYou } from './reports.ts';

export interface ReceiptsNeedingYou {
  readonly receipts: readonly ReceiptRecord[];
  readonly runs: readonly ExtractionRunRecord[];
  readonly reviews: readonly ReceiptReviewRecord[];
  readonly pairs: readonly DuplicatePairRecord[];
}

/**
 * Everything in Needs you, in the order to do it (FR-EXP-02): a report that is overdue or in
 * its last week with something left, then receipts that need a look, newest first, then local
 * expenses that need a justification, oldest first, then reports ready to close.
 */
export function needsYouItems(
  receipts: ReceiptsNeedingYou,
  reports: ReportsNeedingYou,
  now: Date,
  /** Whether the organization reads under its AI model settings (receipts.model-settings). */
  settingsOn = false,
) {
  const receiptItems = receipts.receipts
    .map((r) => inboxItem(r, receipts.runs, receipts.reviews, receipts.pairs, settingsOn))
    .filter((item) => item !== null);
  const reportItems = reports.reports
    .map((r) => reportItem(r, now))
    .filter((item) => item !== null);
  return [
    ...reportItems.filter((i) => i.reason.code !== 'ready_to_close'),
    ...receiptItems,
    ...reports.unjustified.map(unjustifiedItem),
    ...reportItems.filter((i) => i.reason.code === 'ready_to_close'),
  ];
}

export const NO_REPORTS: ReportsNeedingYou = { reports: [], unjustified: [] };
