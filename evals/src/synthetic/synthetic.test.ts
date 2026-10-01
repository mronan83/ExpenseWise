import { fromDecimal } from '@expensewise/domain';
import { describe, expect, it } from 'vitest';
import { seeded } from '../random.ts';
import { eTicket } from './eticket.ts';
import { hotelFolio } from './folio.ts';
import { addDays, percentOf, printedDate } from './money.ts';
import { restaurantReceipt } from './receipt.ts';

const cents = (s: string | undefined) => (s === undefined ? 0 : fromDecimal(s, 'USD').amountMinor);

describe('seeded random', () => {
  it('repeats exactly for the same seed', () => {
    const a = seeded(42);
    const b = seeded(42);
    expect(Array.from({ length: 5 }, () => a.int(1, 1000))).toEqual(
      Array.from({ length: 5 }, () => b.int(1, 1000)),
    );
  });
});

describe('synthetic money helpers', () => {
  it('computes tax half up in cents and moves dates by whole days', () => {
    expect(percentOf(14900, 1139)).toBe(1697); // 1697.11
    expect(percentOf(200, 750)).toBe(15); // 15.0
    expect(percentOf(10, 750)).toBe(1); // 0.75 rounds up
    expect(addDays('2026-08-30', 3)).toBe('2026-09-02');
    expect(printedDate('2026-09-04', 'dmy')).toBe('4 Sep 2026');
    expect(printedDate('2026-09-04', 'us')).toBe('09/04/2026');
  });
});

describe.each([
  ['hotel folio', hotelFolio],
  ['airline e-ticket', eTicket],
  ['restaurant receipt', restaurantReceipt],
])('%s', (_, generate) => {
  it('is reproducible from its seed', () => {
    expect(generate(seeded(7))).toEqual(generate(seeded(7)));
  });

  it.each([1, 2, 3, 4, 5, 6, 7, 8])('prints totals that reconcile (seed %i)', (seed) => {
    const { truth, html } = generate(seeded(seed));
    const parts = cents(truth.subtotal) + cents(truth.taxTotal) + cents(truth.tip);
    if (truth.subtotal !== undefined) expect(parts).toBe(cents(truth.total));
    expect(cents(truth.taxTotal)).toBeGreaterThan(0);
    expect(html).toContain(truth.total);
    expect(html).toContain(truth.cardLastFour);
    expect(truth.date).toMatch(/^2026-\d{2}-\d{2}$/);
  });
});
