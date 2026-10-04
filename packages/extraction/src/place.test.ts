import { describe, expect, it } from 'vitest';
import { normalizeExtraction } from './normalize.ts';
import { detailsOf, timeZoneFor } from './place.ts';
import type { ReceiptExtraction } from './schema.ts';

describe('the time zone where a receipt was printed (FR-INT-17)', () => {
  it('finds a city’s, in any case and without its accents', () => {
    expect(timeZoneFor({ city: 'Omaha', region: 'NE', country: 'US' })).toBe('America/Chicago');
    expect(timeZoneFor({ city: 'SAN FRANCISCO', region: null, country: 'US' })).toBe(
      'America/Los_Angeles',
    );
    expect(timeZoneFor({ city: 'Zürich', region: null, country: 'CH' })).toBe('Europe/Zurich');
  });

  it('falls back to its region, then to a country with one time zone', () => {
    // Half Moon Bay is too small to be listed; California is.
    expect(timeZoneFor({ city: 'Half Moon Bay', region: 'CA', country: 'US' })).toBe(
      'America/Los_Angeles',
    );
    expect(timeZoneFor({ city: 'Nowhereville', region: null, country: 'DE' })).toBe(
      'Europe/Berlin',
    );
  });

  it('says nothing when it can’t know', () => {
    expect(timeZoneFor({ city: 'Nowhereville', region: null, country: 'US' })).toBeNull();
    expect(timeZoneFor({ city: 'Omaha', region: 'NE', country: null })).toBeNull();
  });
});

describe('the time and place a reading files', () => {
  const reading: ReceiptExtraction = {
    documentType: 'ride_receipt',
    merchant: { name: 'Uber', confidence: 'high' },
    date: { value: '2026-09-30', confidence: 'high' },
    currency: { code: 'USD', confidence: 'high' },
    total: { value: '31.45', confidence: 'high' },
    subtotal: null,
    fees: [],
    taxes: [],
    tip: null,
    cardLastFour: null,
    time: { value: '18:42', confidence: 'high' },
    address: {
      printed: 'Eppley Airfield, Omaha, NE',
      city: 'Omaha',
      region: 'NE',
      country: 'US',
      confidence: 'high',
    },
    lineItems: [],
  };

  it('carries the time, the address and the zone worked out from it', () => {
    expect(detailsOf(normalizeExtraction(reading))).toEqual({
      time: '18:42',
      timeZone: 'America/Chicago',
      address: 'Eppley Airfield, Omaha, NE',
      city: 'Omaha',
      region: 'NE',
      country: 'US',
    });
  });

  it('is blank for no reading, or one that printed neither', () => {
    expect(detailsOf(null)).toMatchObject({ time: null, timeZone: null, address: null });
    expect(detailsOf(normalizeExtraction({ ...reading, time: null, address: null }))).toMatchObject(
      { time: null, timeZone: null, city: null },
    );
  });
});
