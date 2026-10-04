import { describe, expect, it } from 'vitest';
import { ReceiptExtractionSchema, StoredReadingSchema } from './schema.ts';

const before = {
  documentType: 'receipt',
  merchant: { name: 'Blue Bottle Coffee', confidence: 'high' },
  date: null,
  currency: { code: 'USD', confidence: 'high' },
  total: { value: '6.50', confidence: 'high' },
  subtotal: null,
  taxes: [],
  tip: null,
  cardLastFour: null,
  lineItems: [],
};

describe('stored readings', () => {
  it('reads a reading made before fees were read as having none', () => {
    expect(ReceiptExtractionSchema.safeParse(before).success).toBe(false);
    expect(StoredReadingSchema.parse(before).fees).toEqual([]);
    // Readings before receipt-v3 have no time or place either.
    expect(StoredReadingSchema.parse(before)).toMatchObject({ time: null, address: null });
  });

  it('keeps the fees of a reading that has them', () => {
    const fee = { label: 'Booking Fee', value: '2.75', confidence: 'high' };
    expect(StoredReadingSchema.parse({ ...before, fees: [fee] }).fees).toEqual([fee]);
  });
});
