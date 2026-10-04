import { convert } from 'html-to-text';
import { PDFDocument, StandardFonts, type PDFFont } from 'pdf-lib';

/**
 * HTML as plain text, for reading and for the PDF made from it: no scripts, styles, pictures
 * or link targets, and each table row on one line with its cells in columns, so "Trip fare"
 * stays beside "$18.00".
 */
export function htmlAsText(html: string): string {
  return convert(html, {
    wordwrap: false,
    selectors: [
      { selector: 'img', format: 'skip' },
      { selector: 'a', options: { ignoreHref: true } },
      { selector: 'table', format: 'dataTable', options: { uppercaseHeaderCells: false } },
      ...['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].map((selector) => ({
        selector,
        options: { uppercase: false },
      })),
    ],
  })
    .replace(/[^\S\n]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Currency signs the PDF's standard font lacks, written as their ISO 4217 codes instead. */
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

const PAGE = { width: 612, height: 792, margin: 48 };
/**
 * Every page is read by each model, at a cost to the organization's key; a receipt never needs
 * more than this, while a long newsletter would.
 */
export const MAX_PDF_PAGES = 5;
const SIZE = 9;
const LEADING = 12;

/** The text in characters the font has: currency signs as codes, anything else as "?". */
function printable(text: string, font: PDFFont): string {
  const known = new Set(font.getCharacterSet());
  return [...text.normalize('NFKC')]
    .map((c) => {
      if (c === '\t') return '    ';
      if (CURRENCY_SIGNS[c]) return CURRENCY_SIGNS[c];
      return known.has(c.codePointAt(0) ?? 0) ? c : '?';
    })
    .join('');
}

/** Lines no wider than `width` characters, broken between words where it can. */
function wrap(line: string, width: number): string[] {
  const lines: string[] = [];
  let rest = line;
  while (rest.length > width) {
    const space = rest.lastIndexOf(' ', width);
    const cut = space > width / 2 ? space : width;
    lines.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^ /, '');
  }
  lines.push(rest);
  return lines;
}

/**
 * The text of an emailed receipt as a PDF, the proof it is filed with (ADR-0027). Monospaced,
 * so columns of amounts stay lined up, at most five pages, and the same bytes every time for
 * the same text: no dates or ids are written, so a retried step stores the same file, and the
 * same text sent again is filed once; a forward adds text of its own, so it is caught by what it reads instead (ADR-0028).
 */
export async function emailAsPdf(subject: string | null, body: string): Promise<Uint8Array> {
  const pdf = await PDFDocument.create({ updateMetadata: false });
  const font = await pdf.embedFont(StandardFonts.Courier);
  const bold = await pdf.embedFont(StandardFonts.CourierBold);
  const columns = Math.floor((PAGE.width - 2 * PAGE.margin) / font.widthOfTextAtSize('M', SIZE));
  const lines: { text: string; font: PDFFont }[] = [
    { text: 'Received by email', font: bold },
    ...wrap(printable(`Subject: ${subject ?? '(none)'}`, font), columns).map((text) => ({
      text,
      font,
    })),
    { text: '', font },
    ...body
      .split(/\r?\n/)
      .flatMap((line) => wrap(printable(line, font), columns))
      .map((text) => ({ text, font })),
  ];
  const perPage = Math.floor((PAGE.height - 2 * PAGE.margin) / LEADING);
  const room = perPage * MAX_PDF_PAGES;
  if (lines.length > room) {
    lines.splice(room - 1, Infinity, { text: '[The email goes on; the rest is left out.]', font });
  }
  for (let start = 0; start < lines.length; start += perPage) {
    const page = pdf.addPage([PAGE.width, PAGE.height]);
    lines.slice(start, start + perPage).forEach((line, i) => {
      page.drawText(line.text, {
        x: PAGE.margin,
        y: PAGE.height - PAGE.margin - SIZE - i * LEADING,
        size: SIZE,
        font: line.font,
      });
    });
  }
  return pdf.save({ useObjectStreams: false });
}
