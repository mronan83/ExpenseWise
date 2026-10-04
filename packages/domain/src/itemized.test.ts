import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  categoryTotals,
  checkExclusion,
  checkLines,
  claimWithout,
  EXCLUSION_NOTE_MAX,
  lineClaims,
  lineTools,
  lineToolsText,
  linesProblemText,
  partsByAmount,
  partsByLine,
  SPLIT_PARTS_MAX,
  type Itemization,
  type LineKind,
  type ReadLine,
} from './itemized.ts';
import { money, sum } from './money.ts';

const usd = (cents: number) => money(cents, 'USD');
const line = (kind: LineKind, description: string, cents: number): ReadLine => ({
  kind,
  description,
  quantity: null,
  amount: usd(cents),
});

/** A hotel folio: three nights, the minibar, room service, then its taxes and a resort fee. */
const FOLIO: Itemization = {
  currency: 'USD',
  subtotal: usd(96_150),
  total: usd(110_400),
  lines: [
    line('item', 'Room, 3 nights', 89_700),
    line('item', 'Minibar', 1850),
    line('item', 'Room service', 4600),
    line('tax', 'Occupancy tax', 12_495),
    line('fee', 'Resort fee', 1755),
  ],
};

const MEALS = { categoryId: 'meals', typeId: 'business_meal' };

describe('whether a receipt’s lines add up (ADR-0041)', () => {
  it('adds up when the items make the subtotal, and with tax, tip and fees the total', () => {
    expect(checkLines(FOLIO)).toEqual({
      addsUp: true,
      items: usd(96_150),
      extras: usd(14_250),
      taxIncluded: false,
    });
  });

  it('allows a cent per line, since a receipt rounds each line on its own', () => {
    const near = { ...FOLIO, subtotal: usd(96_153), total: usd(110_405) };
    expect(checkLines(near).addsUp).toBe(true);
    expect(checkLines({ ...FOLIO, subtotal: usd(96_154) }).addsUp).toBe(false);
    expect(checkLines({ ...FOLIO, total: usd(110_406) }).addsUp).toBe(false);
  });

  it('says plainly when the items miss the subtotal', () => {
    const short = { ...FOLIO, lines: FOLIO.lines.filter((l) => l.description !== 'Minibar') };
    const check = checkLines(short);
    expect(check).toMatchObject({ addsUp: false, problem: 'subtotal' });
    if (check.addsUp) throw new Error('it should not add up');
    expect(linesProblemText(check.problem, check.comesTo, check.against)).toBe(
      'These lines come to $943.00, but the receipt’s subtotal is $961.50.',
    );
  });

  it('says plainly when with tax, tip and fees they miss the total, or no total was read', () => {
    const over = { ...FOLIO, subtotal: null, total: usd(100_000) };
    const check = checkLines(over);
    expect(check).toMatchObject({ addsUp: false, problem: 'total', against: usd(100_000) });
    if (check.addsUp) throw new Error('it should not add up');
    expect(linesProblemText(check.problem, check.comesTo, check.against)).toBe(
      'With tax, tip and fees these lines come to $1,104.00, but the receipt’s total is $1,000.00.',
    );
    const unread = checkLines({ ...FOLIO, total: null });
    expect(unread).toMatchObject({ addsUp: false, problem: 'no_total' });
    if (unread.addsUp) throw new Error('it should not add up');
    expect(linesProblemText(unread.problem, unread.comesTo, unread.against)).toMatch(/total/);
  });

  it('adds up when the prices include their tax, as VAT receipts print them', () => {
    const vat: Itemization = {
      currency: 'USD',
      subtotal: usd(1000),
      total: usd(1200),
      lines: [line('item', 'Lunch', 1200), line('tax', 'VAT 20% (included)', 200)],
    };
    expect(checkLines(vat)).toMatchObject({ addsUp: true, extras: usd(0), taxIncluded: true });
    expect(checkLines({ ...vat, subtotal: usd(1200) })).toMatchObject({ addsUp: true });
  });

  it('spreads nothing across items that come to nothing', () => {
    const refund: Itemization = {
      currency: 'USD',
      subtotal: null,
      total: usd(0),
      lines: [line('item', 'Fare', 500), line('item', 'Refund', -500)],
    };
    expect(checkLines(refund)).toMatchObject({ addsUp: false, problem: 'not_positive' });
    expect(lineClaims(refund)).toBeNull();
    if (!checkLines(refund).addsUp) {
      expect(linesProblemText('not_positive', usd(0), null)).toMatch(/can’t be spread/);
    }
  });
});

describe('each line’s share of the tax, tip and fees (Q39)', () => {
  it('spreads them in proportion, the largest share taking any cent left over', () => {
    const claims = lineClaims(FOLIO)!;
    expect(claims.map((c) => [c.position, c.share.amountMinor, c.claimed.amountMinor])).toEqual([
      [1, 13_295, 102_995],
      [2, 274, 2124],
      [3, 681, 5281],
    ]);
    expect(
      sum(
        'USD',
        claims.map((c) => c.claimed),
      ),
    ).toEqual(FOLIO.total);
  });

  it('gives a discount, a negative line, a negative share, and a zero line none', () => {
    const lunch: Itemization = {
      currency: 'USD',
      subtotal: usd(5000),
      total: usd(5500),
      lines: [
        line('item', 'Salmon', 3000),
        line('item', 'Steak', 3000),
        line('item', 'Water', 0),
        line('item', 'Happy hour', -1000),
        line('tax', 'Sales tax', 500),
      ],
    };
    const claims = lineClaims(lunch)!;
    expect(claims.map((c) => c.share.amountMinor)).toEqual([300, 300, 0, -100]);
    expect(
      sum(
        'USD',
        claims.map((c) => c.claimed),
      ),
    ).toEqual(usd(5500));
  });

  it('always adds up to the receipt exactly, for any number of lines', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: -2000, max: 500_000 }), { minLength: 1, maxLength: 80 }),
        fc.array(fc.integer({ min: 0, max: 50_000 }), { maxLength: 6 }),
        (items, extras) => {
          const subtotal = items.reduce((a, b) => a + b, 0);
          fc.pre(subtotal > 0);
          const total = subtotal + extras.reduce((a, b) => a + b, 0);
          const it: Itemization = {
            currency: 'USD',
            subtotal: usd(subtotal),
            total: usd(total),
            lines: [
              ...items.map((c, i) => line('item', `Item ${i + 1}`, c)),
              ...extras.map((c, i) => line(i % 2 ? 'fee' : 'tax', `Extra ${i + 1}`, c)),
            ],
          };
          const claims = lineClaims(it)!;
          expect(claims).toHaveLength(items.length);
          expect(
            sum(
              'USD',
              claims.map((c) => c.claimed),
            ),
          ).toEqual(usd(total));
          const zero = claims.filter((c) => c.amount.amountMinor === 0);
          expect(zero.every((c) => c.share.amountMinor === 0)).toBe(true);
        },
      ),
    );
  });
});

describe('excluding a line (FR-EXP-16, Q40)', () => {
  it('takes a reason from the list, with a note that only other needs', () => {
    expect(checkExclusion('personal')).toEqual({
      ok: true,
      value: { reason: 'personal', note: null },
    });
    expect(checkExclusion('paid_by_someone_else', '  Sam paid  ')).toEqual({
      ok: true,
      value: { reason: 'paid_by_someone_else', note: 'Sam paid' },
    });
    expect(checkExclusion('other', ' ')).toEqual({ ok: false, error: 'note_needed' });
    expect(checkExclusion('other', 'Watched with family').ok).toBe(true);
    expect(checkExclusion('lost')).toEqual({ ok: false, error: 'unknown_reason' });
    expect(checkExclusion('personal', 'x'.repeat(EXCLUSION_NOTE_MAX + 1))).toEqual({
      ok: false,
      error: 'note_too_long',
    });
  });

  it('drops the claim by the line and its share of tax, tip and fees', () => {
    expect(claimWithout(FOLIO, new Set([2]))).toEqual({
      ok: true,
      value: { receipt: usd(110_400), excluded: usd(2124), claimed: usd(108_276) },
    });
    expect(claimWithout(FOLIO, new Set())).toMatchObject({
      ok: true,
      value: { claimed: usd(110_400) },
    });
  });

  it('excludes only item lines, never a discount, and never claims less than nothing', () => {
    expect(claimWithout(FOLIO, new Set([4]))).toEqual({ ok: false, error: 'not_an_item' });
    expect(claimWithout(FOLIO, new Set([9]))).toEqual({ ok: false, error: 'no_such_line' });
    const discounted: Itemization = {
      currency: 'USD',
      subtotal: usd(900),
      total: usd(900),
      lines: [line('item', 'Pass', 1000), line('item', 'Member discount', -100)],
    };
    expect(claimWithout(discounted, new Set([2]))).toEqual({ ok: false, error: 'takes_off' });
    expect(claimWithout(discounted, new Set([1]))).toEqual({ ok: false, error: 'below_zero' });
    const short = { ...FOLIO, subtotal: usd(1) };
    expect(claimWithout(short, new Set([2]))).toEqual({ ok: false, error: 'lines_dont_add_up' });
  });

  it('works only while the lines make up what the expense claims', () => {
    const claim = { amountMinor: 110_400, currency: 'USD' };
    expect(lineTools(FOLIO, new Set(), claim).ok).toBe(true);
    expect(lineTools(FOLIO, new Set([2]), { ...claim, amountMinor: 108_276 }).ok).toBe(true);
    expect(lineTools(FOLIO, new Set(), { ...claim, amountMinor: 100_000 })).toEqual({
      ok: false,
      error: 'amount_changed',
    });
    expect(lineTools(FOLIO, new Set(), { ...claim, currency: 'EUR' })).toEqual({
      ok: false,
      error: 'other_currency',
    });
    expect(lineTools({ ...FOLIO, total: null }, new Set(), claim)).toEqual({
      ok: false,
      error: 'lines_dont_add_up',
    });
    expect(lineToolsText('amount_changed', FOLIO, usd(110_400))).toMatch(/\$1,104\.00/);
    expect(lineToolsText('other_currency', FOLIO, null)).toMatch(/USD/);
    expect(lineToolsText('lines_dont_add_up', FOLIO, null)).toMatch(/split by amount/);
  });
});

describe('splitting into parts (FR-EXP-15, Q37, Q38)', () => {
  it('makes a part of each line given a category and type, the rest staying the expense’s own', () => {
    const parts = partsByLine(FOLIO, new Set(), [{ position: 3, ...MEALS }]);
    expect(parts).toEqual({
      ok: true,
      value: [
        { categoryId: null, typeId: null, amount: usd(105_119), positions: [1, 2] },
        { ...MEALS, amount: usd(5281), positions: [3] },
      ],
    });
  });

  it('leaves excluded lines out of every part, so the parts add up to the claim', () => {
    const parts = partsByLine(FOLIO, new Set([2]), [{ position: 3, ...MEALS }]);
    if (!parts.ok) throw new Error(parts.error);
    expect(
      sum(
        'USD',
        parts.value.map((p) => p.amount),
      ),
    ).toEqual(usd(108_276));
    expect(parts.value.map((p) => p.positions)).toEqual([[1], [3]]);
  });

  it('refuses a split by line that splits nothing or names a line twice, excluded, or not an item', () => {
    expect(partsByLine(FOLIO, new Set(), [])).toEqual({ ok: false, error: 'nothing_split' });
    expect(
      partsByLine(FOLIO, new Set(), [
        { position: 3, ...MEALS },
        { position: 3, ...MEALS },
      ]),
    ).toEqual({ ok: false, error: 'assigned_twice' });
    expect(partsByLine(FOLIO, new Set([3]), [{ position: 3, ...MEALS }])).toEqual({
      ok: false,
      error: 'line_excluded',
    });
    expect(partsByLine(FOLIO, new Set(), [{ position: 5, ...MEALS }])).toEqual({
      ok: false,
      error: 'not_an_item',
    });
    expect(partsByLine(FOLIO, new Set(), [{ position: 0, ...MEALS }])).toEqual({
      ok: false,
      error: 'no_such_line',
    });
    expect(partsByLine({ ...FOLIO, total: null }, new Set(), [{ position: 3, ...MEALS }])).toEqual({
      ok: false,
      error: 'lines_dont_add_up',
    });
    // Worked out again after an exclusion, an excluded line's choice is kept, in no part.
    expect(partsByLine(FOLIO, new Set([3]), [{ position: 3, ...MEALS }], false)).toEqual({
      ok: true,
      value: [],
    });
  });

  it('refuses a part that would come to nothing or less, or more parts than allowed', () => {
    const lunch: Itemization = {
      currency: 'USD',
      subtotal: usd(2000),
      total: usd(2000),
      lines: [line('item', 'Lunch', 2500), line('item', 'Voucher', -500)],
    };
    expect(partsByLine(lunch, new Set(), [{ position: 2, ...MEALS }])).toEqual({
      ok: false,
      error: 'part_not_positive',
    });
    const many: Itemization = {
      currency: 'USD',
      subtotal: usd(100 * (SPLIT_PARTS_MAX + 1)),
      total: usd(100 * (SPLIT_PARTS_MAX + 1)),
      lines: Array.from({ length: SPLIT_PARTS_MAX + 1 }, (_, i) => line('item', `${i}`, 100)),
    };
    const each = many.lines.map((_, i) => ({ position: i + 1, categoryId: `c${i}`, typeId: 't' }));
    expect(partsByLine(many, new Set(), each)).toEqual({ ok: false, error: 'too_many_parts' });
  });

  it('takes parts typed by amount only when they add up to the claim exactly', () => {
    const claim = usd(4820);
    const typed = (...amounts: string[]) => amounts.map((amount) => ({ ...MEALS, amount }));
    expect(partsByAmount(claim, typed('30.00', '18.20'))).toEqual({
      ok: true,
      value: [
        { ...MEALS, amount: usd(3000), positions: [] },
        { ...MEALS, amount: usd(1820), positions: [] },
      ],
    });
    expect(partsByAmount(claim, typed('30.00', '18.19'))).toEqual({
      ok: false,
      error: { problem: 'parts_dont_add_up' },
    });
    expect(partsByAmount(claim, typed('48.20'))).toEqual({
      ok: false,
      error: { problem: 'too_few_parts' },
    });
    expect(partsByAmount(claim, typed('48.20', '0'))).toEqual({
      ok: false,
      error: { problem: 'part_not_positive', index: 1 },
    });
    expect(partsByAmount(claim, typed('30.001', '18.19'))).toEqual({
      ok: false,
      error: { problem: 'invalid_amount', index: 0 },
    });
    const tooMany = typed(...Array.from({ length: SPLIT_PARTS_MAX + 1 }, () => '1.00'));
    expect(partsByAmount(claim, tooMany)).toEqual({
      ok: false,
      error: { problem: 'too_many_parts' },
    });
  });

  it('totals a report by category and type, each part under its own, the uncategorized last', () => {
    const totals = categoryTotals([
      {
        categoryId: 'travel',
        category: 'Travel',
        typeId: 'lodging',
        type: 'Lodging',
        amount: usd(105_119),
      },
      {
        categoryId: 'meals',
        category: 'Meals',
        typeId: 'meal',
        type: 'Business meal',
        amount: usd(5281),
      },
      { categoryId: null, category: null, typeId: null, type: null, amount: usd(650) },
      {
        categoryId: 'meals',
        category: 'Meals',
        typeId: 'meal',
        type: 'Business meal',
        amount: usd(8450),
      },
      {
        categoryId: 'meals',
        category: 'Meals',
        typeId: 'meal',
        type: 'Business meal',
        amount: money(4100, 'EUR'),
      },
    ]);
    expect(
      totals.map((t) => [
        t.category,
        t.type,
        t.totals.map((m) => `${m.amountMinor} ${m.currency}`),
      ]),
    ).toEqual([
      ['Meals', 'Business meal', ['4100 EUR', '13731 USD']],
      ['Travel', 'Lodging', ['105119 USD']],
      [null, null, ['650 USD']],
    ]);
  });
});
