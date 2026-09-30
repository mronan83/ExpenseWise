import { describe, expect, it } from 'vitest';
import { mileageRate, reimburse, selectRate } from './mileage.ts';

const orgRate = (perUnit: string, effectiveFrom: string, unit: 'mi' | 'km' = 'mi') =>
  mileageRate({ currency: 'USD', perUnit, unit, effectiveFrom, source: 'org-policy' });

describe('reimburse', () => {
  it('matches the trip wireframe: 38.4 mi at $0.70 is $26.88', () => {
    expect(reimburse('38.4', 'mi', orgRate('0.70', '2026-01-01')).amount.amountMinor).toBe(2688);
  });

  it('rounds half-up to the cent', () => {
    // 12.3 × 0.725 = 8.9175
    expect(reimburse('12.3', 'mi', orgRate('0.725', '2026-01-01')).amount.amountMinor).toBe(892);
    // 1 × 0.625 = 0.625 → 0.63
    expect(reimburse('1', 'mi', orgRate('0.625', '2026-01-01')).amount.amountMinor).toBe(63);
  });

  it('snapshots the rate it used', () => {
    const rate = orgRate('0.70', '2026-01-01');
    const claim = reimburse('10', 'mi', rate);
    expect(claim.rate).toEqual(rate);
    expect(Object.isFrozen(claim)).toBe(true);
  });

  it('pays nothing for zero distance and refuses bad input', () => {
    expect(reimburse('0', 'mi', orgRate('0.70', '2026-01-01')).amount.amountMinor).toBe(0);
    expect(() => reimburse('-1', 'mi', orgRate('0.70', '2026-01-01'))).toThrow(
      /cannot be negative/,
    );
    expect(() => reimburse('10', 'km', orgRate('0.70', '2026-01-01'))).toThrow(/per mi/);
    expect(() => orgRate('-0.10', '2026-01-01')).toThrow(/cannot be negative/);
  });
});

describe('selectRate', () => {
  const rates = [
    orgRate('0.70', '2025-01-01'),
    orgRate('0.725', '2026-01-01'),
    orgRate('0.45', '2025-06-01', 'km'),
  ];

  it('uses the rate in force on the travel date', () => {
    expect(selectRate(rates, '2025-12-31', 'mi').perUnit).toBe('0.70');
    expect(selectRate(rates, '2026-01-01', 'mi').perUnit).toBe('0.725');
    expect(selectRate(rates, '2026-09-24', 'km').perUnit).toBe('0.45');
  });

  it('refuses dates before any rate, and invalid dates', () => {
    expect(() => selectRate(rates, '2024-12-31', 'mi')).toThrow(/No mi rate is in effect/);
    expect(() => selectRate(rates, '2026-13-01', 'mi')).toThrow(/calendar date/);
  });
});
