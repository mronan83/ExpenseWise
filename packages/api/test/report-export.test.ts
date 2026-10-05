import type { Membership, ReportForExport } from '@expensewise/db';
import {
  NO_TRAVEL,
  reportExportTable,
  type ExportExpense,
  type MemberRole,
} from '@expensewise/domain';
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { createApi } from '../src/app.ts';
import type { Identity } from '../src/auth.ts';
import { fitWidths, reportPdf, reportPdfText, type ReportPdfHeading } from '../src/report-pdf.ts';
import type { ReportStore } from '../src/reports.ts';
import type { WorkspaceStore } from '../src/workspace.ts';

const ORG = '0192f7a0-0000-7000-8000-0000000000a1';
const RILEY = '0192f7a0-0000-7000-8000-0000000000b1';
const JORDAN = '0192f7a0-0000-7000-8000-0000000000b2';
const CLOSED = '0192f7a0-0000-7000-8000-0000000000e1';
const OPEN = '0192f7a0-0000-7000-8000-0000000000e2';
const NOW = new Date('2026-10-04T12:00:00.000Z');

const identity = (userId: string): Identity => ({
  userId,
  email: `${userId}@example.com`,
  assuranceLevel: 'aal1',
  sessionId: 's',
  issuedAt: NOW,
});

const expense = (over: Partial<ExportExpense> = {}): ExportExpense => ({
  date: '2026-09-01',
  merchant: 'Uber',
  category: null,
  type: null,
  trip: 'Chicago · partner review',
  purpose: 'Partner review',
  note: null,
  amountMinor: 3145,
  currency: 'USD',
  ...over,
});

const EXPENSES: ExportExpense[] = [
  expense(),
  expense({
    date: '2026-09-02',
    merchant: 'Zuni Café',
    trip: null,
    purpose: 'Lunch with the Acme architecture team',
    amountMinor: 1225,
  }),
  expense({
    date: '2026-09-03',
    merchant: 'Hotel Lindley',
    currency: 'EUR',
    amountMinor: 41_280,
    note: 'Two nights',
  }),
];

const report = (
  id: string,
  status: 'open' | 'closed',
  expenses: readonly ExportExpense[] = EXPENSES,
): ReportForExport => ({
  report: {
    id,
    memberId: RILEY,
    owner: 'Riley Ó Briain',
    organization: 'Acme Consulting',
    title: 'Report from 4 Sept 2026',
    status,
    openedAt: new Date('2026-09-04T12:00:00.000Z'),
    closedAt: status === 'closed' ? new Date('2026-09-05T08:30:00.000Z') : null,
  },
  expenses,
});

function setup(
  options: { flagOverrides?: string; role?: MemberRole; expenses?: ExportExpense[] } = {},
) {
  const asked: string[] = [];
  const reports = {
    forExport: (_org: string, id: string) => {
      asked.push(id);
      if (id === CLOSED) return Promise.resolve(report(CLOSED, 'closed', options.expenses));
      if (id === OPEN) return Promise.resolve(report(OPEN, 'open'));
      return Promise.resolve(undefined);
    },
  } as unknown as ReportStore;
  const memberships: Record<string, Membership> = {
    riley: { orgId: ORG, memberId: RILEY, role: 'owner' },
    jordan: { orgId: ORG, memberId: JORDAN, role: options.role ?? 'member' },
  };
  const workspace = {
    findMembership: (userId: string) => Promise.resolve(memberships[userId]),
    featureOn: () => Promise.resolve(false),
  } as unknown as WorkspaceStore;
  const api = createApi({
    version: 't',
    verifyToken: (token) => Promise.resolve(identity(token)),
    workspace,
    reports,
    flagOverrides: options.flagOverrides ?? 'reports.export=on',
    now: () => NOW,
  });
  const get = async (path: string, who?: string) => {
    const res = await api.request(path, {
      headers: who ? { authorization: `Bearer ${who}` } : {},
    });
    return { res, bytes: new Uint8Array(await res.arrayBuffer()) };
  };
  return { get, asked };
}

const text = (bytes: Uint8Array) => new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);
const problem = (bytes: Uint8Array) => JSON.parse(text(bytes)) as { code?: string };

describe('exporting a report (FR-SET-01)', () => {
  it('answers a closed report as CSV: a row per expense, then each currency’s total', async () => {
    const { get } = setup();
    const { res, bytes } = await get(`/v1/reports/${CLOSED}/export.csv`, 'riley');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('content-disposition')).toBe(
      'attachment; filename="expense-report-riley-o-briain-2026-09-04.csv"',
    );
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(text(bytes).split('\r\n')).toEqual([
      '\uFEFFDate,Merchant,Category,Type,Trip,Purpose,Note,Amount,Currency',
      '2026-09-01,Uber,,,Chicago · partner review,Partner review,,31.45,USD',
      '2026-09-02,Zuni Café,,,,Lunch with the Acme architecture team,,12.25,USD',
      '2026-09-03,Hotel Lindley,,,Chicago · partner review,Partner review,Two nights,412.80,EUR',
      'Total,,,,,,,412.80,EUR',
      'Total,,,,,,,43.70,USD',
      '',
    ]);
  });

  it('answers a closed report as a one-page PDF with no images, named for its person and the day it opened', async () => {
    const { get } = setup();
    const { res, bytes } = await get(`/v1/reports/${CLOSED}/export.pdf`, 'riley');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('content-disposition')).toBe(
      'attachment; filename="expense-report-riley-o-briain-2026-09-04.pdf"',
    );
    expect(text(bytes.subarray(0, 5))).toBe('%PDF-');
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBe(1);
    expect(pdf.getTitle()).toBe('Report from 4 Sept 2026');
    // No receipt images, nor any other: the file is text and lines.
    expect(text(bytes)).not.toMatch(/\/Subtype\s*\/Image/);
    expect(text(bytes)).toMatch(/\/Subtype\s*\/Type1/);
  });

  it('refuses a report still open with 409 not_closed, in either format', async () => {
    const { get } = setup();
    for (const format of ['csv', 'pdf']) {
      const { res, bytes } = await get(`/v1/reports/${OPEN}/export.${format}`, 'riley');
      expect(res.status).toBe(409);
      expect(problem(bytes).code).toBe('not_closed');
    }
  });

  it('lets only the member whose report it is, or the owner, finance admins and auditors, export it', async () => {
    const member = setup({ role: 'member' });
    const { res, bytes } = await member.get(`/v1/reports/${CLOSED}/export.csv`, 'jordan');
    expect(res.status).toBe(404);
    expect(problem(bytes).code).toBe('not_found');
    // An open report of someone else's looks absent too: its state is not given away.
    expect((await member.get(`/v1/reports/${OPEN}/export.csv`, 'jordan')).res.status).toBe(404);
    expect((await member.get(`/v1/reports/${OPEN}/export.csv`, 'riley')).res.status).toBe(409);
    for (const role of ['finance_admin', 'auditor', 'owner'] as const) {
      const { get } = setup({ role });
      expect((await get(`/v1/reports/${CLOSED}/export.pdf`, 'jordan')).res.status).toBe(200);
    }
    expect(
      (await setup({ role: 'approver' }).get(`/v1/reports/${CLOSED}/export.pdf`, 'jordan')).res
        .status,
    ).toBe(404);
  });

  it('answers 404 for a report not in the organization, and 401 without a sign-in', async () => {
    const { get } = setup();
    const missing = '0192f7a0-0000-7000-8000-0000000000ff';
    const { res, bytes } = await get(`/v1/reports/${missing}/export.csv`, 'riley');
    expect(res.status).toBe(404);
    expect(problem(bytes).code).toBe('not_found');
    expect((await get(`/v1/reports/${CLOSED}/export.csv`)).res.status).toBe(401);
  });

  it('looks absent while report export is switched off: 404 feature_off, nothing read', async () => {
    const { get, asked } = setup({ flagOverrides: '' });
    for (const format of ['csv', 'pdf']) {
      const { res, bytes } = await get(`/v1/reports/${CLOSED}/export.${format}`, 'riley');
      expect(res.status).toBe(404);
      expect(problem(bytes).code).toBe('feature_off');
    }
    expect(asked).toEqual([]);
  });
});

const HEADING: ReportPdfHeading = {
  title: 'Report from 4 Sept 2026',
  person: 'Riley Ó Briain',
  organization: 'Acme Consulting',
  status: 'Closed',
  openedAt: new Date('2026-09-04T12:00:00.000Z'),
  closedAt: new Date('2026-09-05T08:30:00.000Z'),
  exportedAt: NOW,
};

describe('a report’s PDF summary', () => {
  it('heads it with the person, organization, status and dates, then the CSV’s table and totals', async () => {
    const [page, ...more] = await reportPdfText(HEADING, reportExportTable(EXPENSES));
    expect(more).toEqual([]);
    expect(page?.slice(0, 6)).toEqual([
      'Expense report',
      'Report from 4 Sept 2026',
      'Riley Ó Briain · Acme Consulting',
      'Status: Closed · Opened 4 Sept 2026 · Closed 5 Sept 2026',
      'Expenses dated 1 Sept 2026 to 3 Sept 2026',
      'Exported 4 Oct 2026, 12:00 UTC. Amounts as spent; each currency is totalled apart.',
    ]);
    const rest = page?.slice(6) ?? [];
    expect(rest.slice(0, 9)).toEqual([
      'Date',
      'Merchant',
      'Category',
      'Type',
      'Trip',
      'Purpose',
      'Note',
      'Amount',
      'Currency',
    ]);
    for (const shown of ['Zuni Café', 'Hotel Lindley', 'Two nights', '412.80', '43.70', 'Total']) {
      expect(rest).toContain(shown);
    }
    expect(rest.slice(-6)).toEqual(['Total', '412.80', 'EUR', 'Total', '43.70', 'USD']);
  });

  it('runs on to further pages with the table’s headings on each, never splitting a row', async () => {
    const many = Array.from({ length: 80 }, (_, i) =>
      expense({ merchant: `Merchant ${i + 1}`, trip: 'Chicago', amountMinor: 100 }),
    );
    const pages = await reportPdfText(HEADING, reportExportTable(many));
    expect(pages.length).toBe(3);
    for (const page of pages) expect(page.filter((t) => t === 'Merchant').length).toBe(1);
    expect(pages[1]?.slice(0, 2)).toEqual(['Date', 'Merchant']);
    const merchants = pages.flat().filter((t) => t.startsWith('Merchant '));
    expect(merchants).toEqual(many.map((e) => e.merchant));
    expect(pages[2]?.slice(-3)).toEqual(['Total', '80.00', 'USD']);
  });

  it('wraps a long cell, ends one too long for twelve lines in "…", and never fails on a character', async () => {
    const table = reportExportTable([
      expense({
        merchant: 'Ресторан 東京 ₹',
        trip: null,
        purpose: 'Customer advisory board and partner summit with the regional team',
        note: 'x'.repeat(5000),
      }),
    ]);
    const [page] = await reportPdfText({ ...HEADING, title: 'Отчёт · 東京' }, table);
    // The file is made too, its title and footer in the same characters.
    const bytes = await reportPdf({ ...HEADING, title: 'Отчёт · 東京' }, table);
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(1);
    expect(page?.[1]).toBe('????? · ??');
    expect(page).toContain('???????? ?? INR');
    const purpose = page?.filter((t) => /advisory|partner|regional/.test(t)) ?? [];
    expect(purpose.length).toBeGreaterThan(1);
    expect(purpose.join(' ')).toBe(
      'Customer advisory board and partner summit with the regional team',
    );
    const note = page?.filter((t) => /^x+…?$/.test(t)) ?? [];
    expect(note.length).toBe(12);
    expect(note.at(-1)?.endsWith('…')).toBe(true);
  });

  it('says so when nothing is on the report', async () => {
    const [page] = await reportPdfText(
      { ...HEADING, closedAt: null, status: 'Open' },
      reportExportTable([]),
    );
    expect(page).toContain('Nothing is on this report.');
    expect(page).toContain('No dated expenses');
    expect(page).toContain('Status: Open · Opened 4 Sept 2026');
  });
});

/** A flight and a hotel stay, as an organization with Journeys and stays keeps them (#83). */
const TRAVELLED: ExportExpense[] = [
  expense({
    merchant: 'United Airlines',
    amountMinor: 38_940,
    travel: { ...NO_TRAVEL, journeyFrom: 'SFO', journeyTo: 'ORD' },
  }),
  expense({
    date: '2026-10-01',
    merchant: 'Hilton Omaha',
    amountMinor: 41_260,
    travel: { ...NO_TRAVEL, checkIn: '2026-09-29', checkOut: '2026-10-01' },
  }),
];

describe('a journey and a stay in a report’s export (FR-INT-20, FR-INT-21, #83)', () => {
  it('exports a journey’s from and to and a stay’s nights while Journeys and stays is on', async () => {
    const { get } = setup({
      flagOverrides: 'reports.export=on,receipts.journeys=on',
      expenses: TRAVELLED,
    });
    const csv = await get(`/v1/reports/${CLOSED}/export.csv`, 'riley');
    expect(text(csv.bytes).split('\r\n').slice(0, 3)).toEqual([
      '\uFEFFDate,Merchant,From and to,Stay,Category,Type,Trip,Purpose,Note,Amount,Currency',
      '2026-09-01,United Airlines,SFO → ORD,,,,Chicago · partner review,Partner review,,389.40,USD',
      '2026-10-01,Hilton Omaha,,"2 nights, Sep 29 – Oct 1, 2026",,,Chicago · partner review,Partner review,,412.60,USD',
    ]);
    const pdf = await get(`/v1/reports/${CLOSED}/export.pdf`, 'riley');
    expect(pdf.res.status).toBe(200);
    expect((await PDFDocument.load(pdf.bytes)).getPageCount()).toBe(1);
  });

  it('exports a report as it always was while Journeys and stays is off', async () => {
    const { get } = setup({ expenses: TRAVELLED });
    const csv = await get(`/v1/reports/${CLOSED}/export.csv`, 'riley');
    expect(text(csv.bytes).split('\r\n').slice(0, 2)).toEqual([
      '\uFEFFDate,Merchant,Category,Type,Trip,Purpose,Note,Amount,Currency',
      '2026-09-01,United Airlines,,,Chicago · partner review,Partner review,,389.40,USD',
    ]);
    expect(text(csv.bytes)).not.toContain('SFO');
    expect(text(csv.bytes)).not.toContain('nights');
  });

  it('prints them in the PDF, the arrow as "->", every date and amount on one line', async () => {
    const [page] = await reportPdfText(HEADING, reportExportTable(TRAVELLED));
    const rest = page?.slice(6) ?? [];
    expect(rest.slice(0, 5)).toEqual(['Date', 'Merchant', 'From and to', 'Stay', 'Category']);
    expect(rest).toContain('SFO -> ORD');
    // The stay on two lines, broken between words.
    expect(rest).toContain('2 nights, Sep 29 –');
    expect(rest).toContain('Oct 1, 2026');
    for (const shown of ['2026-09-01', '2026-10-01', '389.40', '412.60', '802.00']) {
      expect(rest).toContain(shown);
    }
  });
});

describe('the PDF’s columns', () => {
  it('keeps a date, an amount and miles on one line however many columns a report adds', async () => {
    const everything = reportExportTable([
      expense({
        date: '2026-09-28',
        merchant: 'Hilton Omaha',
        amountMinor: 1_234_567,
        travel: {
          journeyFrom: 'Eppley Airfield',
          journeyTo: 'Hilton Omaha',
          checkIn: '2026-09-28',
          checkOut: '2026-10-01',
        },
        parts: [
          { category: 'Travel', type: 'Lodging', amountMinor: 1_200_000 },
          { category: 'Meals', type: 'Business meal', amountMinor: 34_567 },
        ],
        excluded: [{ line: 'Minibar', amountMinor: 2124, reason: 'personal', note: null }],
        miles: { measured: '138.4', claimed: '141.2', reason: 'Detour' },
      }),
    ]);
    expect(everything.columns).toHaveLength(16);
    const [page] = await reportPdfText(HEADING, everything);
    for (const shown of ['2026-09-28', '12000.00', '345.67', '12345.67', '138.4', '141.2']) {
      expect(page).toContain(shown);
    }
    expect(page?.filter((t) => t === 'USD')).toHaveLength(3);
  });

  it('holds a column at what it needs and shares the rest, or keeps the shares when all fit', () => {
    expect(fitWidths([1, 1, 2], [0, 0, 0], 400)).toEqual([100, 100, 200]);
    expect(fitWidths([1, 1, 2], [0, 150, 0], 400)).toEqual([250 / 3, 150, 500 / 3]);
    expect(fitWidths([1, 3], [50, 0], 100)).toEqual([50, 50]);
  });
});
