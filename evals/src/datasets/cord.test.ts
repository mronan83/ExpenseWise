import { describe, expect, it } from 'vitest';
import { cordTruth, parseCordAmount } from './cord.ts';

describe('parseCordAmount', () => {
  it.each([
    ['60.000', '60000'],
    ['1,591,600', '1591600'],
    ['Rp 45.500', '45500'],
    ['5.455', '5455'],
    ['12,500.00', '12500.00'],
    [['27.000'], '27000'],
  ])('reads %j as %s', (raw, expected) => {
    expect(parseCordAmount(raw)).toBe(expected);
  });

  it.each([[undefined], [''], ['-60.000'], [42]])('ignores %j', (raw) => {
    expect(parseCordAmount(raw)).toBeNull();
  });
});

describe('cordTruth', () => {
  it('reads total, subtotal and tax as rupiah', () => {
    const gt = JSON.stringify({
      gt_parse: {
        total: { total_price: '60.000' },
        sub_total: { subtotal_price: '54.545', tax_price: '5.455' },
      },
    });
    expect(cordTruth(gt)).toEqual({
      documentType: 'receipt',
      currency: 'IDR',
      total: '60000',
      subtotal: '54545',
      taxTotal: '5455',
    });
  });

  it('skips receipts without a usable total', () => {
    expect(cordTruth(JSON.stringify({ gt_parse: { menu: [] } }))).toBeNull();
    expect(cordTruth(JSON.stringify({ gt_parse: { total: { total_price: '0' } } }))).toBeNull();
  });
});
