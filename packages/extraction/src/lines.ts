import {
  assertCurrency,
  DomainError,
  fromDecimal,
  type CurrencyCode,
  type Itemization,
  type ReadLine,
} from '@expensewise/domain';
import { StoredReadingSchema } from './schema.ts';

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
  if (!parsed.success) return null;
  const reading = parsed.data;
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
    const lines: ReadLine[] = [
      ...reading.lineItems.map((item, i) => ({
        kind: 'item' as const,
        description: label(item.description, `Item ${i + 1}`),
        quantity: item.quantity?.trim() || null,
        amount: amount(item.amount),
      })),
      ...reading.taxes.map((tax) => ({
        kind: 'tax' as const,
        description: label(tax.label, 'Tax'),
        quantity: null,
        amount: amount(tax.value),
      })),
      ...reading.fees.map((fee) => ({
        kind: 'fee' as const,
        description: label(fee.label, 'Fee'),
        quantity: null,
        amount: amount(fee.value),
      })),
      ...(reading.tip
        ? [
            {
              kind: 'tip' as const,
              description: 'Tip',
              quantity: null,
              amount: amount(reading.tip.value),
            },
          ]
        : []),
    ];
    return {
      currency,
      total: reading.total ? amount(reading.total.value) : null,
      subtotal: reading.subtotal ? amount(reading.subtotal.value) : null,
      lines,
    };
  } catch (error) {
    if (error instanceof DomainError) return null;
    throw error;
  }
}
