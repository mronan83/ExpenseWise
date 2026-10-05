import type { ReportExportTable } from '@expensewise/domain';
import { PDFDocument, rgb, StandardFonts, type PDFFont } from 'pdf-lib';

/** What heads a report’s PDF: whose it is, where, and when (FR-SET-01). */
export interface ReportPdfHeading {
  readonly title: string;
  readonly person: string;
  readonly organization: string;
  /** As a person reads it: Closed, Approved… */
  readonly status: string;
  readonly openedAt: Date;
  readonly closedAt: Date | null;
  readonly exportedAt: Date;
}

/** US Letter, landscape, so the table’s nine columns, and any a report adds, have room. */
const PAGE = { width: 792, height: 612, margin: 36 };
const SIZE = 8.5;
const LEADING = 11;
const PAD = 4;
/** A cell longer than this, such as a long note, ends in "…"; the CSV keeps all of it. */
const MAX_CELL_LINES = 12;
/** More than twelve lines of the widest column hold, so a cell cut here still ends in "…". */
const MAX_CELL_CHARS = 2000;
const FOOTER = PAGE.margin - 16;
const GREY = rgb(0.55, 0.55, 0.55);

/**
 * Currency signs the standard fonts lack, written as their ISO 4217 codes, as in the PDF made
 * from an email (packages/workflows/src/email-pdf.ts, ADR-0027).
 */
const CURRENCY_SIGNS: Record<string, string> = {
  '₹': 'INR ',
  '₩': 'KRW ',
  '₪': 'ILS ',
  '₫': 'VND ',
  '₱': 'PHP ',
  '₺': 'TRY ',
  '₽': 'RUB ',
  '฿': 'THB ',
  '₦': 'NGN ',
  '₴': 'UAH ',
};

/** Other signs the export writes that the standard fonts lack: a journey’s arrow (FR-INT-20). */
const OTHER_SIGNS: Record<string, string> = { '→': '->' };

interface Placed {
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly size: number;
  readonly font: PDFFont;
}

interface Layout {
  readonly pdf: PDFDocument;
  readonly pages: { readonly texts: Placed[]; readonly rules: number[] }[];
  readonly font: PDFFont;
  readonly printable: (text: string, font: PDFFont) => string;
}

const day = (at: Date) =>
  at.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
const isoDay = (date: string) => day(new Date(`${date}T00:00:00Z`));

/**
 * Each column’s width: its share of `usable`, except that one whose share would fall short of
 * what it needs is held at that, and the others share what is left. A report whose columns all
 * fit is laid out by its shares alone, as it always was.
 */
export function fitWidths(
  shares: readonly number[],
  needs: readonly number[],
  usable: number,
): number[] {
  const held = new Set<number>();
  for (;;) {
    const room = usable - [...held].reduce((sum, i) => sum + (needs[i] ?? 0), 0);
    const share = shares.reduce((sum, s, i) => (held.has(i) ? sum : sum + s), 0);
    const short = shares.findIndex((s, i) => !held.has(i) && (room * s) / share < (needs[i] ?? 0));
    if (short === -1) {
      return shares.map((s, i) => (held.has(i) ? (needs[i] ?? 0) : (room * s) / share));
    }
    held.add(short);
  }
}

/**
 * Lays the report out: its heading, the export’s table, its totals per currency and a footer
 * on each page. A row never splits across pages, and the table’s headings repeat on each.
 */
async function layOut(heading: ReportPdfHeading, table: ReportExportTable): Promise<Layout> {
  const pdf = await PDFDocument.create({ updateMetadata: false });
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const known = new Map([regular, bold].map((f) => [f, new Set(f.getCharacterSet())]));

  /** The text in characters the font has: currency signs as codes, anything else as "?". */
  const printable = (text: string, font: PDFFont) =>
    [...text.normalize('NFKC').replace(/\s+/g, ' ')]
      .map(
        (c) =>
          CURRENCY_SIGNS[c] ??
          OTHER_SIGNS[c] ??
          (known.get(font)?.has(c.codePointAt(0) ?? 0) ? c : '?'),
      )
      .join('');
  const fits = (text: string, font: PDFFont, width: number) =>
    font.widthOfTextAtSize(text, SIZE) <= width;

  /** Lines no wider than `width`, broken between words where it can, at most MAX_CELL_LINES. */
  const wrap = (raw: string, font: PDFFont, width: number): string[] => {
    const lines: string[] = [];
    let current = '';
    for (const word of printable(raw.slice(0, MAX_CELL_CHARS), font).trim().split(' ')) {
      if (lines.length > MAX_CELL_LINES) break;
      const joined = current ? `${current} ${word}` : word;
      if (fits(joined, font, width)) {
        current = joined;
        continue;
      }
      if (current) lines.push(current);
      current = word;
      // A word wider than the column, such as a link, breaks at the most that fits.
      while (!fits(current, font, width) && current.length > 1) {
        let [lo, hi] = [1, current.length - 1];
        while (lo < hi) {
          const mid = Math.ceil((lo + hi) / 2);
          if (fits(current.slice(0, mid), font, width)) lo = mid;
          else hi = mid - 1;
        }
        lines.push(current.slice(0, lo));
        current = current.slice(lo);
      }
    }
    if (current) lines.push(current);
    if (lines.length <= MAX_CELL_LINES) return lines;
    let last = lines[MAX_CELL_LINES - 1] ?? '';
    while (last && !fits(`${last}…`, font, width)) last = last.slice(0, -1);
    return [...lines.slice(0, MAX_CELL_LINES - 1), `${last}…`];
  };

  /**
   * No column is narrower than its heading’s longest word, and a column of figures (a date,
   * an amount, a currency, miles) than its widest value, so however many columns a report
   * adds, such as From and to or Stay, a heading’s word or a figure is never broken across
   * lines; text wraps instead.
   */
  const widest = (texts: readonly string[], font: PDFFont) =>
    Math.max(0, ...texts.map((t) => font.widthOfTextAtSize(printable(t, font), SIZE)));
  const needs = table.columns.map(
    (c, i) =>
      2 * PAD +
      Math.max(
        widest(c.header.split(' '), bold),
        ...(c.text
          ? []
          : [
              widest(
                table.rows.map((r) => r[i] ?? ''),
                regular,
              ),
              widest(
                table.totalRows.map((r) => r[i] ?? ''),
                bold,
              ),
            ]),
      ),
  );
  const widths = fitWidths(
    table.columns.map((c) => c.width),
    needs,
    PAGE.width - 2 * PAGE.margin,
  );
  const columns = table.columns.reduce<{ left: number; width: number; right: boolean }[]>(
    (placed, c, i) => {
      const prior = placed[placed.length - 1];
      const left = prior ? prior.left + prior.width : PAGE.margin;
      return [...placed, { left, width: widths[i] ?? 0, right: c.align === 'right' }];
    },
    [],
  );

  const pages: Layout['pages'] = [];
  let page = { texts: [] as Placed[], rules: [] as number[] };
  let y = 0;
  const newPage = () => {
    page = { texts: [], rules: [] };
    pages.push(page);
    y = PAGE.height - PAGE.margin;
  };
  const write = (text: string, x: number, size: number, font: PDFFont) => {
    if (text) page.texts.push({ text, x, y: y - size, size, font });
  };

  /** One row of the table, each cell wrapped in its column; a new page first if it won’t fit. */
  const row = (cells: readonly string[], font: PDFFont, header = false) => {
    const wrapped = columns.map((c, i) => wrap(cells[i] ?? '', font, c.width - 2 * PAD));
    const height = Math.max(1, ...wrapped.map((w) => w.length)) * LEADING;
    if (!header && y - height < PAGE.margin) {
      newPage();
      tableHeader();
    }
    wrapped.forEach((lines, i) => {
      const c = columns[i]!;
      lines.forEach((line, n) => {
        const width = font.widthOfTextAtSize(line, SIZE);
        const x = c.right ? c.left + c.width - PAD - width : c.left + PAD;
        page.texts.push({ text: line, x, y: y - SIZE - n * LEADING, size: SIZE, font });
      });
    });
    y -= height + 3;
  };
  const tableHeader = () => {
    row(
      table.columns.map((c) => c.header),
      bold,
      true,
    );
    page.rules.push(y + 1.5);
  };

  newPage();
  write('Expense report', PAGE.margin, 16, bold);
  y -= 22;
  write(printable(heading.title, bold), PAGE.margin, 12, bold);
  y -= 18;
  const facts = [
    `${heading.person} · ${heading.organization}`,
    [
      `Status: ${heading.status}`,
      `Opened ${day(heading.openedAt)}`,
      ...(heading.closedAt ? [`Closed ${day(heading.closedAt)}`] : []),
    ].join(' · '),
    table.dated
      ? `Expenses dated ${isoDay(table.dated.from)} to ${isoDay(table.dated.to)}`
      : 'No dated expenses',
    `Exported ${day(heading.exportedAt)}, ${heading.exportedAt.toISOString().slice(11, 16)} UTC. ` +
      'Amounts as spent; each currency is totalled apart.',
  ];
  for (const fact of facts) {
    write(printable(fact, regular), PAGE.margin, 9.5, regular);
    y -= 13;
  }
  y -= 8;

  tableHeader();
  for (const cells of table.rows) row(cells, regular);
  if (table.rows.length === 0) {
    write('Nothing is on this report.', PAGE.margin + PAD, SIZE, regular);
    y -= LEADING;
  }
  if (table.totalRows.length > 0) {
    if (y - LEADING * (table.totalRows.length + 1) < PAGE.margin) {
      newPage();
      tableHeader();
    }
    page.rules.push(y + 1.5);
    y -= 3;
    for (const cells of table.totalRows) row(cells, bold);
  }
  // Notes after the totals, such as where a measured route came from (ADR-0039).
  for (const note of table.notes ?? []) {
    if (y - 2 * LEADING < PAGE.margin) newPage();
    y -= 6;
    write(printable(note, regular), PAGE.margin, 7.5, regular);
    y -= LEADING;
  }
  return { pdf, pages, font: regular, printable };
}

/**
 * A report as a PDF summary (FR-SET-01): who, where and when, a row per expense, and each
 * currency’s total, with no receipt images. The standard Helvetica is used, never embedded,
 * so the file stays small; it covers Latin script, and currency signs it lacks are written as
 * their codes. Laying out a report of a few hundred expenses takes milliseconds of CPU, so it
 * is made in the request.
 */
export async function reportPdf(
  heading: ReportPdfHeading,
  table: ReportExportTable,
): Promise<Uint8Array<ArrayBuffer>> {
  const { pdf, pages, font: footer, printable } = await layOut(heading, table);
  const title = printable(heading.title, footer);
  pdf.setTitle(heading.title);
  pages.forEach((laid, i) => {
    const page = pdf.addPage([PAGE.width, PAGE.height]);
    for (const t of laid.texts)
      page.drawText(t.text, { x: t.x, y: t.y, size: t.size, font: t.font });
    for (const at of laid.rules) {
      page.drawLine({
        start: { x: PAGE.margin, y: at },
        end: { x: PAGE.width - PAGE.margin, y: at },
        thickness: 0.5,
        color: GREY,
      });
    }
    page.drawText(title, { x: PAGE.margin, y: FOOTER, size: 7.5, font: footer, color: GREY });
    const number = `Page ${i + 1} of ${pages.length}`;
    page.drawText(number, {
      x: PAGE.width - PAGE.margin - footer.widthOfTextAtSize(number, 7.5),
      y: FOOTER,
      size: 7.5,
      font: footer,
      color: GREY,
    });
  });
  return new Uint8Array(await pdf.save({ useObjectStreams: false }));
}

/** What each page of the PDF says, in the order it is written: for checking it. */
export async function reportPdfText(
  heading: ReportPdfHeading,
  table: ReportExportTable,
): Promise<string[][]> {
  const { pages } = await layOut(heading, table);
  return pages.map((p) => p.texts.map((t) => t.text));
}
