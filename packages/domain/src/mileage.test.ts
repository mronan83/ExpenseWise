import { describe, expect, it } from 'vitest';
import {
  applyMileageInput,
  IRS_BUSINESS_RATES,
  MILEAGE_MAX_MILES,
  mileageRate,
  plainMiles,
  quoteMileage,
  rateDecimal,
  rateOn,
  reimburse,
  selectRate,
  type MileageValues,
} from './mileage.ts';

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

describe('the IRS business rate (ADR-0038)', () => {
  const on = (date: string) => {
    const rate = rateOn(date);
    if (!rate.ok) throw new Error(rate.error.message);
    return rate.value;
  };

  it('pays the IRS business rate in force on the travel date', () => {
    expect(on('2022-06-30').perUnit).toBe('0.585');
    expect(on('2022-07-01').perUnit).toBe('0.625');
    expect(on('2024-12-31').perUnit).toBe('0.67');
    expect(on('2025-12-31').perUnit).toBe('0.70');
    expect(on('2026-01-01')).toEqual({
      currency: 'USD',
      perUnit: '0.725',
      unit: 'mi',
      effectiveFrom: '2026-01-01',
      source: 'irs-business',
    });
    expect(IRS_BUSINESS_RATES.through).toBe('2026-12-31');
  });

  it('has no rate before the first it holds, or after the last day it knows', () => {
    expect(rateOn('2021-12-31')).toEqual({
      ok: false,
      error: { field: 'date', message: 'There is no mileage rate before 2022-01-01.' },
    });
    const later = rateOn('2027-01-01');
    expect(later.ok).toBe(false);
    if (!later.ok) expect(later.error.message).toMatch(/after 2026-12-31 yet/);
  });

  it('shows a rate with its cents and no trailing zeros beyond them', () => {
    expect(rateDecimal({ perUnit: '0.7250', currency: 'USD' })).toBe('0.725');
    expect(rateDecimal({ perUnit: '0.7000', currency: 'USD' })).toBe('0.70');
    expect(plainMiles('038.40')).toBe('38.4');
    expect(plainMiles('12.00')).toBe('12');
  });
});

const TODAY = '2026-10-04';
const drive = { date: '2026-09-22', destination: 'IAH', purpose: 'Acme onsite', miles: '38.4' };

describe('logging a drive by hand (FR-CAP-03)', () => {
  it('claims miles times the rate on the day, rounded half-up to the cent', () => {
    const logged = applyMileageInput(null, drive, TODAY);
    if (!logged.ok) throw new Error(logged.error.message);
    expect(logged.value.values).toEqual(drive);
    // 38.4 × $0.725 = $27.84
    expect(logged.value.claim?.amount).toEqual({ amountMinor: 2784, currency: 'USD' });
    expect(logged.value.claim?.rate.effectiveFrom).toBe('2026-01-01');
    // 12.3 × $0.725 = $8.9175, rounded up to $8.92
    const quoted = quoteMileage({ date: '2026-09-22', miles: '12.3' }, TODAY);
    expect(quoted.ok && quoted.value.amount.amountMinor).toBe(892);
  });

  it.each<[Partial<typeof drive>, string, RegExp]>([
    [{ date: '2026-02-30' }, 'date', /YYYY-MM-DD/],
    [{ date: '2026-10-06' }, 'date', /can’t be after today/],
    [{ date: '2021-12-31' }, 'date', /no mileage rate before 2022-01-01/],
    [{ destination: '  ' }, 'destination', /where you drove/],
    [{ destination: 'x'.repeat(201) }, 'destination', /200 characters/],
    [{ purpose: '' }, 'purpose', /what the drive was for/],
    [{ purpose: 'x'.repeat(501) }, 'purpose', /500 characters/],
    [{ miles: '0' }, 'miles', /more than zero/],
    [{ miles: '-3' }, 'miles', /as a number/],
    [{ miles: '38.456' }, 'miles', /two decimal places/],
    [{ miles: '1000.01' }, 'miles', /at most 1000 miles/],
    [{ miles: '1e3' }, 'miles', /as a number/],
  ])('refuses %o, naming the field %s', (over, field, message) => {
    const result = applyMileageInput(null, { ...drive, ...over }, TODAY);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.field).toBe(field);
      expect(result.error.message).toMatch(message);
    }
  });

  it('takes a date a day ahead, for a time zone ahead of UTC, and up to the most miles', () => {
    const ahead = applyMileageInput(
      null,
      { ...drive, date: '2026-10-05', miles: String(MILEAGE_MAX_MILES) },
      TODAY,
    );
    expect(ahead.ok).toBe(true);
    const quoted = quoteMileage({ date: '2026-10-06', miles: '3' }, TODAY);
    expect(quoted.ok).toBe(false);
  });

  it('needs every field for a new entry', () => {
    expect(applyMileageInput(null, { date: '2026-09-22', miles: '3' }, TODAY)).toEqual({
      ok: false,
      error: { field: 'destination', message: 'Enter where you drove to.' },
    });
  });
});

describe('editing a drive before it is submitted', () => {
  const current: MileageValues = { ...drive, miles: '38.40' };

  it('works the amount out again, at the rate on the new date, when the miles or date change', () => {
    const moved = applyMileageInput(current, { date: '2025-12-31' }, TODAY);
    if (!moved.ok) throw new Error(moved.error.message);
    expect(moved.value.changes).toEqual([{ field: 'date', from: '2026-09-22', to: '2025-12-31' }]);
    // 38.4 × $0.70
    expect(moved.value.claim?.amount.amountMinor).toBe(2688);
    expect(moved.value.claim?.rate.perUnit).toBe('0.70');

    const longer = applyMileageInput(current, { miles: '40' }, TODAY);
    if (!longer.ok) throw new Error(longer.error.message);
    expect(longer.value.changes).toEqual([{ field: 'miles', from: '38.4', to: '40' }]);
    expect(longer.value.claim?.amount.amountMinor).toBe(2900);
  });

  it('keeps the rate it has when only where or why changes, and sees no change in the same miles', () => {
    const renamed = applyMileageInput(
      current,
      { destination: 'Bush Intercontinental', miles: '38.4' },
      TODAY,
    );
    if (!renamed.ok) throw new Error(renamed.error.message);
    expect(renamed.value.changes).toEqual([
      { field: 'destination', from: 'IAH', to: 'Bush Intercontinental' },
    ]);
    expect(renamed.value.claim).toBeNull();
  });
});
