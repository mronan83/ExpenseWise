import { describe, expect, it } from 'vitest';
import {
  choosePaidBy,
  followPolicy,
  followsPolicyChange,
  paidByProblem,
  splitCost,
  type PaidAmount,
} from './company-paid.ts';
import { EXPENSE_STATUSES } from './lifecycle/expense.ts';
import { money } from './money.ts';
import { reportCsv, reportExportTable, type ExportExpense } from './report-export.ts';

describe('who paid an expense, under the policy (FR-EXP-18, Q46)', () => {
  it('follows the policy for its type until a person sets it, then stays as they set it', () => {
    const unpinned = { companyPaid: false, pinned: false };
    expect(followPolicy(unpinned, true)).toEqual({ companyPaid: true, pinned: false });
    expect(followPolicy({ companyPaid: true, pinned: false }, false)).toEqual(unpinned);
    const set = choosePaidBy({ paidBy: 'claimant' }, true);
    expect(set).toEqual({ companyPaid: false, pinned: true });
    // Set by hand, the policy leaves it alone whichever way it goes.
    expect(followPolicy(set, true)).toBe(set);
    expect(followPolicy(choosePaidBy({ paidBy: 'company' }, false), false)).toEqual({
      companyPaid: true,
      pinned: true,
    });
  });

  it('hands it back to the policy, which applies at once', () => {
    expect(choosePaidBy({ byPolicy: true }, true)).toEqual({ companyPaid: true, pinned: false });
    // With no type, or a type the company doesn't pay, the person paid.
    expect(choosePaidBy({ byPolicy: true }, false)).toEqual({ companyPaid: false, pinned: false });
  });

  it('never lets a drive be paid by the company, and changes nothing once submitted', () => {
    const changeable = EXPENSE_STATUSES.filter(
      (status) => paidByProblem({ status, source: 'upload' }) === null,
    );
    expect(changeable).toEqual(['processing', 'needs_review', 'ready']);
    for (const status of ['submitted', 'approved', 'settled'] as const) {
      expect(paidByProblem({ status, source: 'manual' })).toBe('locked');
    }
    expect(paidByProblem({ status: 'ready', source: 'mileage' })).toBe('mileage');
    expect(followsPolicyChange({ status: 'ready', source: 'mileage', pinned: false })).toBe(false);
    expect(followsPolicyChange({ status: 'submitted', source: 'upload', pinned: false })).toBe(
      false,
    );
    expect(followsPolicyChange({ status: 'needs_review', source: 'email', pinned: true })).toBe(
      false,
    );
    expect(followsPolicyChange({ status: 'ready', source: 'camera', pinned: false })).toBe(true);
  });
});

describe('a cost split into the claim and what the company paid (FR-EXP-17)', () => {
  it('totals each per currency in integer minor units, never converted, and the full cost', () => {
    const amounts: PaidAmount[] = [
      { amountMinor: 48_720, currency: 'USD', paidBy: 'company' },
      { amountMinor: 4820, currency: 'USD', paidBy: 'claimant' },
      { amountMinor: 1, currency: 'USD', paidBy: 'claimant' },
      { amountMinor: 41_280, currency: 'EUR', paidBy: 'claimant' },
      { amountMinor: 19_900, currency: 'JPY', paidBy: 'company' },
      // One with no amount yet counts in none.
      { amountMinor: null, currency: 'USD', paidBy: 'company' },
    ];
    expect(splitCost(amounts)).toEqual({
      claimed: [money(41_280, 'EUR'), money(4821, 'USD')],
      companyPaid: [money(19_900, 'JPY'), money(48_720, 'USD')],
      full: [money(41_280, 'EUR'), money(19_900, 'JPY'), money(53_541, 'USD')],
    });
    expect(splitCost([])).toEqual({ claimed: [], companyPaid: [], full: [] });
  });
});

const expense = (over: Partial<ExportExpense> = {}): ExportExpense => ({
  date: '2026-09-02',
  merchant: 'Lou Malnati’s',
  category: null,
  type: null,
  trip: 'Chicago · partner review',
  purpose: 'Partner review',
  note: null,
  amountMinor: 4820,
  currency: 'USD',
  ...over,
});

describe('what the company paid, in a report’s export (FR-EXP-17, Q47)', () => {
  const fare = expense({
    date: '2026-09-01',
    merchant: 'United Airlines',
    amountMinor: 48_720,
    paidBy: 'company',
  });

  it('lists it apart after the claim and outside its total, with its own total and the full cost', () => {
    const table = reportExportTable([fare, expense({ paidBy: 'claimant' })]);
    expect(table.columns.map((c) => c.header).at(-1)).toBe('Paid by');
    expect(table.rows).toHaveLength(1);
    expect(table.rows[0]?.slice(-3)).toEqual(['48.20', 'USD', 'You']);
    expect(table.totals).toEqual([money(4820, 'USD')]);
    expect(table.totalRows[0]?.[0]).toBe('Total');
    expect(table.companyPaid?.rows[0]?.slice(0, 2)).toEqual(['2026-09-01', 'United Airlines']);
    expect(table.companyPaid?.rows[0]?.slice(-3)).toEqual(['487.20', 'USD', 'The company']);
    expect(table.companyPaid?.totals).toEqual([money(48_720, 'USD')]);
    expect(table.companyPaid?.totalRows[0]?.[0]).toBe('Total paid by the company');
    expect(table.companyPaid?.fullCost).toEqual([money(53_540, 'USD')]);
    expect(table.companyPaid?.fullCostRows[0]?.slice(-3)).toEqual(['535.40', 'USD', '']);
    // The dates cover everything on the report, what the company paid included.
    expect(table.dated).toEqual({ from: '2026-09-01', to: '2026-09-02' });
  });

  it('writes who paid on every row of the CSV, the claim first, so its sum can leave out what the company paid', () => {
    const csv = reportCsv(reportExportTable([fare, expense({ paidBy: 'claimant' })]));
    expect(csv.split('\r\n')).toEqual([
      '\uFEFFDate,Merchant,Category,Type,Trip,Purpose,Note,Amount,Currency,Paid by',
      '2026-09-02,Lou Malnati’s,,,Chicago · partner review,Partner review,,48.20,USD,You',
      'Total,,,,,,,48.20,USD,',
      '2026-09-01,United Airlines,,,Chicago · partner review,Partner review,,487.20,USD,The company',
      'Total paid by the company,,,,,,,487.20,USD,',
      'Full cost,,,,,,,535.40,USD,',
      '',
    ]);
  });

  it('exports a report with nothing the company paid exactly as before', () => {
    const before = reportExportTable([expense()]);
    const claimed = reportExportTable([expense({ paidBy: 'claimant' })]);
    expect(claimed).toEqual(before);
    expect(claimed.companyPaid).toBeUndefined();
  });
});
