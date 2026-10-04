import { describe, expect, it } from 'vitest';
import { REPORT_STATUSES } from './lifecycle/report.ts';
import {
  canExportReport,
  isReportExportable,
  reportCsv,
  reportExportTable,
  type ExportExpense,
} from './report-export.ts';

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

const HEADER = 'Date,Merchant,Category,Type,Trip,Purpose,Note,Amount,Currency';

describe('a report’s export as a table (FR-SET-01)', () => {
  it('has a row per expense, in the order given, and a total per currency, never converted', () => {
    const table = reportExportTable([
      expense(),
      expense({
        date: '2026-09-03',
        merchant: 'Hotel Lindley',
        amountMinor: 41_280,
        currency: 'EUR',
      }),
      expense({
        date: '2026-09-27',
        merchant: 'Zuni Café',
        trip: null,
        purpose: 'Lunch with the Acme architecture team',
        amountMinor: 1225,
      }),
    ]);
    expect(table.columns.map((c) => c.header).join(',')).toBe(HEADER);
    expect(table.rows).toEqual([
      [
        '2026-09-02',
        'Lou Malnati’s',
        '',
        '',
        'Chicago · partner review',
        'Partner review',
        '',
        '48.20',
        'USD',
      ],
      [
        '2026-09-03',
        'Hotel Lindley',
        '',
        '',
        'Chicago · partner review',
        'Partner review',
        '',
        '412.80',
        'EUR',
      ],
      [
        '2026-09-27',
        'Zuni Café',
        '',
        '',
        '',
        'Lunch with the Acme architecture team',
        '',
        '12.25',
        'USD',
      ],
    ]);
    expect(table.totals).toEqual([
      { amountMinor: 41_280, currency: 'EUR' },
      { amountMinor: 6045, currency: 'USD' },
    ]);
    expect(table.totalRows).toEqual([
      ['Total', '', '', '', '', '', '', '412.80', 'EUR'],
      ['Total', '', '', '', '', '', '', '60.45', 'USD'],
    ]);
    expect(table.dated).toEqual({ from: '2026-09-02', to: '2026-09-27' });
  });

  it('writes each amount in its currency’s own minor units, and leaves out one with no amount', () => {
    const table = reportExportTable([
      expense({ amountMinor: 1200, currency: 'JPY' }),
      expense({ amountMinor: 1_234_567, currency: 'KWD' }),
      expense({ amountMinor: -500, currency: 'USD', note: 'Refund' }),
      expense({ amountMinor: null, currency: null }),
      expense({ amountMinor: 100, currency: 'XXX' }),
    ]);
    expect(table.rows.map((r) => r.slice(7))).toEqual([
      ['1200', 'JPY'],
      ['1234.567', 'KWD'],
      ['-5.00', 'USD'],
      ['', ''],
      ['', 'XXX'],
    ]);
    expect(table.totalRows.map((r) => r.slice(7))).toEqual([
      ['1200', 'JPY'],
      ['1234.567', 'KWD'],
      ['-5.00', 'USD'],
    ]);
  });

  it('carries a category and type once the expense has them', () => {
    const [row] = reportExportTable([expense({ category: 'Travel', type: 'Meals' })]).rows;
    expect(row?.slice(2, 4)).toEqual(['Travel', 'Meals']);
  });

  it('is only its headers for a report with nothing on it', () => {
    const table = reportExportTable([]);
    expect(table.rows).toEqual([]);
    expect(table.totals).toEqual([]);
    expect(table.dated).toBeNull();
    expect(reportExportTable([expense({ date: null })]).dated).toBeNull();
    expect(reportCsv(table)).toBe(`\uFEFF${HEADER}\r\n`);
  });
});

describe('a report’s export as CSV', () => {
  it('starts with a byte order mark and ends each line with CRLF, so Excel reads it as UTF-8', () => {
    const csv = reportCsv(reportExportTable([expense({ trip: null, purpose: null })]));
    expect(csv.startsWith('\uFEFFDate,')).toBe(true);
    expect(csv.split('\r\n')).toEqual([
      `\uFEFF${HEADER}`,
      '2026-09-02,Lou Malnati’s,,,,,,48.20,USD',
      'Total,,,,,,,48.20,USD',
      '',
    ]);
  });

  it('quotes a value with a comma, a quote or a line break, doubling its quotes', () => {
    const csv = reportCsv(
      reportExportTable([
        expense({
          merchant: 'Joe’s Bar, Grill & "Pub"',
          trip: null,
          purpose: 'Line one\nline two',
        }),
      ]),
    );
    expect(csv.split('\r\n')[1]).toBe(
      '2026-09-02,"Joe’s Bar, Grill & ""Pub""",,,,"Line one\nline two",,48.20,USD',
    );
  });

  it('writes text that starts like a formula as plain text, but never a negative amount', () => {
    const csv = reportCsv(
      reportExportTable([
        expense({
          merchant: '=HYPERLINK("http://evil.example","Click")',
          trip: '+1 trip',
          purpose: '-minus',
          note: '@SUM(A1)',
          amountMinor: -1999,
        }),
      ]),
    );
    expect(csv.split('\r\n')[1]).toBe(
      `2026-09-02,"'=HYPERLINK(""http://evil.example"",""Click"")",,,'+1 trip,'-minus,'@SUM(A1),-19.99,USD`,
    );
  });
});

describe('a report with a measured route drive (Q33)', () => {
  const drives = [
    expense(),
    expense({
      merchant: 'Eppley Airfield',
      amountMinor: 2973,
      miles: { measured: '38.4', claimed: '41', reason: 'Road closed at the bridge' },
    }),
    expense({
      merchant: 'Acme HQ',
      amountMinor: 725,
      miles: { measured: null, claimed: '10', reason: null },
    }),
  ];

  it('shows the miles measured, the miles claimed and why they differ, with where the route came from', () => {
    const table = reportExportTable(drives);
    expect(table.columns.map((c) => c.header).slice(9)).toEqual([
      'Miles measured',
      'Miles claimed',
      'Why the miles differ',
    ]);
    expect(table.rows.map((r) => r.slice(9))).toEqual([
      ['', '', ''],
      ['38.4', '41', 'Road closed at the bridge'],
      ['', '10', ''],
    ]);
    expect(table.notes).toEqual([
      'Route © openrouteservice.org by HeiGIT · Map data © OpenStreetMap contributors',
    ]);
    expect(reportCsv(table).split('\r\n').slice(-3)).toEqual([
      'Total,,,,,,,85.18,USD,,,',
      'Route © openrouteservice.org by HeiGIT · Map data © OpenStreetMap contributors',
      '',
    ]);
  });

  it('is exported as it always was when no drive on it was measured', () => {
    const table = reportExportTable([drives[0]!, drives[2]!]);
    expect(table.columns.map((c) => c.header).join(',')).toBe(HEADER);
    expect(table.notes).toBeUndefined();
  });
});

describe('which reports can be exported, and by whom', () => {
  it('exports a report once it has closed, and never one still open', () => {
    expect(REPORT_STATUSES.filter(isReportExportable)).toEqual([
      'closed',
      'submitted',
      'in_approval',
      'approved',
      'settled',
    ]);
  });

  it('lets the member whose report it is export it, and the owner, finance admins and auditors any', () => {
    expect(canExportReport('member', true)).toBe(true);
    expect(canExportReport('member', false)).toBe(false);
    expect(canExportReport('approver', false)).toBe(false);
    expect(canExportReport('owner', false)).toBe(true);
    expect(canExportReport('finance_admin', false)).toBe(true);
    expect(canExportReport('auditor', false)).toBe(true);
  });
});
