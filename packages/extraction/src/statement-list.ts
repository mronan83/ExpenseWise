import {
  DomainError,
  fromDecimal,
  isIsoDate,
  negate,
  type CardTransaction,
  type CurrencyCode,
} from '@expensewise/domain';

/*
 * A transaction list downloaded from a card's site, as CSV, read with no model (US-CAP-07 AC6,
 * ADR-0046): its header row says which column is which, by the names banks give them.
 */

/** Why a list can't be read: not CSV, no header naming a date, a merchant and an amount. */
export type ListProblem = 'empty' | 'no_columns' | 'no_rows' | 'too_many_rows';

export type ListReading =
  | { readonly ok: true; readonly transactions: CardTransaction[]; readonly skipped: number }
  | { readonly ok: false; readonly problem: ListProblem };

/** The most rows one list may hold: a year of a busy card, and no more (R-STATEMENT-ROWS-MAX). */
export const STATEMENT_ROWS_MAX = 2000;

/** RFC 4180 fields: commas or tabs, double quotes around a field, "" for a quote inside one. */
export function csvRows(text: string): string[][] {
  const body = text.replace(/^\uFEFF/, '');
  const firstLine = body.split(/\r?\n/, 1)[0] ?? '';
  const sep = firstLine.split('\t').length > firstLine.split(',').length ? '\t' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (quoted) {
      if (c === '"' && body[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
      } else {
        field += c;
      }
    } else if (c === '"' && field === '') {
      quoted = true;
    } else if (c === sep) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && body[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim() !== ''));
}

const header = (name: string) => name.toLowerCase().replace(/[^a-z]/g, '');
const pick = (names: readonly string[], wanted: readonly string[]) =>
  names.findIndex((n) => wanted.includes(n));

const COLUMNS = {
  date: ['transactiondate', 'transdate', 'date', 'purchasedate', 'transactiondt'],
  posted: ['postingdate', 'postdate', 'posteddate', 'postdt'],
  merchant: ['merchantname', 'merchant', 'description', 'transactiondescription', 'payee', 'name'],
  amount: ['amount', 'transactionamount', 'billingamount', 'postedamount'],
  debit: ['debit', 'debitamount', 'charges', 'charge'],
  credit: ['credit', 'creditamount', 'credits'],
  card: ['cardnumber', 'card', 'accountnumber', 'cardlastfour', 'lastfour'],
  reference: ['referencenumber', 'reference', 'transactionid', 'refnumber'],
} as const;

/** "09/30/2026", "9/30/26" or "2026-09-30" as YYYY-MM-DD; null when it is none of them. */
export function listDate(value: string): string | null {
  const v = value.trim();
  if (isIsoDate(v.slice(0, 10))) return v.slice(0, 10);
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(v);
  if (!us) return null;
  const [, m, d, y] = us;
  const year = y!.length === 2 ? `20${y}` : y!;
  const iso = `${year}-${m!.padStart(2, '0')}-${d!.padStart(2, '0')}`;
  return isIsoDate(iso) ? iso : null;
}

/** "$1,234.56", "-12.34", "(12.34)" or "12.34 CR" as a decimal string; null when not money. */
export function listAmount(value: string): string | null {
  let v = value.trim().replace(/[$,\s]/g, '');
  let negative = false;
  if (/^\(.*\)$/.test(v)) {
    negative = true;
    v = v.slice(1, -1);
  }
  if (/cr$/i.test(v)) {
    negative = true;
    v = v.slice(0, -2);
  }
  if (v.startsWith('-')) {
    negative = !negative;
    v = v.slice(1);
  }
  if (!/^\d+(\.\d+)?$/.test(v)) return null;
  return negative ? `-${v}` : v;
}

/**
 * The transactions of a downloaded list: a charge positive and a credit negative, whether the
 * list has one amount column, signed either way, or a debit and a credit column. A row whose
 * date or amount doesn't read is skipped and counted, never guessed; a payment to the account
 * is skipped too.
 */
export function readStatementList(text: string, currency: CurrencyCode): ListReading {
  const rows = csvRows(text);
  if (rows.length === 0) return { ok: false, problem: 'empty' };
  // The header is the first row that names a date, a merchant and an amount.
  const headerAt = rows.findIndex((r) => {
    const names = r.map(header);
    return (
      pick(names, COLUMNS.date) >= 0 &&
      pick(names, COLUMNS.merchant) >= 0 &&
      (pick(names, COLUMNS.amount) >= 0 || pick(names, COLUMNS.debit) >= 0)
    );
  });
  if (headerAt < 0) return { ok: false, problem: 'no_columns' };
  const names = rows[headerAt]!.map(header);
  const col = Object.fromEntries(
    Object.entries(COLUMNS).map(([k, wanted]) => [k, pick(names, wanted)]),
  ) as Record<keyof typeof COLUMNS, number>;
  const at = (r: string[], i: number) => (i >= 0 ? (r[i] ?? '').trim() : '');
  // Never part of a list: one too long is refused whole, so no row is quietly left out.
  if (rows.length - headerAt - 1 > STATEMENT_ROWS_MAX)
    return { ok: false, problem: 'too_many_rows' };
  const transactions: CardTransaction[] = [];
  let skipped = 0;
  for (const r of rows.slice(headerAt + 1)) {
    const date = listDate(at(r, col.date));
    const merchant = at(r, col.merchant);
    let decimal = col.amount >= 0 ? listAmount(at(r, col.amount)) : null;
    if (decimal === null && col.debit >= 0) {
      const debit = listAmount(at(r, col.debit));
      const credit = col.credit >= 0 ? listAmount(at(r, col.credit)) : null;
      decimal =
        debit ?? (credit === null ? null : credit.startsWith('-') ? credit.slice(1) : `-${credit}`);
    }
    if (!date || decimal === null || /^payment\b/i.test(merchant)) {
      skipped++;
      continue;
    }
    try {
      const amount = fromDecimal(decimal, currency);
      const digits = at(r, col.card).replace(/\D/g, '');
      transactions.push({
        transactionDate: date,
        postedOn: listDate(at(r, col.posted)),
        merchant: merchant || 'Card transaction',
        amount,
        cardLastFour: digits.length >= 4 ? digits.slice(-4) : null,
        reference: at(r, col.reference) || null,
      });
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      skipped++;
    }
  }
  if (transactions.length === 0) return { ok: false, problem: 'no_rows' };
  // Some banks print charges as negative in a single amount column; most rows of a card's list
  // are charges, so a list that is mostly negative is read the other way round.
  const negatives = transactions.filter((t) => t.amount.amountMinor < 0).length;
  const flipped =
    col.amount >= 0 && negatives > transactions.length - negatives
      ? transactions.map((t) => ({ ...t, amount: negate(t.amount) }))
      : transactions;
  return { ok: true, transactions: flipped, skipped };
}
