import { money } from '@expensewise/domain';
import { describe, expect, it } from 'vitest';
import { itemizationOf } from './lines.ts';
import type { ReceiptExtraction } from './schema.ts';

const folio: ReceiptExtraction = {
  documentType: 'hotel_folio',
  merchant: { name: 'Hotel Lindley', confidence: 'high' },
  date: { value: '2026-10-01', confidence: 'high' },
  currency: { code: 'usd', confidence: 'high' },
  total: { value: '1104.00', confidence: 'high' },
  subtotal: { value: '961.50', confidence: 'high' },
  fees: [{ label: 'Resort fee', value: '17.55', confidence: 'high' }],
  taxes: [{ label: 'Occupancy tax', value: '124.95', confidence: 'high' }],
  tip: null,
  cardLastFour: null,
  time: null,
  address: null,
  lineItems: [
    { description: 'Room, 3 nights', quantity: '3', amount: '897.00' },
    { description: 'Minibar', quantity: null, amount: '18.50' },
    { description: ' ', quantity: ' ', amount: '46.00' },
  ],
};

describe('a reading’s itemized lines (FR-INT-22)', () => {
  it('reads each item, then each tax, fee and the tip, in minor units with the total and subtotal', () => {
    const it = itemizationOf({ ...folio, tip: { value: '5.00', confidence: 'high' } });
    expect(it).toEqual({
      currency: 'USD',
      total: money(110_400, 'USD'),
      subtotal: money(96_150, 'USD'),
      lines: [
        {
          kind: 'item',
          description: 'Room, 3 nights',
          quantity: '3',
          amount: money(89_700, 'USD'),
        },
        { kind: 'item', description: 'Minibar', quantity: null, amount: money(1850, 'USD') },
        { kind: 'item', description: 'Item 3', quantity: null, amount: money(4600, 'USD') },
        { kind: 'tax', description: 'Occupancy tax', quantity: null, amount: money(12_495, 'USD') },
        { kind: 'fee', description: 'Resort fee', quantity: null, amount: money(1755, 'USD') },
        { kind: 'tip', description: 'Tip', quantity: null, amount: money(500, 'USD') },
      ],
    });
  });

  it('has none for a receipt that prints no lines, or one whose lines can’t all be read exactly', () => {
    expect(itemizationOf({ ...folio, lineItems: [] })).toBeNull();
    expect(itemizationOf({ ...folio, currency: null })).toBeNull();
    expect(itemizationOf({ ...folio, currency: { code: 'XYZ', confidence: 'low' } })).toBeNull();
    const unreadable = { ...folio.lineItems[0]!, amount: '897.005' };
    expect(itemizationOf({ ...folio, lineItems: [unreadable] })).toBeNull();
    expect(itemizationOf({ not: 'a reading' })).toBeNull();
    expect(itemizationOf({ ...folio, total: null, subtotal: null })).toMatchObject({
      total: null,
      subtotal: null,
    });
  });
});
