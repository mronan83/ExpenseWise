import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  checkSetAside,
  checkStatement,
  matchTransactions,
  merchantLikeness,
  transactionKeys,
  type CardTransaction,
  type MatchableExpense,
  type OpenTransaction,
} from './card-transactions.ts';
import { money } from './money.ts';

const usd = (cents: number) => money(cents, 'USD');
const charge = (
  merchant: string,
  date: string,
  cents: number,
  extra: Partial<CardTransaction> = {},
): CardTransaction => ({
  transactionDate: date,
  postedOn: null,
  merchant,
  amount: usd(cents),
  cardLastFour: '4417',
  reference: null,
  ...extra,
});
const open = (id: string, merchant: string, date: string, cents: number): OpenTransaction => ({
  id,
  merchant,
  transactionDate: date,
  amount: usd(cents),
});
const expense = (
  id: string,
  merchant: string | null,
  date: string | null,
  cents: number | null,
): MatchableExpense => ({
  id,
  merchant,
  transactionDate: date,
  amount: cents === null ? null : usd(cents),
});

describe('a card’s transactions, kept once (US-CAP-07 AC4)', () => {
  it('keys a transaction the same each time it is printed, and two identical charges apart', () => {
    const coffee = charge('BLUE BOTTLE COFFEE 0042', '2026-09-30', 650);
    const keys = transactionKeys([coffee, charge('Delta Air 0062', '2026-09-12', 40_220), coffee]);
    expect(new Set(keys).size).toBe(3);
    expect(keys[0]).not.toBe(keys[2]);
    // A later statement that lists the same two coffees gives the same keys, in order.
    expect(transactionKeys([coffee, coffee])).toEqual([keys[0], keys[2]]);
    // Punctuation and case in the merchant don't make it another transaction.
    expect(transactionKeys([charge('blue bottle coffee #0042', '2026-09-30', 650)])[0]).toBe(
      keys[0],
    );
  });
});

describe('how alike two merchant names are', () => {
  it('finds a receipt’s merchant in the card’s shortened, numbered name', () => {
    expect(merchantLikeness('DELTA AIR 0062345678901 ATLANTA GA', 'Delta Air Lines')).toBe(1);
    expect(merchantLikeness('TST* JUNIPER & RYE 1234', 'Juniper & Rye')).toBe(1);
    expect(merchantLikeness('MARRIOTT OMAHA', 'Marriott’s Courtyard')).toBe(0.5);
    expect(merchantLikeness('UBER *TRIP', 'Lyft')).toBe(0);
    expect(merchantLikeness('1234', 'Lyft')).toBe(0);
  });
});

describe('matching a transaction to the expense it paid for (FR-INT-24, US-CAP-07 AC2)', () => {
  it('matches the same amount and currency within three days, one to one', () => {
    expect(
      matchTransactions(
        [
          open('t1', 'LYFT *RIDE', '2026-09-30', 1840),
          open('t2', 'DELTA AIR', '2026-09-12', 40_220),
        ],
        [
          expense('e1', 'Lyft', '2026-10-02', 1840),
          expense('e2', 'Delta Air Lines', '2026-09-12', 40_220),
          expense('e3', 'Hilton', '2026-09-30', 41_260),
        ],
      ),
    ).toEqual([
      { transactionId: 't2', expenseId: 'e2' },
      { transactionId: 't1', expenseId: 'e1' },
    ]);
  });

  it('never matches a different amount, another currency, a date too far, or a credit', () => {
    expect(
      matchTransactions(
        [
          open('t1', 'LYFT', '2026-09-30', 1840),
          open('t2', 'LYFT', '2026-09-30', 1840),
          open('t3', 'LYFT', '2026-09-30', -1840),
          { ...open('t4', 'LYFT', '2026-09-30', 1840), amount: money(1840, 'EUR') },
        ],
        [
          expense('e1', 'Lyft', '2026-09-30', 1841),
          expense('e2', 'Lyft', '2026-10-04', 1840),
          expense('e3', 'Lyft', null, 1840),
          expense('e4', 'Lyft', '2026-09-30', null),
        ],
      ),
    ).toEqual([]);
  });

  it('prefers the closer merchant name, then the nearer date', () => {
    expect(
      matchTransactions(
        [open('t1', 'STARBUCKS 0042', '2026-09-30', 650)],
        [
          expense('e1', 'Blue Bottle', '2026-09-30', 650),
          expense('e2', 'Starbucks', '2026-10-01', 650),
        ],
      ),
    ).toEqual([{ transactionId: 't1', expenseId: 'e2' }]);
    expect(
      matchTransactions(
        [open('t1', 'SQ *CAFE', '2026-09-30', 650)],
        [expense('e1', null, '2026-10-02', 650), expense('e2', null, '2026-09-30', 650)],
      ),
    ).toEqual([{ transactionId: 't1', expenseId: 'e2' }]);
  });

  it('leaves a tie for the person rather than guess', () => {
    expect(
      matchTransactions(
        [open('t1', 'SQ *CAFE', '2026-09-30', 650)],
        [expense('e1', 'Cafe', '2026-09-30', 650), expense('e2', 'Cafe', '2026-09-30', 650)],
      ),
    ).toEqual([]);
    // Two identical charges and two identical expenses: still a tie each way.
    expect(
      matchTransactions(
        [open('t1', 'CAFE', '2026-09-30', 650), open('t2', 'CAFE', '2026-09-30', 650)],
        [expense('e1', 'Cafe', '2026-09-30', 650), expense('e2', 'Cafe', '2026-09-30', 650)],
      ),
    ).toEqual([]);
  });

  it('matches each transaction and each expense at most once, whatever comes in', () => {
    const date = fc
      .integer({ min: 1, max: 28 })
      .map((d) => `2026-09-${String(d).padStart(2, '0')}`);
    const cents = fc.constantFrom(650, 1840, 40_220);
    const name = fc.constantFrom('Lyft', 'Cafe', 'Delta Air', 'Starbucks');
    fc.assert(
      fc.property(
        fc.array(fc.tuple(name, date, cents), { maxLength: 12 }),
        fc.array(fc.tuple(name, date, cents), { maxLength: 12 }),
        (ts, es) => {
          const matches = matchTransactions(
            ts.map(([n, d, c], i) => open(`t${i}`, n, d, c)),
            es.map(([n, d, c], i) => expense(`e${i}`, n, d, c)),
          );
          expect(new Set(matches.map((m) => m.transactionId)).size).toBe(matches.length);
          expect(new Set(matches.map((m) => m.expenseId)).size).toBe(matches.length);
          for (const m of matches) {
            const [, , tc] = ts[Number(m.transactionId.slice(1))]!;
            const [, , ec] = es[Number(m.expenseId.slice(1))]!;
            expect(tc).toBe(ec);
          }
        },
      ),
    );
  });
});

describe('a statement that adds up (US-CAP-07 AC5)', () => {
  const lines = [
    charge('DELTA AIR', '2026-09-12', 40_220),
    charge('LYFT', '2026-09-30', 1840),
    charge('DELTA AIR CREDIT', '2026-09-20', -2500),
  ];
  it('passes when its charges and credits make the totals it prints, or it prints none', () => {
    expect(checkStatement('USD', lines, { charges: usd(42_060), credits: usd(2500) })).toEqual({
      addsUp: true,
    });
    expect(checkStatement('USD', lines, { charges: null, credits: null })).toEqual({
      addsUp: true,
    });
  });
  it('says which total a missed line leaves short', () => {
    expect(checkStatement('USD', lines.slice(1), { charges: usd(42_060), credits: null })).toEqual({
      addsUp: false,
      problem: 'charges',
      comesTo: usd(1840),
      against: usd(42_060),
    });
    expect(checkStatement('USD', lines.slice(0, 2), { charges: null, credits: usd(2500) })).toEqual(
      { addsUp: false, problem: 'credits', comesTo: usd(0), against: usd(2500) },
    );
  });
  it('passes a statement that prints its purchases net of its credits, with no credits apart (AC11)', () => {
    // U.S. Bank's Cardholder Activity: $420.60 of charges less a $25.00 credit, as "Purchases".
    for (const credits of [null, usd(0)]) {
      expect(checkStatement('USD', lines, { charges: usd(39_560), credits })).toEqual({
        addsUp: true,
      });
    }
    // Printed apart, the credits must make their own total, and the purchases theirs.
    expect(checkStatement('USD', lines, { charges: usd(39_560), credits: usd(2500) })).toEqual({
      addsUp: false,
      problem: 'charges',
      comesTo: usd(42_060),
      against: usd(39_560),
    });
    // A missed line still shows, net or not.
    expect(checkStatement('USD', lines.slice(1), { charges: usd(39_560), credits: null })).toEqual({
      addsUp: false,
      problem: 'charges',
      comesTo: usd(1840),
      against: usd(39_560),
    });
  });
});

describe('setting a transaction aside (US-CAP-07 AC3)', () => {
  it('takes a reason from the list, with a note that only other needs', () => {
    expect(checkSetAside('personal')).toEqual({
      ok: true,
      value: { reason: 'personal', note: null },
    });
    expect(checkSetAside('no_receipt', '  Lost on the flight ')).toEqual({
      ok: true,
      value: { reason: 'no_receipt', note: 'Lost on the flight' },
    });
    expect(checkSetAside('other', ' ')).toEqual({ ok: false, error: 'note_needed' });
    expect(checkSetAside('refund')).toEqual({ ok: false, error: 'unknown_reason' });
    expect(checkSetAside('other', 'x'.repeat(201))).toEqual({ ok: false, error: 'note_too_long' });
  });
});
