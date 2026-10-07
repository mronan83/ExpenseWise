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
  purchaseClaims,
  purchaseItems,
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

describe('each line’s share of the tax, tip and fees (Q37)', () => {
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

describe('excluding a line (FR-EXP-16, Q38)', () => {
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

describe('splitting into parts (FR-EXP-15, Q35, Q36)', () => {
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

/**
 * A Hilton folio as the product owner described it on Oct 5 (GAP-38, #92), its lines as the
 * reading gives them: each night's room, both nights' $34 parking and the one $68 credit that
 * reversed them, then each night's taxes. It prints no subtotal; the total is the payment.
 */
const HILTON: Itemization = {
  currency: 'USD',
  subtotal: null,
  total: usd(42_526),
  lines: [
    line('item', 'Guest room', 18_900),
    line('item', 'Overnight parking', 3400),
    line('item', 'Guest room', 18_900),
    line('item', 'Overnight parking', 3400),
    line('item', 'Parking credit', -6800),
    line('tax', 'State occupancy tax', 1323),
    line('tax', 'City tax', 1040),
    line('tax', 'State occupancy tax', 1323),
    line('tax', 'City tax', 1040),
  ],
};
const PARKING = { categoryId: 'travel', typeId: 'parking' };

describe('a folio’s credit, read as a line of its own (#92)', () => {
  it('adds up with no subtotal, and gives the credit a negative share that offsets its charges’', () => {
    expect(checkLines(HILTON)).toEqual({
      addsUp: true,
      items: usd(37_800),
      extras: usd(4726),
      taxIncluded: false,
    });
    const claims = lineClaims(HILTON)!;
    expect(claims.map((c) => [c.position, c.share.amountMinor, c.claimed.amountMinor])).toEqual([
      [1, 2364, 21_264],
      [2, 425, 3825],
      [3, 2363, 21_263],
      [4, 425, 3825],
      [5, -851, -7651],
    ]);
    // The charges and their credit net out; with their shares, within the cent that rounding
    // down leaves, which the largest line takes.
    expect(
      sum(
        'USD',
        [2, 4, 5].map((p) => HILTON.lines[p - 1]!.amount),
      ),
    ).toEqual(usd(0));
    expect(
      sum(
        'USD',
        claims.map((c) => c.claimed),
      ),
    ).toEqual(HILTON.total);
  });

  it('never leaves the credit out, may leave out a charge it reversed, and never claims below zero', () => {
    expect(claimWithout(HILTON, new Set([5]))).toEqual({ ok: false, error: 'takes_off' });
    expect(claimWithout(HILTON, new Set([2]))).toEqual({
      ok: true,
      value: { receipt: usd(42_526), excluded: usd(3825), claimed: usd(38_701) },
    });
    expect(claimWithout(HILTON, new Set([1, 2, 3, 4]))).toEqual({
      ok: false,
      error: 'below_zero',
    });
  });

  it('splits the credit off only with lines that come to more than it', () => {
    expect(partsByLine(HILTON, new Set(), [{ position: 5, ...PARKING }])).toEqual({
      ok: false,
      error: 'part_not_positive',
    });
    // The parking and its credit come to nothing, so they make no part of their own.
    const parking = [2, 4, 5].map((position) => ({ position, ...PARKING }));
    expect(partsByLine(HILTON, new Set(), parking)).toEqual({
      ok: false,
      error: 'part_not_positive',
    });
    const withRoom = partsByLine(HILTON, new Set(), [
      { position: 3, ...MEALS },
      { position: 5, ...MEALS },
    ]);
    expect(withRoom).toEqual({
      ok: true,
      value: [
        { categoryId: null, typeId: null, amount: usd(28_914), positions: [1, 2, 4] },
        { ...MEALS, amount: usd(13_612), positions: [3, 5] },
      ],
    });
  });
});

/**
 * An airline receipt of two purchases (FR-INT-23, Q49): the ticket, bought Sep 12 on one card,
 * and a seat upgrade bought Sep 30 on another, each with its own taxes and fees.
 */
const of = (purchase: number, l: ReadLine): ReadLine => ({ ...l, purchase });
const TWO_PURCHASES: Itemization = {
  currency: 'USD',
  subtotal: null,
  total: usd(48_713),
  purchases: [
    { description: 'Ticket', date: '2026-09-12', cardLastFour: '4417', total: usd(40_220) },
    { description: 'Seat upgrade', date: '2026-09-30', cardLastFour: '9921', total: usd(8493) },
  ],
  lines: [
    of(1, line('item', 'Airfare', 36_000)),
    of(1, line('tax', 'US transportation tax', 2700)),
    of(1, line('fee', 'September 11 security fee', 560)),
    of(1, line('fee', 'Passenger facility charge', 960)),
    of(2, line('item', 'Economy Plus', 7900)),
    of(2, line('tax', 'US transportation tax', 593)),
  ],
};

describe('a receipt of several purchases, each its own group of lines (FR-INT-23, Q49)', () => {
  it('adds up when each purchase’s lines make its total, and the purchases the receipt’s', () => {
    expect(checkLines(TWO_PURCHASES)).toEqual({
      addsUp: true,
      items: usd(43_900),
      extras: usd(4813),
      taxIncluded: false,
      purchases: [
        { items: usd(36_000), extras: usd(4220) },
        { items: usd(7900), extras: usd(593) },
      ],
    });
  });

  it('spreads each purchase’s taxes and fees over only its own items', () => {
    expect(
      lineClaims(TWO_PURCHASES)!.map((c) => [
        c.position,
        c.share.amountMinor,
        c.claimed.amountMinor,
      ]),
    ).toEqual([
      [1, 4220, 40_220],
      [5, 593, 8493],
    ]);
  });

  it('leaves out the upgrade with its own taxes, never a share of the ticket’s', () => {
    expect(purchaseItems(TWO_PURCHASES, 2)).toEqual([5]);
    expect(claimWithout(TWO_PURCHASES, new Set([5]))).toEqual({
      ok: true,
      value: { receipt: usd(48_713), excluded: usd(8493), claimed: usd(40_220) },
    });
    expect(purchaseClaims(TWO_PURCHASES, new Set([5]))).toEqual([
      {
        description: 'Ticket',
        date: '2026-09-12',
        cardLastFour: '4417',
        total: usd(40_220),
        number: 1,
        items: [1],
        lines: [1, 2, 3, 4],
        claimed: usd(40_220),
        excluded: false,
      },
      {
        description: 'Seat upgrade',
        date: '2026-09-30',
        cardLastFour: '9921',
        total: usd(8493),
        number: 2,
        items: [5],
        lines: [5, 6],
        claimed: usd(8493),
        excluded: true,
      },
    ]);
  });

  it('says which purchase’s lines miss its total, or that its total wasn’t read', () => {
    const [ticket, upgrade] = TWO_PURCHASES.purchases!;
    const short = {
      ...TWO_PURCHASES,
      purchases: [ticket!, { ...upgrade!, total: usd(9000) }],
      total: usd(49_220),
    };
    const check = checkLines(short);
    expect(check).toMatchObject({ addsUp: false, problem: 'purchase', purchase: 2 });
    if (check.addsUp) throw new Error('it should not add up');
    expect(linesProblemText(check.problem, check.comesTo, check.against, 'Seat upgrade')).toBe(
      'Seat upgrade’s lines come to $84.93, but its total is $90.00.',
    );
    const unread = checkLines({
      ...TWO_PURCHASES,
      purchases: [ticket!, { ...upgrade!, total: null }],
    });
    expect(unread).toMatchObject({ addsUp: false, problem: 'purchase', against: null });
    if (unread.addsUp) throw new Error('it should not add up');
    expect(linesProblemText(unread.problem, unread.comesTo, unread.against, 'Seat upgrade')).toBe(
      'Seat upgrade’s total wasn’t read, so its lines can’t be checked against it.',
    );
  });

  it('needs the purchases to come to the receipt’s total exactly, and every line to name one', () => {
    const off = checkLines({ ...TWO_PURCHASES, total: usd(48_714) });
    expect(off).toMatchObject({
      addsUp: false,
      problem: 'purchases',
      comesTo: usd(48_713),
      against: usd(48_714),
    });
    const stray = checkLines({
      ...TWO_PURCHASES,
      lines: [...TWO_PURCHASES.lines, of(3, line('fee', 'Bag', 3500))],
    });
    expect(stray).toMatchObject({ addsUp: false, problem: 'purchases' });
    expect(checkLines({ ...TWO_PURCHASES, total: null })).toMatchObject({
      addsUp: false,
      problem: 'no_total',
    });
  });

  it('leaves a purchase’s credit out only with the whole purchase', () => {
    const credited: Itemization = {
      ...TWO_PURCHASES,
      total: usd(46_713),
      purchases: [
        TWO_PURCHASES.purchases![0]!,
        { ...TWO_PURCHASES.purchases![1]!, total: usd(6493) },
      ],
      lines: [
        ...TWO_PURCHASES.lines.slice(0, 5),
        of(2, line('item', 'Upgrade credit', -2000)),
        TWO_PURCHASES.lines[5]!,
      ],
    };
    expect(checkLines(credited).addsUp).toBe(true);
    expect(claimWithout(credited, new Set([6]))).toEqual({ ok: false, error: 'takes_off' });
    expect(claimWithout(credited, new Set([5, 6]))).toEqual({
      ok: true,
      value: { receipt: usd(46_713), excluded: usd(6493), claimed: usd(40_220) },
    });
  });

  it('reads a receipt that lists one purchase as one, exactly as before', () => {
    const one: Itemization = {
      ...FOLIO,
      purchases: [{ description: 'Stay', date: null, cardLastFour: null, total: FOLIO.total }],
      lines: FOLIO.lines.map((l) => of(1, l)),
    };
    expect(checkLines(one)).toEqual(checkLines(FOLIO));
    expect(lineClaims(one)).toEqual(lineClaims(FOLIO));
    expect(claimWithout(one, new Set([2]))).toEqual(claimWithout(FOLIO, new Set([2])));
    expect(purchaseClaims(one)).toEqual([]);
  });

  it('always adds up to the receipt exactly, each purchase claiming its own total', () => {
    const purchase = fc.record({
      items: fc.array(fc.integer({ min: 1, max: 200_000 }), { minLength: 1, maxLength: 8 }),
      extras: fc.array(fc.integer({ min: 0, max: 20_000 }), { maxLength: 4 }),
    });
    fc.assert(
      fc.property(fc.array(purchase, { minLength: 2, maxLength: 5 }), (bought) => {
        const totals = bought.map(
          (b) => b.items.reduce((a, c) => a + c, 0) + b.extras.reduce((a, c) => a + c, 0),
        );
        const it: Itemization = {
          currency: 'USD',
          subtotal: null,
          total: usd(totals.reduce((a, c) => a + c, 0)),
          purchases: totals.map((t, i) => ({
            description: `Purchase ${i + 1}`,
            date: null,
            cardLastFour: null,
            total: usd(t),
          })),
          lines: bought.flatMap((b, i) => [
            ...b.items.map((c, j) => of(i + 1, line('item', `Item ${j + 1}`, c))),
            ...b.extras.map((c, j) => of(i + 1, line(j % 2 ? 'fee' : 'tax', `Extra ${j + 1}`, c))),
          ]),
        };
        const claims = purchaseClaims(it);
        expect(claims.map((c) => c.claimed)).toEqual(totals.map(usd));
        expect(
          sum(
            'USD',
            lineClaims(it)!.map((c) => c.claimed),
          ),
        ).toEqual(it.total);
        const last = claims.at(-1)!;
        expect(claimWithout(it, new Set(last.items))).toMatchObject({
          ok: true,
          value: { excluded: usd(totals.at(-1)!) },
        });
      }),
    );
  });
});
