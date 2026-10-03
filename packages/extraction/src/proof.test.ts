import { money, NO_VALUES, type ExpenseValues } from '@expensewise/domain';
import { describe, expect, it } from 'vitest';
import { normalizeExtraction } from './normalize.ts';
import { proofDifferences, valuesOfConfirmed, valuesOfReading } from './proof.ts';
import type { ReceiptExtraction } from './schema.ts';

const reading = (over: Partial<ReceiptExtraction> = {}): ReceiptExtraction => ({
  documentType: 'receipt',
  merchant: { name: 'Blue Bottle Coffee', confidence: 'high' },
  date: { value: '2026-09-24', confidence: 'high' },
  currency: { code: 'USD', confidence: 'high' },
  total: { value: '6.50', confidence: 'high' },
  subtotal: null,
  taxes: [],
  tip: null,
  cardLastFour: null,
  lineItems: [],
  ...over,
});
const coffee: ExpenseValues = {
  merchant: 'Blue Bottle Coffee',
  transactionDate: '2026-09-24',
  currency: 'USD',
  amountMinor: 650,
};

describe('valuesOfReading', () => {
  it('takes merchant, date, currency and total from a reading', () => {
    expect(valuesOfReading(normalizeExtraction(reading()))).toEqual(coffee);
  });

  it('leaves out what the reading lacks, and has nothing without a reading', () => {
    expect(
      valuesOfReading(normalizeExtraction(reading({ merchant: null, currency: null }))),
    ).toEqual({ ...coffee, merchant: null, currency: null, amountMinor: null });
    expect(valuesOfReading(null)).toEqual(NO_VALUES);
  });
});

describe('valuesOfConfirmed', () => {
  it('files what the person confirmed', () => {
    expect(
      valuesOfConfirmed({
        merchant: 'Blue Bottle',
        date: '2026-09-25',
        currency: 'USD',
        total: money(725, 'USD'),
        taxTotal: null,
        tip: money(0, 'USD'),
      }),
    ).toEqual({
      merchant: 'Blue Bottle',
      transactionDate: '2026-09-25',
      currency: 'USD',
      amountMinor: 725,
    });
  });
});

describe('proofDifferences', () => {
  it('finds nothing when the expense matches its receipt, allowing loose merchant names', () => {
    expect(proofDifferences({ ...coffee, merchant: 'BLUE BOTTLE COFFEE INC' }, coffee)).toEqual([]);
  });

  it('names each field that differs', () => {
    expect(
      proofDifferences(
        { merchant: 'Starbucks', transactionDate: '2026-09-25', currency: 'CAD', amountMinor: 650 },
        coffee,
      ),
    ).toEqual(['merchant', 'date', 'currency', 'amount']);
    expect(proofDifferences({ ...coffee, amountMinor: 725 }, coffee)).toEqual(['amount']);
  });

  it('cannot differ where the receipt shows nothing, and an empty claim differs', () => {
    expect(proofDifferences(coffee, NO_VALUES)).toEqual([]);
    expect(proofDifferences(NO_VALUES, coffee)).toEqual(['merchant', 'date', 'currency', 'amount']);
  });
});
