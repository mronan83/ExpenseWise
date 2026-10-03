import { describe, expect, it } from 'vitest';
import {
  applyExpenseEdit,
  isComplete,
  NO_VALUES,
  receiptExpenseStatus,
  type ExpenseValues,
} from './expense-values.ts';
import { EXPENSE_STATUSES } from './lifecycle/expense.ts';

const coffee: ExpenseValues = {
  merchant: 'Blue Bottle Coffee',
  transactionDate: '2026-09-24',
  currency: 'USD',
  amountMinor: 650,
};

describe('isComplete', () => {
  it('needs merchant, date, currency and amount', () => {
    expect(isComplete(coffee)).toBe(true);
    expect(isComplete(NO_VALUES)).toBe(false);
    expect(isComplete({ ...coffee, merchant: '  ' })).toBe(false);
    expect(isComplete({ ...coffee, amountMinor: null })).toBe(false);
  });
});

describe('receiptExpenseStatus', () => {
  it('is Ready only when the receipt is Ready and the claim is complete', () => {
    expect(receiptExpenseStatus('processing', 'extracted', coffee)).toBe('ready');
    expect(receiptExpenseStatus('processing', 'extracted', NO_VALUES)).toBe('needs_review');
    expect(receiptExpenseStatus('ready', 'needs_review', coffee)).toBe('needs_review');
    expect(receiptExpenseStatus(null, 'failed', coffee)).toBe('needs_review');
  });

  it('is processing while the receipt is read, whatever it was', () => {
    expect(receiptExpenseStatus(null, 'processing', NO_VALUES)).toBe('processing');
    expect(receiptExpenseStatus('ready', 'processing', coffee)).toBe('processing');
  });

  it('leaves a submitted, approved or settled expense alone', () => {
    const moved = EXPENSE_STATUSES.filter(
      (s) => receiptExpenseStatus(s, 'extracted', coffee) === null,
    );
    expect(moved).toEqual(['submitted', 'approved', 'settled']);
  });
});

describe('applyExpenseEdit', () => {
  it('applies each field and lists what changed, amounts as decimals', () => {
    const result = applyExpenseEdit(coffee, {
      merchant: '  Blue Bottle  ',
      amount: '7.25',
      date: '2026-09-25',
    });
    expect(result).toEqual({
      ok: true,
      value: {
        values: {
          ...coffee,
          merchant: 'Blue Bottle',
          transactionDate: '2026-09-25',
          amountMinor: 725,
        },
        changes: [
          { field: 'merchant', from: 'Blue Bottle Coffee', to: 'Blue Bottle' },
          { field: 'date', from: '2026-09-24', to: '2026-09-25' },
          { field: 'amount', from: '6.50', to: '7.25' },
        ],
      },
    });
  });

  it('does not count a value entered unchanged as a change', () => {
    const result = applyExpenseEdit(coffee, { amount: '6.5', currency: 'usd' });
    expect(result.ok && result.value.changes).toEqual([]);
  });

  it('fills an empty expense in by hand', () => {
    const result = applyExpenseEdit(NO_VALUES, {
      merchant: 'Corner Store',
      date: '2026-10-01',
      currency: 'EUR',
      amount: '4.20',
    });
    expect(result.ok && result.value.values).toEqual({
      merchant: 'Corner Store',
      transactionDate: '2026-10-01',
      currency: 'EUR',
      amountMinor: 420,
    });
    expect(result.ok && result.value.changes.map((c) => [c.field, c.from])).toEqual([
      ['merchant', null],
      ['date', null],
      ['currency', null],
      ['amount', null],
    ]);
  });

  it('keeps the amount as written when the currency is corrected', () => {
    const result = applyExpenseEdit(coffee, { currency: 'CAD' });
    expect(result.ok && result.value.values).toMatchObject({ currency: 'CAD', amountMinor: 650 });
    expect(result.ok && result.value.changes).toEqual([
      { field: 'currency', from: 'USD', to: 'CAD' },
    ]);
  });

  it('refuses an amount the corrected currency cannot hold, rather than rounding', () => {
    expect(applyExpenseEdit(coffee, { currency: 'JPY' })).toEqual({
      ok: false,
      error: { field: 'amount', message: "The amount doesn't fit JPY; enter it again." },
    });
    const fixed = applyExpenseEdit(coffee, { currency: 'JPY', amount: '650' });
    expect(fixed.ok && fixed.value.values.amountMinor).toBe(650);
  });

  it('needs a currency before an amount', () => {
    expect(applyExpenseEdit(NO_VALUES, { amount: '4.20' })).toMatchObject({
      ok: false,
      error: { field: 'currency' },
    });
  });

  it.each([
    [{ merchant: '   ' }, 'merchant'],
    [{ merchant: 'x'.repeat(201) }, 'merchant'],
    [{ date: '2026-02-30' }, 'date'],
    [{ currency: 'XYZ' }, 'currency'],
    [{ currency: '' }, 'currency'],
    [{ amount: '6.505' }, 'amount'],
    [{ amount: '1,000' }, 'amount'],
    [{ amount: '-1.00' }, 'amount'],
  ] as const)('refuses %o as a value for %s', (edit, field) => {
    expect(applyExpenseEdit(coffee, edit)).toMatchObject({ ok: false, error: { field } });
  });
});
