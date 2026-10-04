import { money } from '@expensewise/domain';
import { describe, expect, it } from 'vitest';
import { confirmReading } from './confirm.ts';
import { normalizeExtraction } from './normalize.ts';
import type { ReceiptExtraction } from './schema.ts';

const reading = (over: Partial<ReceiptExtraction> = {}): ReceiptExtraction => ({
  documentType: 'receipt',
  merchant: { name: 'Blue Bottle Coffee', confidence: 'high' },
  date: { value: '2026-09-24', confidence: 'medium' },
  currency: { code: 'USD', confidence: 'high' },
  total: { value: '6.50', confidence: 'low' },
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

describe('confirmReading', () => {
  it('confirms a reading as it is, with no corrections, whatever its confidence', () => {
    const result = confirmReading(n());
    expect(result).toEqual({
      ok: true,
      value: {
        confirmed: {
          merchant: 'Blue Bottle Coffee',
          date: '2026-09-24',
          currency: 'USD',
          total: money(650, 'USD'),
          taxTotal: money(0, 'USD'),
          tip: money(0, 'USD'),
        },
        corrections: [],
      },
    });
  });

  it('files a tax or tip the receipt does not print as zero, and keeps one it does', () => {
    const result = confirmReading(
      n({ taxes: [{ label: 'Tax', value: '0.54', confidence: 'high' }] }),
    );
    expect(result.ok && result.value.confirmed.taxTotal).toEqual(money(54, 'USD'));
    expect(result.ok && result.value.confirmed.tip).toEqual(money(0, 'USD'));
  });

  it('applies corrections and keeps what was read beside each one', () => {
    const result = confirmReading(n(), {
      total: '65.00',
      merchant: '  Blue Bottle  ',
      tip: '1.00',
    });
    expect(result.ok && result.value.confirmed).toMatchObject({
      merchant: 'Blue Bottle',
      total: money(6500, 'USD'),
      tip: money(100, 'USD'),
    });
    expect(result.ok && result.value.corrections).toEqual([
      { field: 'merchant', read: 'Blue Bottle Coffee', corrected: 'Blue Bottle' },
      { field: 'total', read: '6.50', corrected: '65.00' },
      { field: 'tip', read: null, corrected: '1.00' },
    ]);
  });

  it('does not count a value entered unchanged as a correction', () => {
    const result = confirmReading(n(), { total: '6.5', date: '2026-09-24', tip: '0' });
    expect(result.ok && result.value.corrections).toEqual([]);
  });

  it('needs every filing field, entered when the reading lacks it', () => {
    expect(confirmReading(n({ total: null, merchant: null }))).toEqual({
      ok: false,
      error: { kind: 'missing', fields: ['merchant', 'total'] },
    });
    const filled = confirmReading(n({ total: null }), { total: '12.00' });
    expect(filled.ok && filled.value.corrections).toEqual([
      { field: 'total', read: null, corrected: '12.00' },
    ]);
  });

  it('can be filled in entirely by hand when no reading has fields', () => {
    const result = confirmReading(null, {
      merchant: 'Corner Store',
      date: '2026-10-01',
      currency: 'eur',
      total: '4.20',
    });
    expect(result.ok && result.value.confirmed).toEqual({
      merchant: 'Corner Store',
      date: '2026-10-01',
      currency: 'EUR',
      total: money(420, 'EUR'),
      taxTotal: null,
      tip: null,
    });
  });

  it('keeps the printed amounts when the currency is corrected', () => {
    const result = confirmReading(n(), { currency: 'CAD' });
    expect(result.ok && result.value.confirmed.total).toEqual(money(650, 'CAD'));
    expect(result.ok && result.value.corrections).toEqual([
      { field: 'currency', read: 'USD', corrected: 'CAD' },
    ]);
  });

  it('refuses a read amount that the corrected currency cannot hold, rather than rounding', () => {
    expect(confirmReading(n(), { currency: 'JPY' })).toMatchObject({
      ok: false,
      error: { kind: 'invalid', field: 'total' },
    });
    const fixed = confirmReading(n(), { currency: 'JPY', total: '650' });
    expect(fixed.ok && fixed.value.confirmed.total).toEqual(money(650, 'JPY'));
  });

  it.each([
    [{ merchant: '   ' }, 'merchant'],
    [{ date: '2026-02-30' }, 'date'],
    [{ currency: 'XYZ' }, 'currency'],
    [{ total: '6.505' }, 'total'],
    [{ total: '1,000' }, 'total'],
    [{ taxTotal: '-1.00' }, 'taxTotal'],
  ] as const)('refuses %o as a value for %s', (corrections, field) => {
    expect(confirmReading(n(), corrections)).toMatchObject({
      ok: false,
      error: { kind: 'invalid', field },
    });
  });
});
