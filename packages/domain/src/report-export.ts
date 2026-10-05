import type { MemberRole } from './approvals.ts';
import { isCurrencyCode } from './currency.ts';
import { EXCLUSION_REASON_LABELS, type ExclusionReason } from './itemized.ts';
import { journeyLine, stayLine, type ExpenseTravel } from './journeys.ts';
import type { ReportStatus } from './lifecycle/report.ts';
import { add, money, toDecimal, type Money } from './money.ts';
import { ROUTE_ATTRIBUTION } from './route-mileage.ts';

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
  /**
   * A drive's miles, while route mileage is on (Q33): those measured on its route, if it was
   * measured, those claimed, and the person's reason when the two differ.
   */
  readonly miles?: ExportMiles | null;
  /** Its parts, when it is split (FR-EXP-15): a row each, in the expense’s currency. */
  readonly parts?: readonly ExportPart[];
  /** The lines of its receipt left out of the claim, with why (FR-EXP-16). */
  readonly excluded?: readonly ExportExclusion[];
  /**
   * Where a journey went and when a hotel stay was, while Journeys and stays is on (FR-INT-20,
   * FR-INT-21): shown as on the expense, “SFO → ORD” and “2 nights, Sep 29 – Oct 1, 2026”.
   */
  readonly travel?: ExpenseTravel | null;
}

/** A drive's miles as the export shows them. */
export interface ExportMiles {
  readonly measured: string | null;
  readonly claimed: string;
  readonly reason: string | null;
}

/** A part of a split expense: its own category, type and amount. */
export interface ExportPart {
  readonly category: string | null;
  readonly type: string | null;
  readonly amountMinor: number;
}

/** A line left out of an expense’s claim: the line, what it took off with its share, and why. */
export interface ExportExclusion {
  readonly line: string;
  readonly amountMinor: number;
  readonly reason: ExclusionReason;
  readonly note: string | null;
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

/**
 * One row of the export: an expense, or one part of a split one, with the amount it shows. A
 * part has its own category and type, and says which part of the expense it is.
 */
interface ExportRow {
  readonly expense: ExportExpense;
  readonly amount: Money | null;
  readonly category: string | null;
  readonly type: string | null;
  /** "1 of 2" for a part; empty for a whole expense. */
  readonly part: string;
  /** Its excluded lines, on an expense’s first row. */
  readonly excluded: string;
}

interface ColumnDefinition extends ExportColumn {
  readonly cell: (row: ExportRow) => string;
  /** What it shows on a total’s row. */
  readonly total: (total: Money) => string;
}

const text = (header: string, width: number, value: (row: ExportRow) => string | null) =>
  ({
    header,
    text: true,
    align: 'left',
    width,
    cell: (row) => value(row) ?? '',
    total: () => '',
  }) satisfies ColumnDefinition;

/** Only when the report has a split expense: which part of its expense a row is (FR-EXP-15). */
const PART = text('Part', 6, (r) => r.part);
/** Only when the report has an excluded line: each, with what it took off and why (FR-EXP-16). */
const EXCLUDED = text('Excluded', 16, (r) => r.excluded);
/**
 * Only when the report has a journey: where it went, “SFO → ORD”, as the expense shows it
 * (FR-INT-20). Text a receipt printed, so the CSV never runs it as a formula.
 */
const JOURNEY = text('From and to', 14, (r) =>
  r.expense.travel ? journeyLine(r.expense.travel) : null,
);
/**
 * Only when the report has a stay: its nights and dates, “2 nights, Sep 29 – Oct 1, 2026”,
 * worked out from its check-in and check-out as on the expense (FR-INT-21).
 */
const STAY = text('Stay', 16, (r) => (r.expense.travel ? stayLine(r.expense.travel) : null));

/** Which of the columns that join only when a report needs them it has. */
interface OptionalColumns {
  readonly parts: boolean;
  readonly excluded: boolean;
  readonly journeys: boolean;
  readonly stays: boolean;
}

/**
 * The export’s columns, in order: one place, so a column such as the amount converted to the
 * reimbursement currency (#62) is one more entry here, in the CSV and the PDF alike. From and
 * to, Stay, Part and Excluded each join them only when a report has a journey, a stay, a split
 * expense or an excluded line, so every other report exports exactly as before.
 */
function columnsFor(has: OptionalColumns): readonly ColumnDefinition[] {
  return [
    {
      header: 'Date',
      text: false,
      align: 'left',
      width: 9,
      cell: (r) => r.expense.date ?? '',
      total: () => 'Total',
    },
    text('Merchant', 17, (r) => r.expense.merchant),
    ...(has.journeys ? [JOURNEY] : []),
    ...(has.stays ? [STAY] : []),
    ...(has.parts ? [PART] : []),
    text('Category', 11, (r) => r.category),
    text('Type', 9, (r) => r.type),
    text('Trip', 15, (r) => r.expense.trip),
    text('Purpose', 18, (r) => r.expense.purpose),
    text('Note', 12, (r) => r.expense.note),
    ...(has.excluded ? [EXCLUDED] : []),
    {
      header: 'Amount',
      text: false,
      align: 'right',
      width: 10,
      cell: (r) => (r.amount ? toDecimal(r.amount) : ''),
      total: (t) => toDecimal(t),
    },
    {
      header: 'Currency',
      text: false,
      align: 'left',
      width: 7,
      cell: (r) => r.amount?.currency ?? r.expense.currency ?? '',
      total: (t) => t.currency,
    },
  ];
}

/**
 * The columns a report with a measured route adds, after the rest (Q33): the miles measured,
 * the miles claimed and why they differ. A report with none is exported as it always was.
 */
const MILES_COLUMNS: readonly ColumnDefinition[] = [
  {
    header: 'Miles measured',
    text: false,
    align: 'right',
    width: 7,
    cell: (r) => r.expense.miles?.measured ?? '',
    total: () => '',
  },
  {
    header: 'Miles claimed',
    text: false,
    align: 'right',
    width: 7,
    cell: (r) => r.expense.miles?.claimed ?? '',
    total: () => '',
  },
  text('Why the miles differ', 14, (r) => r.expense.miles?.reason ?? null),
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
  /** Lines written after the totals: where a measured route came from (ADR-0039). */
  readonly notes?: readonly string[];
}

const amountOf = (e: ExportExpense): Money | null =>
  e.amountMinor !== null && e.currency !== null && isCurrencyCode(e.currency)
    ? money(e.amountMinor, e.currency)
    : null;

/** An expense’s excluded lines in one cell: "Minibar: 21.27, Personal; Movie: 9.99, Other (…)". */
function excludedText(e: ExportExpense): string {
  const currency = e.currency !== null && isCurrencyCode(e.currency) ? e.currency : null;
  return (e.excluded ?? [])
    .map((x) => {
      const amount = currency ? toDecimal(money(x.amountMinor, currency)) : '';
      const why = `${EXCLUSION_REASON_LABELS[x.reason]}${x.note ? ` (${x.note})` : ''}`;
      return `${x.line}: ${amount}, ${why}`;
    })
    .join('; ');
}

/** The rows an expense makes: one, or one per part, its excluded lines on the first. */
function rowsOf(e: ExportExpense): ExportRow[] {
  const excluded = excludedText(e);
  const parts = e.parts ?? [];
  const currency = e.currency !== null && isCurrencyCode(e.currency) ? e.currency : null;
  if (parts.length === 0 || !currency) {
    return [
      { expense: e, amount: amountOf(e), category: e.category, type: e.type, part: '', excluded },
    ];
  }
  return parts.map((p, i) => ({
    expense: e,
    amount: money(p.amountMinor, currency),
    category: p.category,
    type: p.type,
    part: `${i + 1} of ${parts.length}`,
    excluded: i === 0 ? excluded : '',
  }));
}

/**
 * The rows of a report’s export, in the order given, with each currency’s total. A split
 * expense is a row per part, each marked as which part of it it is; its parts add up to it, so
 * the totals are the same either way. The CSV and the PDF are both written from this table.
 */
export function reportExportTable(expenses: readonly ExportExpense[]): ReportExportTable {
  const routed = expenses.some((e) => (e.miles?.measured ?? null) !== null);
  const base = columnsFor({
    parts: expenses.some((e) => (e.parts?.length ?? 0) > 0),
    excluded: expenses.some((e) => (e.excluded?.length ?? 0) > 0),
    journeys: expenses.some((e) => (e.travel ? journeyLine(e.travel) : null) !== null),
    stays: expenses.some((e) => (e.travel ? stayLine(e.travel) : null) !== null),
  });
  const columns = routed ? [...base, ...MILES_COLUMNS] : base;
  const totals = new Map<string, Money>();
  const rows = expenses.flatMap((e) =>
    rowsOf(e).map((row) => {
      if (row.amount) {
        const sofar = totals.get(row.amount.currency);
        totals.set(row.amount.currency, sofar ? add(sofar, row.amount) : row.amount);
      }
      return columns.map((c) => c.cell(row));
    }),
  );
  const sorted = [...totals.values()].sort((a, b) => a.currency.localeCompare(b.currency));
  const dates = expenses.flatMap((e) => (e.date ? [e.date] : [])).sort();
  const [from] = dates;
  return {
    columns: columns.map(({ header, text, align, width }) => ({ header, text, align, width })),
    rows,
    totals: sorted,
    totalRows: sorted.map((t) => columns.map((c) => c.total(t))),
    dated: from ? { from, to: dates[dates.length - 1] ?? from } : null,
    ...(routed ? { notes: [ROUTE_ATTRIBUTION] } : {}),
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
  // A note is a line of its own after the totals, such as where a measured route came from.
  const notes = (table.notes ?? []).map((n) => csvCell(n, true));
  return `\uFEFF${[...lines, ...notes].join('\r\n')}\r\n`;
}

/**
 * Whether a report can be exported: once it has closed, and at every state after it, while
 * approval is off, since then a report goes no further than closed.
 */
export function isReportExportable(status: ReportStatus): boolean {
  return status !== 'open';
}

/** A report's states from submission on. */
const SUBMITTED: ReadonlySet<ReportStatus> = new Set([
  'submitted',
  'in_approval',
  'approved',
  'settled',
]);

/**
 * Whether a report can be exported once approval exists: submitted and approved reports only,
 * by your answer to Q29. A closed report is checked, and sent, by submitting it.
 */
export function isExportableOnceApproved(status: ReportStatus): boolean {
  return SUBMITTED.has(status);
}

/** Roles that see every member’s reports: the owner, finance admins, and auditors, who read. */
const EVERY_REPORT: ReadonlySet<MemberRole> = new Set(['owner', 'finance_admin', 'auditor']);

/** Who may export a report: the member whose report it is, or a role that sees every report. */
export function canExportReport(role: MemberRole, ownReport: boolean): boolean {
  return ownReport || EVERY_REPORT.has(role);
}
