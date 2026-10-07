import type { ExpenseAmount } from './expenses';

/** A receipt's lines under the expense's total, and excluding them (FR-INT-22, FR-EXP-16). */
export const ITEMIZED_FLAG = 'expenses.itemized';
/** Splitting an expense into parts by category and type (FR-EXP-15); needs categories on. */
export const SPLIT_FLAG = 'expenses.split';
/** A receipt's several purchases, each left out whole (FR-INT-23, FR-EXP-20). */
export const PURCHASES_FLAG = 'receipts.purchases';

export type ExclusionReason = 'personal' | 'paid_by_someone_else' | 'not_reimbursable' | 'other';

export const EXCLUSION_REASONS: { value: ExclusionReason; label: string }[] = [
  { value: 'personal', label: 'Personal' },
  { value: 'paid_by_someone_else', label: 'Paid by someone else' },
  { value: 'not_reimbursable', label: 'Not reimbursable' },
  { value: 'other', label: 'Other' },
];

export const reasonLabel = (reason: ExclusionReason) =>
  EXCLUSION_REASONS.find((r) => r.value === reason)?.label ?? reason;

/** The longest note on an excluded line, as the API holds it (R-EXCLUSION-NOTE-MAX). */
export const EXCLUSION_NOTE_MAX = 200;

export interface ItemizedLine {
  /** Its number on the receipt, from 1. */
  position: number;
  kind: 'item' | 'tax' | 'fee' | 'tip';
  description: string;
  quantity: string | null;
  amount: ExpenseAmount;
  /** An item's share of the tax, tip and fees; null for the rest, or while they don't add up. */
  share: ExpenseAmount | null;
  claimed: ExpenseAmount | null;
  excluded: { reason: ExclusionReason; note: string | null; at: string } | null;
  /** The purchase it belongs to, from 1, on a receipt of several; null on one of one. */
  purchase: number | null;
  part: { categoryId: string; typeId: string } | null;
}

/** One of several purchases a receipt holds, such as a ticket and a seat upgrade (FR-INT-23). */
export interface ItemizedPurchase {
  number: number;
  description: string;
  /** The day it was bought, YYYY-MM-DD. */
  date: string | null;
  cardLastFour: string | null;
  total: ExpenseAmount | null;
  /** Its items with their shares of its own taxes and fees; null while lines don't add up. */
  claimed: ExpenseAmount | null;
  /** Its lines, by position. */
  lines: number[];
  /** Why the whole purchase is left out; null while any of it is claimed. */
  excluded: { reason: ExclusionReason; note: string | null } | null;
}

/** An expense's itemized lines, while the feature is on; null for a receipt without lines. */
export interface Itemized {
  currency: string;
  total: ExpenseAmount | null;
  subtotal: ExpenseAmount | null;
  lines: ItemizedLine[];
  /** The purchases its receipt holds, when two or more; empty for a receipt of one. */
  purchases: ItemizedPurchase[];
  addsUp: boolean;
  problem: { code: string; message: string } | null;
  claim: { receipt: ExpenseAmount; excluded: ExpenseAmount; claimed: ExpenseAmount } | null;
  /** Whether lines can be excluded and split by line now, and why not. */
  byLine: { usable: boolean; code: string | null; message: string | null };
}

export interface ExpensePart {
  position: number;
  /** The lines left with the expense's own category and type. */
  own: boolean;
  category: { id: string; name: string } | null;
  type: { id: string; name: string } | null;
  amount: ExpenseAmount;
  lines: number[];
}

/** An expense's split, while the feature is on; null when it isn't split. */
export interface ExpenseSplit {
  basis: 'lines' | 'amounts';
  parts: ExpensePart[];
}

/** A report's spend under one category and type (FR-EXP-15). */
export interface CategoryTotal {
  category: { id: string; name: string } | null;
  type: { id: string; name: string } | null;
  totals: ExpenseAmount[];
  reimbursed?: ExpenseAmount | null;
  converting?: number;
}

export interface ReportCategories {
  reportId: string;
  currency: string;
  rows: CategoryTotal[];
}
