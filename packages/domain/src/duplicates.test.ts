import { describe, expect, it } from 'vitest';
import {
  looksLikeSamePurchase,
  mergeExpenses,
  merchantWords,
  similarMerchants,
  type MergeableExpense,
} from './duplicates.ts';
import type { ExpenseValues } from './expense-values.ts';

const ride: ExpenseValues = {
  merchant: 'Uber',
  transactionDate: '2026-10-02',
  currency: 'USD',
  amountMinor: 3142,
};

describe('merchant names', () => {
  it('reduces a name to its words, without case, accents, punctuation or company suffixes', () => {
    expect(merchantWords('Café Rouge, Inc.')).toEqual(['cafe', 'rouge']);
    expect(merchantWords('The Ritz-Carlton')).toEqual(['ritz', 'carlton']);
  });

  it('treats a shorter name inside a longer one, or the same words run together, as one business', () => {
    expect(similarMerchants('Uber', 'Uber Technologies Inc.')).toBe(true);
    expect(similarMerchants('Blue Bottle', 'BlueBottle Coffee')).toBe(false);
    expect(similarMerchants('Blue Bottle', 'BlueBottle')).toBe(true);
    expect(similarMerchants('UBER *TRIP', 'Uber')).toBe(true);
  });

  it('tells different businesses apart', () => {
    expect(similarMerchants('Uber', 'Lyft')).toBe(false);
    expect(similarMerchants('Blue Bottle Coffee', 'Verve Coffee')).toBe(false);
    expect(similarMerchants('Inc.', 'Uber')).toBe(false);
  });
});

describe('the same purchase filed twice', () => {
  it('matches the same currency and total, a day apart at most, from a similar merchant', () => {
    expect(looksLikeSamePurchase(ride, { ...ride, merchant: 'Uber Technologies' })).toBe(true);
    expect(looksLikeSamePurchase(ride, { ...ride, transactionDate: '2026-10-03' })).toBe(true);
  });

  it('does not match a different total, currency, merchant, or dates two days apart', () => {
    expect(looksLikeSamePurchase(ride, { ...ride, amountMinor: 3143 })).toBe(false);
    expect(looksLikeSamePurchase(ride, { ...ride, currency: 'CAD' })).toBe(false);
    expect(looksLikeSamePurchase(ride, { ...ride, merchant: 'Lyft' })).toBe(false);
    expect(looksLikeSamePurchase(ride, { ...ride, transactionDate: '2026-10-04' })).toBe(false);
  });

  it('never matches on a guess: every field must be known on both', () => {
    expect(looksLikeSamePurchase(ride, { ...ride, merchant: null })).toBe(false);
    expect(looksLikeSamePurchase({ ...ride, transactionDate: null }, ride)).toBe(false);
  });
});

describe('merging a duplicate into the primary', () => {
  const primary: MergeableExpense = { ...ride, notes: null, tripId: null };
  const duplicate: MergeableExpense = {
    ...ride,
    merchant: 'Uber Technologies',
    transactionDate: '2026-10-03',
    notes: 'Airport to office',
    tripId: 'trip-1',
  };

  it('fills what the primary lacks and keeps what it has', () => {
    const { merged, taken } = mergeExpenses(primary, duplicate, []);
    expect(merged).toEqual({ ...primary, notes: 'Airport to office', tripId: 'trip-1' });
    expect(taken).toEqual(['notes', 'trip']);
  });

  it('takes the fields the person chose, an amount with its currency', () => {
    const { merged, taken } = mergeExpenses(
      primary,
      { ...duplicate, currency: 'CAD', amountMinor: 4300 },
      ['merchant', 'date', 'amount'],
    );
    expect(merged).toMatchObject({
      merchant: 'Uber Technologies',
      transactionDate: '2026-10-03',
      currency: 'CAD',
      amountMinor: 4300,
    });
    expect(taken).toEqual(['merchant', 'date', 'amount', 'notes', 'trip']);
  });

  it('never takes a blank: a chosen field the duplicate lacks stays as it was', () => {
    const { merged, taken } = mergeExpenses(
      { ...primary, notes: 'Mine' },
      { ...duplicate, notes: '  ' },
      ['notes'],
    );
    expect(merged.notes).toBe('Mine');
    expect(taken).toEqual(['trip']);
  });
});
