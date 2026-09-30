import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  EXPENSE_STATUSES,
  initialExpenseStatus,
  isExpenseEditable,
  isExpenseLocked,
  transitionExpense,
  type ExpenseEvent,
  type ExpenseStatus,
} from './expense.ts';

const events: ExpenseEvent[] = [
  { type: 'extraction_confident' },
  { type: 'extraction_unsure', reasons: ['date unreadable'] },
  { type: 'extraction_failed', reason: 'timeout' },
  { type: 'user_confirmed' },
  { type: 'report_submitted' },
  { type: 'report_returned' },
  { type: 'report_approved' },
  { type: 'settled' },
];
const byType = (type: ExpenseEvent['type']) => events.find((e) => e.type === type)!;

describe('expense lifecycle', () => {
  it.each<[ExpenseStatus, ExpenseEvent['type'], ExpenseStatus]>([
    ['processing', 'extraction_confident', 'ready'],
    ['processing', 'extraction_unsure', 'needs_review'],
    ['processing', 'extraction_failed', 'needs_review'],
    ['needs_review', 'user_confirmed', 'ready'],
    ['ready', 'report_submitted', 'submitted'],
    ['submitted', 'report_returned', 'ready'],
    ['submitted', 'report_approved', 'approved'],
    ['approved', 'settled', 'settled'],
  ])('%s --%s--> %s', (from, type, to) => {
    expect(transitionExpense(from, byType(type))).toEqual({ ok: true, value: to });
  });

  it('rejects everything else', () => {
    expect(transitionExpense('ready', byType('report_approved'))).toEqual({
      ok: false,
      error: { code: 'illegal_transition', from: 'ready', event: 'report_approved' },
    });
    for (const event of events) expect(transitionExpense('settled', event).ok).toBe(false);
  });

  it('starts receipt captures in processing and typed entries in ready', () => {
    expect(initialExpenseStatus('camera')).toBe('processing');
    expect(initialExpenseStatus('upload')).toBe('processing');
    expect(initialExpenseStatus('email')).toBe('processing');
    expect(initialExpenseStatus('manual')).toBe('ready');
    expect(initialExpenseStatus('mileage')).toBe('ready');
    expect(initialExpenseStatus('card')).toBe('ready');
  });

  it('allows edits only before submission and locks approved records', () => {
    const editable = EXPENSE_STATUSES.filter(isExpenseEditable);
    const locked = EXPENSE_STATUSES.filter(isExpenseLocked);
    expect(editable).toEqual(['needs_review', 'ready']);
    expect(locked).toEqual(['approved', 'settled']);
  });

  it('never reaches approved without passing through submitted, whatever the event order', () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...events), { maxLength: 40 }), (sequence) => {
        let status: ExpenseStatus = 'processing';
        let wasSubmitted = false;
        for (const event of sequence) {
          const next = transitionExpense(status, event);
          if (!next.ok) continue;
          if (next.value === 'approved') expect(wasSubmitted).toBe(true);
          if (next.value === 'submitted') wasSubmitted = true;
          status = next.value;
          expect(EXPENSE_STATUSES).toContain(status);
        }
      }),
    );
  });
});
