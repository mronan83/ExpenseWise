import { describe, expect, it } from 'vitest';
import {
  checkAgainstReceipt,
  holdsUp,
  receiptDifferenceText,
  type ReceiptCheckInput,
} from './receipt-check.ts';

/** A $412.80 folio, claimed as it is unless a test says otherwise. */
const folio = (over: Partial<ReceiptCheckInput> = {}): ReceiptCheckInput => ({
  differences: [],
  claimedMinor: 41_280,
  claimedCurrency: 'USD',
  receiptMinor: 41_280,
  receiptCurrency: 'USD',
  reason: null,
  excludedLines: 0,
  ...over,
});

describe('checkAgainstReceipt (Q6)', () => {
  it('matches an expense that is what its receipt shows', () => {
    expect(checkAgainstReceipt(folio())).toEqual({ state: 'matches' });
  });

  it('has nothing to differ from without a receipt, as for a drive', () => {
    expect(checkAgainstReceipt(folio({ differences: null }))).toEqual({ state: 'no_receipt' });
  });

  it('takes a lower claim with the person’s reason, or with lines left out, each with its own', () => {
    const lower = { differences: ['amount' as const], claimedMinor: 36_280 };
    expect(checkAgainstReceipt(folio({ ...lower, reason: 'The minibar was personal' }))).toEqual({
      state: 'explained',
      by: 'reason',
    });
    expect(checkAgainstReceipt(folio({ ...lower, excludedLines: 1 }))).toEqual({
      state: 'explained',
      by: 'lines',
    });
  });

  it('holds a lower claim without a reason, and says a reason would settle it', () => {
    expect(
      checkAgainstReceipt(folio({ differences: ['amount'], claimedMinor: 36_280, reason: '  ' })),
    ).toEqual({ state: 'differs', differences: ['amount'], over: false, needsReason: true });
  });

  it('never takes more than the receipt, whatever the reason', () => {
    expect(
      checkAgainstReceipt(
        folio({ differences: ['amount'], claimedMinor: 45_000, reason: 'Tip added later' }),
      ),
    ).toEqual({ state: 'differs', differences: ['amount'], over: true, needsReason: false });
  });

  it('never takes another merchant, date or currency, whatever the reason', () => {
    for (const field of ['merchant', 'date', 'currency'] as const) {
      const check = checkAgainstReceipt(
        folio({ differences: [field], reason: 'It was like that', excludedLines: 2 }),
      );
      expect(check).toEqual({
        state: 'differs',
        differences: [field],
        over: false,
        needsReason: false,
      });
      expect(holdsUp(check)).toBe(false);
    }
    // A lower amount in another currency is another currency, not a lower claim.
    expect(
      checkAgainstReceipt(
        folio({
          differences: ['currency', 'amount'],
          claimedMinor: 100,
          claimedCurrency: 'EUR',
          reason: 'Converted',
        }),
      ).state,
    ).toBe('differs');
  });
});

describe('receiptDifferenceText', () => {
  it('says why an expense doesn’t hold up against its receipt, in a sentence', () => {
    const text = (over: Partial<ReceiptCheckInput>) =>
      receiptDifferenceText(checkAgainstReceipt(folio(over)));
    expect(text({ differences: ['date'] })).toBe('Its date isn’t its receipt’s.');
    expect(text({ differences: ['merchant', 'date', 'currency'] })).toBe(
      'Its merchant, date and currency aren’t its receipt’s.',
    );
    expect(text({ differences: ['amount'], claimedMinor: 50_000 })).toBe(
      'It claims more than its receipt.',
    );
    expect(text({ differences: ['amount'], claimedMinor: 100 })).toBe(
      'It claims less than its receipt, and doesn’t say why.',
    );
    expect(text({})).toBeNull();
  });
});
