import { checkLines, money, sum } from '@expensewise/domain';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { describe, expect, it } from 'vitest';
import { addsUp, readingChecks } from './checks.ts';
import { itemizationOf } from './lines.ts';
import { normalizeExtraction } from './normalize.ts';
import { PROMPT_VERSION, SYSTEM_PROMPT } from './prompt.ts';
import { isAutoReady } from './review.ts';
import { ReceiptExtractionSchema, SCHEMA_VERSION, type ReceiptExtraction } from './schema.ts';

const UPLOADED = new Date('2026-10-05T15:00:00Z');
const usd = (cents: number) => money(cents, 'USD');
const high = (value: string) => ({ value, confidence: 'high' as const });
const tax = (label: string, value: string) => ({ label, value, confidence: 'high' as const });
const item = (description: string, amount: string) => ({ description, quantity: null, amount });

/**
 * A Hilton folio as the product owner described it on Oct 5 (GAP-38), read as printed: two
 * nights at $189.00, each night's state occupancy tax (7%) and city tax (5.5%), overnight
 * parking of $34.00 each night, one credit of $68.00 that reversed both, and the payment of
 * what was left to the card. It prints no subtotal; its balance is 0.00.
 */
const ONE_NIGHTS_TAXES = [tax('State occupancy tax', '13.23'), tax('City tax', '10.40')];
const HILTON: ReceiptExtraction = {
  documentType: 'hotel_folio',
  merchant: { name: 'Hilton Omaha', confidence: 'high' },
  date: high('2026-10-03'),
  currency: { code: 'USD', confidence: 'high' },
  // The payment to the card, after the credit; not the balance, 0.00.
  total: high('425.26'),
  subtotal: null,
  taxes: [...ONE_NIGHTS_TAXES, ...ONE_NIGHTS_TAXES],
  fees: [],
  tip: null,
  cardLastFour: high('1234'),
  time: null,
  address: null,
  lineItems: [
    item('Guest room', '189.00'),
    item('Overnight parking', '34.00'),
    item('Guest room', '189.00'),
    item('Overnight parking', '34.00'),
    item('Parking credit', '-68.00'),
  ],
};
const folio = (over: Partial<ReceiptExtraction> = {}) => ({ ...HILTON, ...over });

describe('a folio’s credits and each night’s charges, read as printed (#92)', () => {
  it('keeps each night’s room and both parking charges, and the credit as a negative line of its own', () => {
    const it = itemizationOf(HILTON)!;
    expect(it.subtotal).toBeNull();
    expect(it.total).toEqual(usd(42_526));
    expect(it.lines.map((l) => [l.kind, l.description, l.amount.amountMinor])).toEqual([
      ['item', 'Guest room', 18_900],
      ['item', 'Overnight parking', 3400],
      ['item', 'Guest room', 18_900],
      ['item', 'Overnight parking', 3400],
      ['item', 'Parking credit', -6800],
      ['tax', 'State occupancy tax', 1323],
      ['tax', 'City tax', 1040],
      ['tax', 'State occupancy tax', 1323],
      ['tax', 'City tax', 1040],
    ]);
    // The parking charges and their credit net out, and nothing else was taken off.
    const parking = it.lines.filter((l) => /parking/i.test(l.description)).map((l) => l.amount);
    expect(sum('USD', parking)).toEqual(usd(0));
    expect(checkLines(it)).toEqual({
      addsUp: true,
      items: usd(37_800),
      extras: usd(4726),
      taxIncluded: false,
    });
  });

  it('adds each night’s taxes up to the tax the folio prints, and makes the total with them', () => {
    const n = normalizeExtraction(HILTON);
    // The folio prints its taxes as $47.26 in all, which is no line of its own.
    expect(n.taxTotal).toEqual({ value: usd(4726), confidence: 'high' });
    expect(n.taxLines).toBe(4);
    expect(n.itemTotal).toEqual(usd(37_800));
    expect(n.itemLines).toBe(5);
    expect(addsUp(n)).toBe(true);
    expect(readingChecks(n, UPLOADED)).toEqual([]);
    expect(isAutoReady(n, UPLOADED)).toBe(true);
  });

  it('holds a reading with one night’s taxes for a look, though the folio prints no subtotal', () => {
    const half = normalizeExtraction(folio({ taxes: ONE_NIGHTS_TAXES }));
    expect(addsUp(half)).toBe(false);
    expect(readingChecks(half, UPLOADED)).toEqual(['sums']);
    expect(isAutoReady(half, UPLOADED)).toBe(false);
    // Its lines say so on the expense too, with what they come to.
    expect(checkLines(itemizationOf(folio({ taxes: ONE_NIGHTS_TAXES }))!)).toMatchObject({
      addsUp: false,
      problem: 'total',
      comesTo: usd(40_163),
      against: usd(42_526),
    });
  });

  it('holds a reading that drops the credit, lists the printed total of the taxes as a tax, or takes the balance as the total', () => {
    const noCredit = folio({ lineItems: HILTON.lineItems.slice(0, 4) });
    const totalTaxes = folio({ taxes: [...HILTON.taxes, tax('Total taxes', '47.26')] });
    const balance = folio({ total: high('0.00') });
    for (const wrong of [noCredit, totalTaxes, balance]) {
      expect(readingChecks(normalizeExtraction(wrong), UPLOADED)).toEqual(['sums']);
    }
  });

  it('allows a cent a line with no subtotal, and no more, as the expense’s lines are held', () => {
    // Five items and four taxes: nine lines, each rounded on its own.
    expect(addsUp(normalizeExtraction(folio({ total: high('425.35') })))).toBe(true);
    expect(addsUp(normalizeExtraction(folio({ total: high('425.17') })))).toBe(true);
    expect(addsUp(normalizeExtraction(folio({ total: high('425.36') })))).toBe(false);
    expect(addsUp(normalizeExtraction(folio({ total: high('425.16') })))).toBe(false);
  });

  it('adds up item lines whose prices include their tax, as VAT receipts print them', () => {
    const vat = folio({
      currency: { code: 'EUR', confidence: 'high' },
      total: high('240.00'),
      taxes: [tax('VAT 20% (included)', '40.00')],
      lineItems: [item('Room', '120.00'), item('Room', '120.00')],
    });
    expect(addsUp(normalizeExtraction(vat))).toBe(true);
  });

  it('has nothing to add up with neither a subtotal nor an item line that reads, as before', () => {
    expect(addsUp(normalizeExtraction(folio({ lineItems: [] })))).toBeNull();
    const unreadable = folio({ lineItems: [item('Guest room', '189.005')] });
    const n = normalizeExtraction(unreadable);
    expect(n.itemTotal).toBeNull();
    expect(n.problems).toEqual([]);
    expect(addsUp(n)).toBeNull();
    expect(addsUp(normalizeExtraction(folio({ total: null })))).toBeNull();
  });

  it('asks for every line each time it is printed, a credit as a negative line, and a folio’s total as what was charged', () => {
    expect([PROMPT_VERSION, SCHEMA_VERSION]).toEqual(['extract-v5', 'receipt-v5']);
    expect(SYSTEM_PROMPT).toContain('Read every line each time it is printed');
    expect(SYSTEM_PROMPT).toContain('Never merge, total or de-duplicate repeated lines');
    expect(SYSTEM_PROMPT).toContain('a line of its own with a negative amount');
    expect(SYSTEM_PROMPT).toContain('Never net it into the charge it reverses');
    expect(SYSTEM_PROMPT).toContain('never the balance left after it');
    const schema = JSON.stringify(zodOutputFormat(ReceiptExtractionSchema).schema);
    expect(schema).toContain('each time it is printed');
    expect(schema).toContain('-68.00');
    expect(schema).toContain('Total taxes');
  });
});
