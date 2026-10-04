import { describe, expect, it } from 'vitest';
import { ReceiptExtractionSchema, sourcesOf, StoredReadingSchema } from './schema.ts';

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

describe('source lines', () => {
  it('reads the line behind each field of a reading that has them, and none from one without', () => {
    const sources = {
      merchant: 'BLUE BOTTLE COFFEE',
      date: '09/24/26 08:12',
      time: '09/24/26 08:12',
      address: null,
      currency: null,
      total: 'TOTAL $6.50',
      subtotal: null,
      taxes: null,
      tip: null,
      fees: null,
      cardLastFour: null,
    };
    expect(sourcesOf({ ...before, sources })).toEqual(sources);
    expect(sourcesOf(before)).toBeNull();
    expect(sourcesOf(null)).toBeNull();
    expect(sourcesOf({ ...before, sources: { merchant: 4 } })).toBeNull();
    // The stored reading parses as before; the lines are read apart.
    expect(StoredReadingSchema.parse({ ...before, sources })).not.toHaveProperty('sources');
  });
});
