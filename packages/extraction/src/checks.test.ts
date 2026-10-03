import { describe, expect, it } from 'vitest';
import { addsUp, readingChecks } from './checks.ts';
import { normalizeExtraction } from './normalize.ts';
import { isAutoReady } from './review.ts';
import type { ReceiptExtraction } from './schema.ts';

const amount = (value: string) => ({ value, confidence: 'high' as const });
const tax = (value: string, label = 'Sales tax') => ({ label, value, confidence: 'high' as const });

// 45.50 + 3.93 + 0.50 + 8.50 = 58.43
const base: ReceiptExtraction = {
  documentType: 'receipt',
  merchant: { name: 'Bayside Grill', confidence: 'high' },
  date: { value: '2026-09-14', confidence: 'high' },
  currency: { code: 'USD', confidence: 'high' },
  total: amount('58.43'),
  subtotal: amount('45.50'),
  taxes: [tax('3.93'), tax('0.50', 'City tax')],
  tip: amount('8.50'),
  cardLastFour: null,
  lineItems: [],
};
const read = (over: Partial<ReceiptExtraction> = {}) => normalizeExtraction({ ...base, ...over });
const UPLOADED = new Date('2026-10-03T15:00:00Z');

describe('addsUp', () => {
  it('passes when the subtotal, taxes and tip make the total', () => {
    expect(addsUp(read())).toBe(true);
  });

  it('allows a minor unit for each tax or tip line, and no more', () => {
    // Two taxes and a tip: three lines, each rounded on its own.
    expect(addsUp(read({ total: amount('58.46') }))).toBe(true);
    expect(addsUp(read({ total: amount('58.40') }))).toBe(true);
    expect(addsUp(read({ total: amount('58.47') }))).toBe(false);
    // With no tax or tip line there is nothing to round: the subtotal is the total.
    expect(addsUp(read({ total: amount('45.51'), taxes: [], tip: null }))).toBe(false);
    expect(addsUp(read({ total: amount('45.50'), taxes: [], tip: null }))).toBe(true);
  });

  it('counts minor units in the currency, so a yen is the unit for JPY', () => {
    const yen = {
      currency: { code: 'JPY', confidence: 'high' as const },
      subtotal: amount('1000'),
      taxes: [tax('100')],
      tip: null,
    };
    expect(addsUp(read({ ...yen, total: amount('1101') }))).toBe(true);
    expect(addsUp(read({ ...yen, total: amount('1102') }))).toBe(false);
  });

  it('accepts prices that include their tax, as VAT receipts print them', () => {
    const vat = { subtotal: amount('12.00'), taxes: [tax('2.00', 'VAT 20%')], tip: null };
    expect(addsUp(read({ ...vat, total: amount('12.00') }))).toBe(true);
    expect(addsUp(read({ ...vat, total: amount('14.00') }))).toBe(true);
    expect(addsUp(read({ ...vat, total: amount('13.00') }))).toBe(false);
  });

  it('fails when a line was most likely missed', () => {
    // The tip is on the receipt, and the reading missed it.
    expect(addsUp(read({ tip: null }))).toBe(false);
  });

  it('has nothing to add up without a subtotal or a total', () => {
    expect(addsUp(read({ subtotal: null }))).toBeNull();
    expect(addsUp(read({ total: null }))).toBeNull();
  });
});

describe('readingChecks', () => {
  const dated = (value: string) => read({ date: { value, confidence: 'high' } });

  it('passes a plausible reading', () => {
    expect(readingChecks(read(), UPLOADED)).toEqual([]);
  });

  it('names the sums when the parts do not make the total', () => {
    expect(readingChecks(read({ total: amount('60.43') }), UPLOADED)).toEqual(['sums']);
  });

  it('allows the merchant’s day to run one ahead of the upload’s, and no more', () => {
    expect(readingChecks(dated('2026-10-04'), UPLOADED)).toEqual([]);
    expect(readingChecks(dated('2026-10-05'), UPLOADED)).toEqual(['future_date']);
    // Late in the UTC day, the next day is still only one ahead.
    expect(readingChecks(dated('2026-10-04'), new Date('2026-10-03T23:59:00Z'))).toEqual([]);
  });

  it('flags a date more than a year before the upload', () => {
    expect(readingChecks(dated('2025-10-03'), UPLOADED)).toEqual([]);
    expect(readingChecks(dated('2025-10-02'), UPLOADED)).toEqual(['old_date']);
    expect(readingChecks(dated('2016-09-30'), UPLOADED)).toEqual(['old_date']);
  });

  it('reports every check that fails', () => {
    const both = read({
      total: amount('60.43'),
      date: { value: '2027-01-01', confidence: 'high' },
    });
    expect(readingChecks(both, UPLOADED)).toEqual(['sums', 'future_date']);
  });

  it('has nothing to check without a date', () => {
    expect(readingChecks(read({ date: null }), UPLOADED)).toEqual([]);
  });
});

describe('the Ready rule with the checks', () => {
  it('needs the sums and the date to pass as well as confidence', () => {
    expect(isAutoReady(read(), UPLOADED)).toBe(true);
    expect(isAutoReady(read({ tip: null }), UPLOADED)).toBe(false);
    expect(isAutoReady(read({ date: { value: '2026-11-03', confidence: 'high' } }), UPLOADED)).toBe(
      false,
    );
    expect(isAutoReady(read({ date: { value: '2024-10-03', confidence: 'high' } }), UPLOADED)).toBe(
      false,
    );
  });
});
