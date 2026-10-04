import { describe, expect, it } from 'vitest';
import { normalizeExtraction } from './normalize.ts';
import { isAutoReady, readingDifferences, sameMerchant } from './review.ts';
import type { ReceiptExtraction } from './schema.ts';

const reading = (over: Partial<ReceiptExtraction> = {}): ReceiptExtraction => ({
  documentType: 'receipt',
  merchant: { name: 'Blue Bottle Coffee', confidence: 'high' },
  date: { value: '2026-09-24', confidence: 'high' },
  currency: { code: 'USD', confidence: 'high' },
  total: { value: '6.50', confidence: 'high' },
  subtotal: null,
  fees: [],
  taxes: [],
  tip: null,
  cardLastFour: null,
  time: null,
  address: null,
  lineItems: [],
  ...over,
});
const n = (over: Partial<ReceiptExtraction> = {}) => normalizeExtraction(reading(over));
const UPLOADED = new Date('2026-09-24T18:00:00Z');

describe('isAutoReady', () => {
  it('needs merchant, date, currency and total read with high confidence', () => {
    expect(isAutoReady(n(), UPLOADED)).toBe(true);
    expect(isAutoReady(n({ total: { value: '6.50', confidence: 'medium' } }), UPLOADED)).toBe(
      false,
    );
    expect(isAutoReady(n({ merchant: null }), UPLOADED)).toBe(false);
  });

  it('never files a reading with an unreadable value', () => {
    expect(isAutoReady(n({ total: { value: '6.505', confidence: 'high' } }), UPLOADED)).toBe(false);
  });
});

describe('readingDifferences', () => {
  it('agrees when the filing fields match, allowing loose merchant names', () => {
    expect(
      readingDifferences(n(), n({ merchant: { name: 'BLUE BOTTLE', confidence: 'low' } })),
    ).toEqual([]);
  });

  it('names each field that differs', () => {
    const other = n({
      total: { value: '65.00', confidence: 'high' },
      date: { value: '2026-09-25', confidence: 'high' },
    });
    expect(readingDifferences(n(), other)).toEqual(['date', 'total']);
  });

  it('treats one empty field as a difference and two as agreement', () => {
    expect(readingDifferences(n(), n({ merchant: null }))).toEqual(['merchant']);
    expect(readingDifferences(n({ date: null }), n({ date: null }))).toEqual([]);
  });
});

describe('sameMerchant', () => {
  it.each([
    ['Blue Bottle Coffee', 'BLUE BOTTLE COFFEE INC'],
    ['Marriott & Co', 'Marriott and Co'],
  ])('matches %s and %s', (a, b) => expect(sameMerchant(a, b)).toBe(true));

  it('does not match different businesses', () => {
    expect(sameMerchant('Shell', 'Starbucks')).toBe(false);
  });
});
