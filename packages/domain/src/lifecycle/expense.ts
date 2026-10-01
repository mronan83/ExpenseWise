import { err, ok, type Result } from '../result.ts';

export const EXPENSE_STATUSES = [
  'processing',
  'needs_review',
  'ready',
  'submitted',
  'approved',
  'settled',
] as const;
export type ExpenseStatus = (typeof EXPENSE_STATUSES)[number];

export const EXPENSE_SOURCES = ['camera', 'upload', 'email', 'card', 'manual', 'mileage'] as const;
export type ExpenseSource = (typeof EXPENSE_SOURCES)[number];

export type ExpenseEvent =
  | { readonly type: 'extraction_confident' }
  | { readonly type: 'extraction_unsure'; readonly reasons: readonly string[] }
  | { readonly type: 'extraction_failed'; readonly reason: string }
  | { readonly type: 'user_confirmed' }
  | { readonly type: 'report_submitted' }
  | { readonly type: 'report_returned' }
  | { readonly type: 'report_approved' }
  | { readonly type: 'settled' };

export interface ExpenseTransitionError {
  readonly code: 'illegal_transition';
  readonly from: ExpenseStatus;
  readonly event: ExpenseEvent['type'];
}

// See docs/03-journeys-and-workflows.md (lifecycles). Anything not listed is illegal.
const TRANSITIONS: {
  readonly [S in ExpenseStatus]: Partial<Record<ExpenseEvent['type'], ExpenseStatus>>;
} = {
  processing: {
    extraction_confident: 'ready',
    extraction_unsure: 'needs_review',
    extraction_failed: 'needs_review',
  },
  needs_review: { user_confirmed: 'ready' },
  ready: { report_submitted: 'submitted' },
  submitted: { report_approved: 'approved', report_returned: 'ready' },
  approved: { settled: 'settled' },
  settled: {},
};

export function transitionExpense(
  from: ExpenseStatus,
  event: ExpenseEvent,
): Result<ExpenseStatus, ExpenseTransitionError> {
  const to = TRANSITIONS[from][event.type];
  return to === undefined ? err({ code: 'illegal_transition', from, event: event.type }) : ok(to);
}

/** Receipt-based expenses wait for extraction; typed-in ones start ready. */
export function initialExpenseStatus(source: ExpenseSource): ExpenseStatus {
  return source === 'camera' || source === 'upload' || source === 'email' ? 'processing' : 'ready';
}

/** Fields may change only before submission. */
export function isExpenseEditable(status: ExpenseStatus): boolean {
  return status === 'needs_review' || status === 'ready';
}

/** Approved records never change; corrections are a reversal plus a new version. */
export function isExpenseLocked(status: ExpenseStatus): boolean {
  return status === 'approved' || status === 'settled';
}
