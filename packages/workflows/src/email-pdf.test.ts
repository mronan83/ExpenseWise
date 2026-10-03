import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { emailAsPdf, htmlAsText, MAX_PDF_PAGES } from './email-pdf.ts';

const UBER = `<html><head><style>.x{color:red}</style></head><body>
<table width="100%"><tr><td><img src="https://example.com/logo.png" alt="Uber"></td></tr>
<tr><td><h1>Thanks for riding, Riley</h1></td></tr>
<tr><td><table width="100%">
<tr><td>Total</td><td align="right"><b>$23.45</b></td></tr>
<tr><td>Trip fare</td><td>$18.00</td></tr>
<tr><td>Booking Fee</td><td>$2.50</td></tr>
</table></td></tr>
<tr><td><a href="https://example.com/pdf">Download PDF</a> &amp; more</td></tr>
</table><script>alert(1)</script></body></html>`;

describe('reading an HTML email as text', () => {
  it('keeps each amount beside its label, without pictures, links, styles or scripts', () => {
    const lines = htmlAsText(UBER).split('\n');
    expect(lines).toContain('Thanks for riding, Riley');
    expect(lines.find((l) => l.startsWith('Trip fare'))).toMatch(/^Trip fare\s+\$18\.00$/);
    expect(lines.find((l) => l.startsWith('Total'))).toMatch(/^Total\s+\$23\.45$/);
    expect(lines).toContain('Download PDF & more');
    const text = lines.join('\n');
    for (const gone of ['example.com', 'color:red', 'alert', 'Uber']) {
      expect(text).not.toContain(gone);
    }
  });
});

const pages = async (bytes: Uint8Array) => (await PDFDocument.load(bytes)).getPageCount();

describe('an email as a PDF', () => {
  it('is a PDF, the same bytes every time for the same email', async () => {
    const first = await emailAsPdf('Your Uber receipt', 'Total   $23.45');
    const again = await emailAsPdf('Your Uber receipt', 'Total   $23.45');
    expect(new TextDecoder().decode(first.subarray(0, 5))).toBe('%PDF-');
    expect(Buffer.from(first).equals(Buffer.from(again))).toBe(true);
    expect(await pages(first)).toBe(1);
    const other = await emailAsPdf('Your Uber receipt', 'Total   $23.46');
    expect(Buffer.from(first).equals(Buffer.from(other))).toBe(false);
  });

  it('writes characters its font lacks as currency codes or question marks, never failing', async () => {
    const bytes = await emailAsPdf('Ресторан 東京 🍣', 'Total ₹1,250.00 · € 12 — “ok” ••••1234');
    expect(await pages(bytes)).toBe(1);
  });

  it('keeps each line of the email on its own line', async () => {
    // About 58 lines fit a page: 100 short lines need two pages unless run together.
    const lines = Array.from({ length: 100 }, (_, i) => `Item ${i}   $1.00`).join('\n');
    expect(await pages(await emailAsPdf(null, lines))).toBe(2);
    expect(await pages(await emailAsPdf(null, lines.replaceAll('\n', '\r\n')))).toBe(2);
  });

  it('runs on to further pages, wrapping long lines, and stops at five', async () => {
    const lines = (n: number) =>
      Array.from({ length: n }, (_, i) => `Line ${i} ${'word '.repeat(40)}`).join('\n');
    expect(await pages(await emailAsPdf(null, lines(30)))).toBe(2);
    expect(await pages(await emailAsPdf(null, lines(1000)))).toBe(MAX_PDF_PAGES);
  });
});
