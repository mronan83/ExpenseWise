import { describe, expect, it } from 'vitest';
import { readingChecks } from './checks.ts';
import { normalizeExtraction, travelOf } from './normalize.ts';
import { isAutoReady } from './review.ts';
import { StoredReadingSchema, type ReceiptExtraction } from './schema.ts';

const UPLOADED = new Date('2026-10-02T15:00:00Z');

const reading = (over: Partial<ReceiptExtraction> = {}): ReceiptExtraction => ({
  documentType: 'receipt',
  merchant: { name: 'Lyft', confidence: 'high' },
  date: { value: '2026-09-30', confidence: 'high' },
  currency: { code: 'USD', confidence: 'high' },
  total: { value: '24.60', confidence: 'high' },
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

const end = (value: string, confidence: 'high' | 'medium' | 'low' = 'high') => ({
  value,
  confidence,
});

const ride = reading({
  documentType: 'ride_receipt',
  journey: { from: end(' Hilton Omaha, 1001 Cass St '), to: end('1520 Harney St', 'medium') },
  stay: null,
});
const folio = (checkIn: string | null, checkOut: string | null) =>
  reading({
    documentType: 'hotel_folio',
    merchant: { name: 'Hilton Omaha', confidence: 'high' },
    date: { value: '2026-10-01', confidence: 'high' },
    total: { value: '412.60', confidence: 'high' },
    journey: null,
    stay: {
      checkIn: checkIn ? end(checkIn) : null,
      checkOut: checkOut ? end(checkOut) : null,
    },
  });

describe('a journey, read (FR-INT-20)', () => {
  it('keeps a ride’s pickup and drop-off as printed, each with its confidence', () => {
    expect(normalizeExtraction(ride).journey).toEqual({
      from: { value: 'Hilton Omaha, 1001 Cass St', confidence: 'high' },
      to: { value: '1520 Harney St', confidence: 'medium' },
    });
    expect(travelOf(normalizeExtraction(ride))).toEqual({
      journeyFrom: 'Hilton Omaha, 1001 Cass St',
      journeyTo: '1520 Harney St',
      checkIn: null,
      checkOut: null,
    });
  });

  it('keeps a flight’s airports and a train’s stations, and either end alone', () => {
    const flight = reading({
      documentType: 'airline_ticket',
      journey: { from: end('SFO'), to: end('ORD') },
      stay: null,
    });
    expect(normalizeExtraction(flight).journey).toMatchObject({
      from: { value: 'SFO' },
      to: { value: 'ORD' },
    });
    const train = reading({
      documentType: 'rail_ticket',
      journey: { from: end('Chicago Union Station', 'low'), to: null },
      stay: null,
    });
    expect(normalizeExtraction(train)).toMatchObject({
      documentType: 'rail_ticket',
      journey: { from: { value: 'Chicago Union Station', confidence: 'low' }, to: null },
    });
  });

  it('keeps none from a document that is no ticket, or one that prints neither end', () => {
    const dinner = reading({ journey: { from: end('Kitchen'), to: end('Table 4') }, stay: null });
    expect(normalizeExtraction(dinner).journey).toBeNull();
    const blank = reading({
      documentType: 'ride_receipt',
      journey: { from: end('  '), to: null },
      stay: null,
    });
    expect(normalizeExtraction(blank).journey).toBeNull();
    expect(travelOf(normalizeExtraction(blank))).toEqual({
      journeyFrom: null,
      journeyTo: null,
      checkIn: null,
      checkOut: null,
    });
  });

  it('is absent from a reading not asked for it, so the expense keeps what it has', () => {
    const before = normalizeExtraction(reading({ documentType: 'ride_receipt' }));
    expect(before).not.toHaveProperty('journey');
    expect(before).not.toHaveProperty('stay');
    expect(travelOf(before)).toBeUndefined();
    expect(travelOf(null)).toBeUndefined();
  });

  it('never decides Ready on its own: a low-confidence end is still Ready', () => {
    const unsure = reading({
      documentType: 'ride_receipt',
      journey: { from: end('Somewhere', 'low'), to: end('Elsewhere', 'low') },
      stay: null,
    });
    expect(isAutoReady(normalizeExtraction(unsure), UPLOADED)).toBe(true);
  });
});

describe('a stay, read (FR-INT-21)', () => {
  it('keeps a folio’s check-in and check-out, and works out the nights from them', () => {
    const n = normalizeExtraction(folio('2026-09-29', '2026-10-01'));
    expect(n.stay).toEqual({
      checkIn: { value: '2026-09-29', confidence: 'high' },
      checkOut: { value: '2026-10-01', confidence: 'high' },
      nights: { sure: true, nights: 2 },
    });
    expect(travelOf(n)).toEqual({
      journeyFrom: null,
      journeyTo: null,
      checkIn: '2026-09-29',
      checkOut: '2026-10-01',
    });
    expect(readingChecks(n, UPLOADED)).toEqual([]);
    expect(isAutoReady(n, UPLOADED)).toBe(true);
  });

  it('reads a check-out before check-in, or a stay of more than 31 nights, as not sure: it needs a look', () => {
    const backwards = normalizeExtraction(folio('2026-10-01', '2026-09-29'));
    expect(backwards.stay?.nights).toEqual({ sure: false, doubt: 'check_out_before_check_in' });
    expect(readingChecks(backwards, UPLOADED)).toEqual(['stay']);
    expect(isAutoReady(backwards, UPLOADED)).toBe(false);
    const year = normalizeExtraction(folio('2025-09-29', '2026-10-01'));
    expect(year.stay?.nights).toEqual({ sure: false, doubt: 'too_long' });
    expect(readingChecks(year, UPLOADED)).toEqual(['stay']);
    // Its dates still file as read, for the person to put right.
    expect(travelOf(year)).toMatchObject({ checkIn: '2025-09-29', checkOut: '2026-10-01' });
  });

  it('leaves a date that isn’t one blank, never a problem, and has no nights with one date', () => {
    const n = normalizeExtraction(folio('Sep 29', '2026-10-01'));
    expect(n.stay).toEqual({
      checkIn: null,
      checkOut: { value: '2026-10-01', confidence: 'high' },
      nights: null,
    });
    expect(n.problems).toEqual([]);
    expect(readingChecks(n, UPLOADED)).toEqual([]);
    expect(normalizeExtraction(folio('2026-02-30', null)).stay).toBeNull();
  });

  it('keeps none from a document that is no folio', () => {
    const ticket = reading({
      documentType: 'airline_ticket',
      journey: null,
      stay: { checkIn: end('2026-09-29'), checkOut: end('2026-10-01') },
    });
    expect(normalizeExtraction(ticket).stay).toBeNull();
  });
});

describe('a stored reading with a journey or a stay', () => {
  it('parses back with them, a rail ticket among the documents, and without them as before', () => {
    const stored = StoredReadingSchema.parse({
      ...reading({ documentType: 'rail_ticket' }),
      journey: { from: end('Union Station'), to: end('Milwaukee Intermodal') },
      stay: null,
    });
    expect(stored).toMatchObject({
      documentType: 'rail_ticket',
      journey: { from: { value: 'Union Station' } },
      stay: null,
    });
    const before = StoredReadingSchema.parse(reading());
    expect(before).not.toHaveProperty('journey');
    expect(before).not.toHaveProperty('stay');
  });
});
