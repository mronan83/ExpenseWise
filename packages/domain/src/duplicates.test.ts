import { describe, expect, it } from 'vitest';
import {
  DUPLICATE_TIME_WINDOW_MINUTES,
  DUPLICATE_WINDOW_MAX_MINUTES,
  duplicateKind,
  isDuplicateWindow,
  mergeExpenses,
  merchantWords,
  samePlace,
  similarMerchants,
  type MergeableExpense,
  type PurchaseFacts,
} from './duplicates.ts';
import type { ExpenseValues } from './expense-values.ts';

const claim: ExpenseValues = {
  merchant: 'Uber',
  transactionDate: '2026-10-02',
  currency: 'USD',
  amountMinor: 3142,
};
const ride: PurchaseFacts = { ...claim, time: null, address: null, city: null, country: null };
/** A dinner's itemized bill, and the card slip printed after it with the tip. */
const bill: PurchaseFacts = {
  merchant: 'Pappas Bros. Steakhouse',
  transactionDate: '2026-09-23',
  currency: 'USD',
  amountMinor: 9310,
  time: '19:58',
  address: '1200 McKinney St, Houston, TX 77010',
  city: 'Houston',
  country: 'US',
};
const slip: PurchaseFacts = { ...bill, time: '20:03', amountMinor: 10810 };

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

describe('where a purchase was', () => {
  it('is the same city, or addresses with the same words, street words spelled either way', () => {
    expect(samePlace(bill, { ...bill, city: 'HOUSTON' })).toBe(true);
    const unnamed = { ...bill, city: null };
    expect(
      samePlace(unnamed, { ...unnamed, address: '1200 MCKINNEY STREET, HOUSTON TX 77010' }),
    ).toBe(true);
    expect(samePlace(unnamed, { ...unnamed, address: '5839 Westheimer Rd, Houston' })).toBe(false);
  });

  it('is somewhere else in another city or country, and unknown when either doesn’t say', () => {
    expect(samePlace(bill, { ...bill, city: 'Dallas' })).toBe(false);
    expect(samePlace(bill, { ...bill, country: 'CA' })).toBe(false);
    expect(samePlace(bill, { ...bill, city: null, address: null })).toBeNull();
  });
});

describe('the same purchase filed twice (FR-INT-18)', () => {
  it('is exact when the time, place and total are all the same', () => {
    expect(duplicateKind(bill, { ...bill, merchant: 'Pappas Bros Steakhouse' })).toBe('exact');
  });

  it('is possible when the total differs at the same time and place, as with a tip added', () => {
    expect(duplicateKind(bill, slip)).toBe('possible');
    expect(duplicateKind(bill, { ...bill, time: '20:10' })).toBe('possible');
  });

  it('is two purchases when they say different times, places or days, whatever the total', () => {
    expect(duplicateKind(bill, { ...bill, time: '13:05' })).toBeNull();
    expect(duplicateKind(bill, { ...bill, city: 'Dallas' })).toBeNull();
    expect(duplicateKind(bill, { ...bill, transactionDate: '2026-09-24' })).toBeNull();
    expect(duplicateKind(bill, { ...bill, merchant: 'Bayside Grill' })).toBeNull();
  });

  it('needs the total to match when only the time is known on both', () => {
    const unplaced = { ...bill, address: null, city: null, country: null };
    expect(duplicateKind(unplaced, { ...unplaced })).toBe('exact');
    expect(duplicateKind(unplaced, { ...unplaced, amountMinor: 10810 })).toBeNull();
  });

  it('falls back to the total and a day either way without a time on both (Q18)', () => {
    expect(duplicateKind(ride, { ...ride, merchant: 'Uber Technologies' })).toBe('possible');
    expect(duplicateKind(ride, { ...ride, transactionDate: '2026-10-03' })).toBe('possible');
    expect(duplicateKind(ride, { ...ride, time: '18:42' })).toBe('possible');
    expect(duplicateKind(ride, { ...ride, amountMinor: 3143 })).toBeNull();
    expect(duplicateKind(ride, { ...ride, currency: 'CAD' })).toBeNull();
    expect(duplicateKind(ride, { ...ride, merchant: 'Lyft' })).toBeNull();
    expect(duplicateKind(ride, { ...ride, transactionDate: '2026-10-04' })).toBeNull();
  });

  it('never matches on a guess: the merchant and the date must be known on both', () => {
    expect(duplicateKind(ride, { ...ride, merchant: null })).toBeNull();
    expect(duplicateKind({ ...ride, transactionDate: null }, ride)).toBeNull();
    expect(duplicateKind({ ...bill, merchant: null }, bill)).toBeNull();
  });
});

describe('the duplicate time window (FR-INT-19)', () => {
  const later = (time: string): PurchaseFacts => ({ ...bill, time });

  it('is 30 minutes unless the owner sets another, from 0 to 120 whole minutes', () => {
    expect(DUPLICATE_TIME_WINDOW_MINUTES).toBe(30);
    expect(duplicateKind(bill, later('20:28'))).toBe('possible');
    expect(duplicateKind(bill, later('20:29'))).toBeNull();
    expect([0, 1, 30, DUPLICATE_WINDOW_MAX_MINUTES].every(isDuplicateWindow)).toBe(true);
    expect([-1, 121, 2.5, Number.NaN].some(isDuplicateWindow)).toBe(false);
  });

  it('judges a pair by the window it is given: wider catches more, narrower less', () => {
    expect(duplicateKind(bill, later('20:58'), 60)).toBe('possible');
    expect(duplicateKind(bill, later('20:59'), 60)).toBeNull();
    expect(duplicateKind(bill, slip, 5)).toBe('possible');
    expect(duplicateKind(bill, slip, 4)).toBeNull();
  });

  it('at 0 is the same minute only, exact or possible', () => {
    expect(duplicateKind(bill, bill, 0)).toBe('exact');
    expect(duplicateKind(bill, { ...bill, amountMinor: 10810 }, 0)).toBe('possible');
    expect(duplicateKind(bill, later('19:59'), 0)).toBeNull();
  });
});

describe('merging a duplicate into the primary', () => {
  const primary: MergeableExpense = { ...claim, notes: null, tripId: null };
  const duplicate: MergeableExpense = {
    ...claim,
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
