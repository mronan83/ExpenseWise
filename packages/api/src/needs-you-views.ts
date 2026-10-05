import type {
  DuplicatePairRecord,
  ExpenseRecord,
  ExtractionRunRecord,
  ReceiptRecord,
  ReceiptReviewRecord,
} from '@expensewise/db';
import type { CategoryStore, UncodedNeedingYou } from './categories.ts';
import { expenseCategory, type ExpenseCategory } from './category-views.ts';
import type { FeatureGate } from './features.ts';
import { amountView, inboxItem } from './receipt-views.ts';
import { reportItem, unjustifiedItem } from './report-views.ts';
import type { ReportsNeedingYou } from './reports.ts';
import { unfiledEmailItem } from './unfiled-emails.ts';

export interface ReceiptsNeedingYou {
  readonly receipts: readonly ReceiptRecord[];
  readonly runs: readonly ExtractionRunRecord[];
  readonly reviews: readonly ReceiptReviewRecord[];
  readonly pairs: readonly DuplicatePairRecord[];
}

/**
 * Whether Needs you asks for categories and types (Q27): where categories can be on, and are
 * on for the organization. Off, Needs you reads nothing more and shows what it always has.
 */
export async function askForCoding(
  options: { readonly categories?: CategoryStore },
  features: FeatureGate,
  orgId: string,
): Promise<boolean> {
  return options.categories !== undefined && (await features.isOn(orgId, 'expenses.categories'));
}

/**
 * An expense as Needs you shows it when it has no category and type (FR-EXP-11, Q27), with
 * the one suggested for it, if any, to confirm with a tap on its page.
 */
export function uncodedItem(expense: ExpenseRecord, category: ExpenseCategory) {
  return {
    kind: 'expense' as const,
    expense: {
      id: expense.id,
      merchant: expense.merchant,
      date: expense.transactionDate,
      amount: amountView(expense.amountMinor, expense.currency),
      receiptId: expense.receiptId,
    },
    reason: { code: 'uncoded' as const },
    category,
  };
}

/** Each expense with no category and type, oldest first, with what is suggested for it. */
function uncodedItems(uncoded: UncodedNeedingYou | undefined) {
  if (!uncoded) return [];
  const { receipts, runs, reviews, classifying } = uncoded;
  return uncoded.expenses.map((expense) => {
    const receipt = receipts.find((r) => r.id === expense.receiptId);
    const proof = receipt ? { receipt, runs, reviews } : null;
    return uncodedItem(expense, expenseCategory(expense, proof, classifying));
  });
}

/**
 * Everything in Needs you, in the order to do it (FR-EXP-02): a report that is overdue or in
 * its last week with something left, then receipts that need a look, newest first, then,
 * while they are on, emails that filed nothing, newest first (#59), then local expenses that
 * need a justification, oldest first, then, while categories are on, expenses with no category
 * and type, oldest first (Q27), then reports ready to close. With `converting`, reports total
 * in their reimbursement currency (FR-EXP-13).
 */
export function needsYouItems(
  receipts: ReceiptsNeedingYou,
  reports: ReportsNeedingYou,
  now: Date,
  /** Whether the organization reads under its AI model settings (receipts.model-settings). */
  settingsOn = false,
  converting = false,
) {
  const receiptItems = receipts.receipts
    .map((r) => inboxItem(r, receipts.runs, receipts.reviews, receipts.pairs, settingsOn))
    .filter((item) => item !== null);
  const reportItems = reports.reports
    .map((r) => reportItem(r, now, converting))
    .filter((item) => item !== null);
  return [
    ...reportItems.filter((i) => i.reason.code !== 'ready_to_close'),
    ...receiptItems,
    ...(reports.emails ?? []).map(unfiledEmailItem),
    ...reports.unjustified.map(unjustifiedItem),
    ...uncodedItems(reports.uncoded),
    ...reportItems.filter((i) => i.reason.code === 'ready_to_close'),
  ];
}

export const NO_REPORTS: ReportsNeedingYou = { reports: [], unjustified: [] };
