import {
  assertCurrency,
  DomainError,
  fromDecimal,
  isIsoDate,
  type CurrencyCode,
  type Itemization,
  type Purchase,
  type ReadLine,
} from '@expensewise/domain';
import { StoredReadingSchema, type ReceiptExtraction } from './schema.ts';

/**
 * A reading’s itemized lines, as its expense keeps them (FR-INT-22, ADR-0041): each item as
 * printed, each time it is printed, a discount or a credit as a negative item of its own (#92),
 * then each tax, each fee and the tip, with the total and subtotal read, all in integer minor
 * units. Null when the reading prints no item lines, or
 * when any line, the total or the subtotal can’t be read exactly in the reading’s currency:
 * lines that can’t all be read are never shown as if they were.
 */
export function itemizationOf(output: unknown): Itemization | null {
  const parsed = StoredReadingSchema.safeParse(output);
  return parsed.success ? itemizationOfReading(parsed.data) : null;
}

/**
 * The lines of a reading already parsed, as `itemizationOf` reads them. A reading of several
 * purchases (FR-INT-23, `purchases-v1`) lists them, and its lines go purchase by purchase, each
 * naming the one it belongs to: a line that names none is the first's, the purchase the
 * document is for, and the tip is too. One that lists one purchase, or none, reads as before.
 */
export function itemizationOfReading(reading: ReceiptExtraction): Itemization | null {
  if (reading.lineItems.length === 0 || !reading.currency) return null;
  let currency: CurrencyCode;
  try {
    currency = assertCurrency(reading.currency.code.trim().toUpperCase());
  } catch {
    return null;
  }
  try {
    const amount = (value: string) => fromDecimal(value.trim(), currency);
    const label = (text: string, fallback: string) => text.trim() || fallback;
    const read = reading.purchases ?? [];
    const grouped = read.length > 1;
    const of = (purchase: number | null | undefined) =>
      grouped ? { purchase: purchase ?? 1 } : {};
    const lines: ReadLine[] = [
      ...reading.lineItems.map((item, i) => ({
        kind: 'item' as const,
        description: label(item.description, `Item ${i + 1}`),
        quantity: item.quantity?.trim() || null,
        amount: amount(item.amount),
        ...of(item.purchase),
      })),
      ...reading.taxes.map((tax) => ({
        kind: 'tax' as const,
        description: label(tax.label, 'Tax'),
        quantity: null,
        amount: amount(tax.value),
        ...of(tax.purchase),
      })),
      ...reading.fees.map((fee) => ({
        kind: 'fee' as const,
        description: label(fee.label, 'Fee'),
        quantity: null,
        amount: amount(fee.value),
        ...of(fee.purchase),
      })),
      ...(reading.tip
        ? [
            {
              kind: 'tip' as const,
              description: 'Tip',
              quantity: null,
              amount: amount(reading.tip.value),
              ...of(1),
            },
          ]
        : []),
    ];
    const purchases: Purchase[] = grouped
      ? read.map((p, i) => ({
          description: label(p.description, `Purchase ${i + 1}`),
          date: p.date && isIsoDate(p.date.value.trim()) ? p.date.value.trim() : null,
          cardLastFour:
            p.cardLastFour && /^\d{4}$/.test(p.cardLastFour.value.trim())
              ? p.cardLastFour.value.trim()
              : null,
          total: p.total ? amount(p.total.value) : null,
        }))
      : [];
    return {
      currency,
      total: reading.total ? amount(reading.total.value) : null,
      subtotal: reading.subtotal ? amount(reading.subtotal.value) : null,
      // Purchase by purchase, as printed; the sort keeps each one's items, taxes, fees, tip.
      lines: grouped
        ? lines
            .map((line, i) => ({ line, i }))
            .sort((a, b) => (a.line.purchase ?? 1) - (b.line.purchase ?? 1) || a.i - b.i)
            .map((x) => x.line)
        : lines,
      ...(grouped ? { purchases } : {}),
    };
  } catch (error) {
    if (error instanceof DomainError) return null;
    throw error;
  }
}
