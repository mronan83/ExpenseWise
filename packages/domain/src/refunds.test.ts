import { describe, expect, it } from 'vitest';
import {
  REFUND_DAYS,
  isRefund,
  refundCandidates,
  refundFits,
  type RefundablePurchase,
} from './refunds.ts';

const order: RefundablePurchase = {
  id: 'order',
  merchant: 'Amazon.com',
  transactionDate: '2026-10-01',
  currency: 'USD',
  amountMinor: 5420,
  refundedMinor: 0,
  mileage: false,
};
const refund = {
  merchant: 'Amazon.com Services',
  transactionDate: '2026-10-20',
  currency: 'USD',
  amountMinor: -5420,
};

describe('isRefund', () => {
  it('is an amount below zero', () => {
    expect(isRefund({ amountMinor: -1 })).toBe(true);
    expect(isRefund({ amountMinor: 0 })).toBe(false);
    expect(isRefund({ amountMinor: null })).toBe(false);
  });
});

describe('refundFits', () => {
  it('pairs a whole refund with its purchase', () => {
    expect(refundFits(refund, order)).toEqual({ ok: true, value: undefined });
  });

  it('pairs a partial refund, and refunds that together give back all of it', () => {
    expect(refundFits({ ...refund, amountMinor: -1000 }, order).ok).toBe(true);
    expect(
      refundFits({ ...refund, amountMinor: -4420 }, { ...order, refundedMinor: -1000 }).ok,
    ).toBe(true);
  });

  it('refuses to give back more than is left of the purchase', () => {
    expect(refundFits({ ...refund, amountMinor: -5421 }, order)).toEqual({
      ok: false,
      error: 'amount',
    });
    expect(
      refundFits({ ...refund, amountMinor: -4421 }, { ...order, refundedMinor: -1000 }),
    ).toEqual({ ok: false, error: 'amount' });
  });

  it('pairs only within its currency', () => {
    expect(refundFits({ ...refund, currency: 'EUR' }, order)).toEqual({
      ok: false,
      error: 'currency',
    });
  });

  it('pairs a refund dated on the purchase’s day up to 180 days after, never before', () => {
    expect(REFUND_DAYS).toBe(180);
    expect(refundFits({ ...refund, transactionDate: '2026-10-01' }, order).ok).toBe(true);
    expect(refundFits({ ...refund, transactionDate: '2027-03-30' }, order).ok).toBe(true);
    expect(refundFits({ ...refund, transactionDate: '2027-03-31' }, order)).toEqual({
      ok: false,
      error: 'date',
    });
    expect(refundFits({ ...refund, transactionDate: '2026-09-30' }, order)).toEqual({
      ok: false,
      error: 'date',
    });
  });

  it('pairs only a refund with a purchase: no drive, no refund, nothing incomplete', () => {
    expect(refundFits({ ...refund, amountMinor: 5420 }, order)).toEqual({
      ok: false,
      error: 'not_a_refund',
    });
    expect(refundFits({ ...refund, transactionDate: null }, order).ok).toBe(false);
    for (const purchase of [
      { ...order, mileage: true },
      { ...order, amountMinor: -100 },
      { ...order, amountMinor: null },
      { ...order, transactionDate: null },
    ]) {
      expect(refundFits(refund, purchase)).toEqual({ ok: false, error: 'not_a_purchase' });
    }
  });
});

describe('refundCandidates', () => {
  it('offers the purchases it fits, the likeliest first, and never one it does not', () => {
    const lunch = { ...order, id: 'lunch', merchant: 'Pret', amountMinor: 9000 };
    const earlier = { ...order, id: 'earlier', transactionDate: '2026-09-01' };
    const part = { ...order, id: 'part', amountMinor: 8000 };
    const euro = { ...order, id: 'euro', currency: 'EUR' };
    const after = { ...order, id: 'after', transactionDate: '2026-10-21' };
    const ranked = refundCandidates(refund, [lunch, earlier, part, euro, after, order]);
    // Alike merchants first; of those, the one it gives back all of, then the nearer date.
    expect(ranked.map((c) => c.id)).toEqual(['order', 'earlier', 'part', 'lunch']);
    expect(ranked[0]).toMatchObject({ likeness: 1, days: 19 });
  });
});
