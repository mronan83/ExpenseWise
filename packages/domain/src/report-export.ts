import type { MemberRole } from './approvals.ts';
import { isCurrencyCode } from './currency.ts';
import type { ReportStatus } from './lifecycle/report.ts';
import { add, money, toDecimal, type Money } from './money.ts';

/**
 * An expense as a report's export lists it (FR-SET-01): what it was, where it is filed, why,
 * and the amount as spent.
 */
export interface ExportExpense {
  /** YYYY-MM-DD. */
  readonly date: string | null;
  readonly merchant: string | null;
  /** Its category and type, once the organization has them (#51); null until then. */
  readonly category: string | null;
  readonly type: string | null;
  /** The trip it is on; null for a local expense. */
  readonly trip: string | null;
  /** Why it was for business: its trip’s purpose, or a local expense’s justification. */
  readonly purpose: string | null;
  readonly note: string | null;
  readonly amountMinor: number | null;
  readonly currency: string | null;
}

/** A column of the export, as both the CSV and the PDF lay it out. */
export interface ExportColumn {
  readonly header: string;
  /**
   * Text a person or a receipt wrote. A spreadsheet must never run it as a formula, so the CSV
   * writes one that starts like a formula as plain text.
   */
  readonly text: boolean;
  readonly align: 'left' | 'right';
  /** Its share of a printed page’s width. */
  readonly width: number;
}

interface ColumnDefinition extends ExportColumn {
  readonly cell: (expense: ExportExpense, amount: Money | null) => string;
  /** What it shows on a total’s row. */
  readonly total: (total: Money) => string;
}

const text = (header: string, width: number, value: (e: ExportExpense) => string | null) =>
  ({
    header,
    text: true,
    align: 'left',
    width,
    cell: (e) => value(e) ?? '',
    total: () => '',
  }) satisfies ColumnDefinition;

/**
 * The export’s columns, in order: one place, so a column such as the amount converted to the
 * reimbursement currency (#62) is one more entry here, in the CSV and the PDF alike.
 */
const COLUMNS: readonly ColumnDefinition[] = [
  {
    header: 'Date',
    text: false,
    align: 'left',
    width: 9,
    cell: (e) => e.date ?? '',
    total: () => 'Total',
  },
  text('Merchant', 17, (e) => e.merchant),
  text('Category', 11, (e) => e.category),
  text('Type', 9, (e) => e.type),
  text('Trip', 15, (e) => e.trip),
  text('Purpose', 18, (e) => e.purpose),
  text('Note', 12, (e) => e.note),
  {
    header: 'Amount',
    text: false,
    align: 'right',
    width: 10,
    cell: (_, amount) => (amount ? toDecimal(amount) : ''),
    total: (t) => toDecimal(t),
  },
  {
    header: 'Currency',
    text: false,
    align: 'left',
    width: 7,
    cell: (e, amount) => amount?.currency ?? e.currency ?? '',
    total: (t) => t.currency,
  },
];

/** A report’s export as a table: a row per expense, then a row per currency’s total. */
export interface ReportExportTable {
  readonly columns: readonly ExportColumn[];
  readonly rows: readonly (readonly string[])[];
  /** Each currency’s total, never converted (until #62), in currency order. */
  readonly totals: readonly Money[];
  readonly totalRows: readonly (readonly string[])[];
  /** The first and last dates of its expenses; null when none is dated. */
  readonly dated: { readonly from: string; readonly to: string } | null;
}

const amountOf = (e: ExportExpense): Money | null =>
  e.amountMinor !== null && e.currency !== null && isCurrencyCode(e.currency)
    ? money(e.amountMinor, e.currency)
    : null;

/**
 * The rows of a report’s export, in the order given, with each currency’s total. The CSV and
 * the PDF are both written from this table.
 */
export function reportExportTable(expenses: readonly ExportExpense[]): ReportExportTable {
  const totals = new Map<string, Money>();
  const rows = expenses.map((e) => {
    const amount = amountOf(e);
    if (amount) {
      const sofar = totals.get(amount.currency);
      totals.set(amount.currency, sofar ? add(sofar, amount) : amount);
    }
    return COLUMNS.map((c) => c.cell(e, amount));
  });
  const sorted = [...totals.values()].sort((a, b) => a.currency.localeCompare(b.currency));
  const dates = expenses.flatMap((e) => (e.date ? [e.date] : [])).sort();
  const [from] = dates;
  return {
    columns: COLUMNS.map(({ header, text, align, width }) => ({ header, text, align, width })),
    rows,
    totals: sorted,
    totalRows: sorted.map((t) => COLUMNS.map((c) => c.total(t))),
    dated: from ? { from, to: dates[dates.length - 1] ?? from } : null,
  };
}

/** What a spreadsheet would read as the start of a formula (OWASP, CSV injection). */
const FORMULA_START = /^[=+\-@\t\r]/;

function csvCell(value: string, isText: boolean): string {
  const safe = isText && FORMULA_START.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

/**
 * The table as CSV (RFC 4180): comma-separated, quoted where needed, lines ending CRLF. It
 * starts with a UTF-8 byte order mark, without which Excel reads the file in the computer’s
 * own code page and garbles “Café” and “€”; Numbers and Google Sheets ignore it.
 */
export function reportCsv(table: ReportExportTable): string {
  const line = (cells: readonly string[]) =>
    cells.map((cell, i) => csvCell(cell, table.columns[i]?.text ?? true)).join(',');
  const lines = [table.columns.map((c) => c.header), ...table.rows, ...table.totalRows].map(line);
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

/**
 * Whether a report can be exported: once it has closed, and at every state after it. Until
 * approval (#24) exists a report goes no further than closed, so this is the closed report.
 */
export function isReportExportable(status: ReportStatus): boolean {
  return status !== 'open';
}

/** Roles that see every member’s reports: the owner, finance admins, and auditors, who read. */
const EVERY_REPORT: ReadonlySet<MemberRole> = new Set(['owner', 'finance_admin', 'auditor']);

/** Who may export a report: the member whose report it is, or a role that sees every report. */
export function canExportReport(role: MemberRole, ownReport: boolean): boolean {
  return ownReport || EVERY_REPORT.has(role);
}
