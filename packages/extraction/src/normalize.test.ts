import { money } from '@expensewise/domain';
import { describe, expect, it } from 'vitest';
import { assumedZeros, normalizeExtraction } from './normalize.ts';
import type { ReceiptExtraction } from './schema.ts';

const base: ReceiptExtraction = {
  documentType: 'receipt',
  merchant: { name: '  Bayside Grill ', confidence: 'high' },
  date: { value: '2026-09-14', confidence: 'high' },
  currency: { code: 'usd', confidence: 'high' },
  total: { value: '58.43', confidence: 'high' },
  subtotal: { value: '45.50', confidence: 'high' },
  fees: [],
  taxes: [
    { label: 'Sales tax', value: '3.93', confidence: 'high' },
    { label: 'City tax', value: '0.50', confidence: 'medium' },
  ],
  tip: { value: '8.50', confidence: 'high' },
  cardLastFour: { value: '4417', confidence: 'high' },
  time: null,
  address: null,
  lineItems: [{ description: 'Salmon', quantity: '1', amount: '28.00' }],
};

describe('normalizeExtraction', () => {
  it('turns decimal strings into integer minor units in the stated currency', () => {
    const n = normalizeExtraction(base);
    expect(n.total?.value).toEqual(money(5843, 'USD'));
    expect(n.subtotal?.value).toEqual(money(4550, 'USD'));
    expect(n.tip?.value).toEqual(money(850, 'USD'));
    expect(n.merchant?.value).toBe('Bayside Grill');
    expect(n.currency?.value).toBe('USD');
    expect(n.problems).toEqual([]);
  });

  it('sums tax lines and carries the weakest confidence', () => {
    expect(normalizeExtraction(base).taxTotal).toEqual({
      value: money(443, 'USD'),
      confidence: 'medium',
    });
  });

  it('handles currencies with other minor units', () => {
    const idr = normalizeExtraction({
      ...base,
      currency: { code: 'IDR', confidence: 'medium' },
      total: { value: '60000', confidence: 'high' },
    });
    expect(idr.total?.value).toEqual(money(6_000_000, 'IDR'));
    const jpy = normalizeExtraction({
      ...base,
      currency: { code: 'JPY', confidence: 'high' },
      total: { value: '1200.00', confidence: 'high' },
      subtotal: null,
      taxes: [],
      tip: null,
    });
    expect(jpy.total?.value).toEqual(money(1200, 'JPY'));
  });

  it('flags values it cannot read instead of rounding or guessing', () => {
    const n = normalizeExtraction({
      ...base,
      total: { value: '58.437', confidence: 'high' },
      subtotal: { value: '1,045.50', confidence: 'high' },
      date: { value: '09/14/2026', confidence: 'high' },
      cardLastFour: { value: '44', confidence: 'low' },
    });
    expect(n.total).toBeNull();
    expect(n.subtotal).toBeNull();
    expect(n.date).toBeNull();
    expect(n.cardLastFour).toBeNull();
    expect(n.problems).toEqual(['total', 'subtotal', 'date', 'cardLastFour']);
  });

  it('flags an unknown currency, and its amounts, unless a fallback applies', () => {
    const unknown = { ...base, currency: { code: 'ZZZ', confidence: 'low' as const } };
    expect(normalizeExtraction(unknown).problems).toContain('currency');
    expect(normalizeExtraction(unknown).total).toBeNull();
    expect(normalizeExtraction(unknown, { fallbackCurrency: 'USD' }).total?.value).toEqual(
      money(5843, 'USD'),
    );
  });

  it('leaves absent fields absent', () => {
    const n = normalizeExtraction({
      ...base,
      merchant: null,
      tip: null,
      taxes: [],
      cardLastFour: null,
    });
    expect(n.merchant).toBeNull();
    expect(n.tip).toBeNull();
    expect(n.taxTotal).toBeNull();
    expect(n.cardLastFour).toBeNull();
  });
});

describe('time and place (FR-INT-17)', () => {
  it('reads the time as HH:MM and the address with its city, region and country', () => {
    const n = normalizeExtraction({
      ...base,
      time: { value: '9:05', confidence: 'high' },
      address: {
        printed: ' 1615 Howard St, Omaha, NE 68102 ',
        city: 'Omaha',
        region: 'NE',
        country: 'us',
        confidence: 'medium',
      },
    });
    expect(n.time).toEqual({ value: '09:05', confidence: 'high' });
    expect(n.place).toEqual({
      value: {
        address: '1615 Howard St, Omaha, NE 68102',
        city: 'Omaha',
        region: 'NE',
        country: 'US',
      },
      confidence: 'medium',
    });
    expect(n.problems).toEqual([]);
  });

  it('leaves one it can’t read blank, never a reason for review', () => {
    const n = normalizeExtraction({
      ...base,
      time: { value: 'quarter past seven', confidence: 'low' },
      address: { printed: '  ', city: 'Omaha', region: null, country: 'US', confidence: 'low' },
    });
    expect([n.time, n.place, n.problems]).toEqual([null, null, []]);
    const noCountry = normalizeExtraction({
      ...base,
      address: {
        printed: 'Rue de Rivoli',
        city: 'Paris',
        region: null,
        country: 'France',
        confidence: 'high',
      },
    });
    expect(noCountry.place?.value.country).toBeNull();
  });
});

describe('assumedZeros', () => {
  const read = (over: Partial<ReceiptExtraction>) => normalizeExtraction({ ...base, ...over });

  it('counts tax and tip a receipt does not print as zero', () => {
    expect(assumedZeros(read({ subtotal: null, taxes: [], tip: null }))).toEqual([
      'taxTotal',
      'tip',
    ]);
  });

  it('agrees with a subtotal that already equals the total', () => {
    const n = read({ subtotal: { value: '58.43', confidence: 'high' }, taxes: [], tip: null });
    expect(assumedZeros(n)).toEqual(['taxTotal', 'tip']);
  });

  it('assumes only the missing one when the rest add up', () => {
    const n = read({ subtotal: { value: '54.00', confidence: 'high' }, tip: null });
    expect(assumedZeros(n)).toEqual(['tip']);
  });

  it('assumes nothing when the printed figures leave an amount unaccounted for', () => {
    expect(assumedZeros(read({ taxes: [], tip: null }))).toEqual([]);
  });

  it('never assumes a line that is printed but unreadable, or anything without a total', () => {
    const unreadable = read({
      subtotal: null,
      taxes: [],
      tip: { value: '8.5.0', confidence: 'low' },
    });
    expect(unreadable.problems).toContain('tip');
    expect(assumedZeros(unreadable)).toEqual(['taxTotal']);
    expect(assumedZeros(read({ total: null, taxes: [], tip: null }))).toEqual([]);
  });

  it('leaves the reading itself as read', () => {
    const n = read({ subtotal: null, taxes: [], tip: null });
    expect(n.taxTotal).toBeNull();
    expect(n.tip).toBeNull();
  });
});
