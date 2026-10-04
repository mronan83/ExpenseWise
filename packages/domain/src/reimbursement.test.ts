import { describe, expect, it } from 'vitest';
import { fxRate } from './fx.ts';
import { money } from './money.ts';
import {
  conversionApplies,
  conversionCurrent,
  reimbursed,
  reimbursementTotal,
  type ConversionRecord,
} from './reimbursement.ts';

const RATE = fxRate({
  base: 'EUR',
  quote: 'USD',
  rate: '1.1712',
  asOf: '2026-09-25',
  source: 'ECB',
});

const lufthansa: ConversionRecord = {
  amount: money(41280, 'EUR'),
  purchaseDate: '2026-09-27',
  into: 'USD',
  outcome: 'converted',
  converted: money(48347, 'USD'),
  rate: RATE,
};

describe('an amount in the reimbursement currency (FR-EXP-13)', () => {
  it('counts an amount already in it as it is, with no rate', () => {
    expect(reimbursed(money(1225, 'USD'), '2026-10-02', 'USD', lufthansa)).toEqual({
      kind: 'same',
      amount: money(1225, 'USD'),
    });
  });

  it('converts at the rate recorded on it, and keeps it after rates move or the amount is edited', () => {
    expect(reimbursed(money(41280, 'EUR'), '2026-09-27', 'USD', lufthansa)).toEqual({
      kind: 'converted',
      amount: money(41280, 'EUR'),
      converted: money(48347, 'USD'),
      rate: RATE,
    });
    // Edited to 420.00 euros: the same recorded rate converts the new amount.
    expect(reimbursed(money(42000, 'EUR'), '2026-09-27', 'USD', lufthansa)).toMatchObject({
      kind: 'converted',
      converted: money(49190, 'USD'),
      rate: { rate: '1.1712', asOf: '2026-09-25' },
    });
  });

  it('is converting while no recorded rate applies: none yet, or another currency, date or target', () => {
    expect(reimbursed(money(41280, 'EUR'), '2026-09-27', 'USD')).toEqual({
      kind: 'converting',
      amount: money(41280, 'EUR'),
    });
    expect(reimbursed(money(41280, 'GBP'), '2026-09-27', 'USD', lufthansa).kind).toBe('converting');
    expect(reimbursed(money(41280, 'EUR'), '2026-09-28', 'USD', lufthansa).kind).toBe('converting');
    expect(reimbursed(money(41280, 'EUR'), '2026-09-27', 'GBP', lufthansa).kind).toBe('converting');
  });

  it('stays as spent, said plainly, when the source has no rate for it', () => {
    const dirhams: ConversionRecord = {
      amount: money(18500, 'AED'),
      purchaseDate: '2026-09-27',
      into: 'USD',
      outcome: 'unavailable',
      source: 'ECB',
    };
    expect(reimbursed(money(18500, 'AED'), '2026-09-27', 'USD', dirhams)).toEqual({
      kind: 'unconverted',
      amount: money(18500, 'AED'),
      source: 'ECB',
    });
  });

  it('tells a conversion that still applies from one recorded for exactly this amount', () => {
    expect(conversionApplies(lufthansa, money(42000, 'EUR'), '2026-09-27', 'USD')).toBe(true);
    expect(conversionCurrent(lufthansa, money(42000, 'EUR'), '2026-09-27', 'USD')).toBe(false);
    expect(conversionCurrent(lufthansa, money(41280, 'EUR'), '2026-09-27', 'USD')).toBe(true);
  });
});

describe('a report’s total in the reimbursement currency', () => {
  it('adds what is in it and what is converted, counts what is converting, and lists the rest', () => {
    const total = reimbursementTotal('USD', [
      { kind: 'same', amount: money(128_437, 'USD') },
      reimbursed(money(41280, 'EUR'), '2026-09-27', 'USD', lufthansa),
      { kind: 'converting', amount: money(9900, 'GBP') },
      { kind: 'unconverted', amount: money(18500, 'AED'), source: 'ECB' },
      { kind: 'unconverted', amount: money(1500, 'AED'), source: 'ECB' },
      { kind: 'unconverted', amount: money(250, 'KWD'), source: 'ECB' },
    ]);
    expect(total).toEqual({
      total: money(176_784, 'USD'),
      converting: 1,
      unconverted: [money(20000, 'AED'), money(250, 'KWD')],
    });
  });

  it('is zero in the reimbursement currency with nothing on it', () => {
    expect(reimbursementTotal('EUR', [])).toEqual({
      total: money(0, 'EUR'),
      converting: 0,
      unconverted: [],
    });
  });
});
