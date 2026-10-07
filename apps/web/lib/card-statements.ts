import { SET_ASIDE_LABELS, type SetAsideReason } from '@expensewise/domain';
import { api } from './api';
import { sha256Hex } from './receipt-file';
import { supabase } from './supabase';

/*
 * Card statements brought in, and their transactions matched to expenses (FR-CAP-10,
 * FR-INT-24), behind `expenses.card-statements`.
 */

export const CARD_STATEMENTS_FLAG = 'expenses.card-statements';

export interface CardAmount {
  amountMinor: number;
  currency: string;
  decimal: string;
}

export type StatementStatus = 'reading' | 'read' | 'needs_look' | 'failed';

export interface CardStatement {
  id: string;
  source: 'upload' | 'email' | 'list';
  status: StatementStatus;
  problem: string | null;
  cardLastFour: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  charges: CardAmount | null;
  credits: CardAmount | null;
  added: number;
  createdAt: string;
}

export type TransactionState = 'missing' | 'matched' | 'set_aside' | 'credit' | 'waiting';

export interface MatchedExpense {
  id: string;
  merchant: string | null;
  date: string | null;
  amount: CardAmount | null;
}

export interface CardTransaction {
  id: string;
  statementId: string;
  transactionDate: string;
  postedOn: string | null;
  merchant: string;
  amount: CardAmount;
  cardLastFour: string | null;
  state: TransactionState;
  expense: MatchedExpense | null;
  matchedBy: 'auto' | 'person' | null;
  setAside: { reason: SetAsideReason; note: string | null; at: string } | null;
}

export interface CardStatements {
  statements: CardStatement[];
  transactions: CardTransaction[];
  missing: number;
}

/** On an expense's page: the card charge that paid for it (US-CAP-07 AC2, AC7). */
export interface ExpenseCardCharge {
  id: string;
  date: string;
  merchant: string;
  amount: CardAmount;
  cardLastFour: string | null;
  matchedBy: 'auto' | 'person';
}

/** A missing receipt in Needs you (US-CAP-07 AC3). */
export interface CardInboxItem {
  kind: 'card';
  transaction: {
    id: string;
    date: string;
    merchant: string;
    amount: CardAmount;
    cardLastFour: string | null;
  };
  reason: { code: 'missing_receipt' };
}

export const SET_ASIDE_CHOICES = Object.entries(SET_ASIDE_LABELS) as [SetAsideReason, string][];

export const STATEMENT_STATUS: Record<StatementStatus, { label: string; tone: string }> = {
  reading: { label: 'Reading…', tone: 'text-ink-2' },
  read: { label: 'Read', tone: 'text-ok' },
  needs_look: { label: 'Needs a look', tone: 'text-warn' },
  failed: { label: 'Not read', tone: 'text-bad' },
};

export const SOURCE_LABEL: Record<CardStatement['source'], string> = {
  upload: 'PDF statement',
  email: 'Emailed statement',
  list: 'Downloaded list',
};

/** "card ending 4417", or nothing when the statement doesn't print it. */
export const cardText = (lastFour: string | null) => (lastFour ? `card ending ${lastFour}` : null);

/**
 * Brings in a statement's PDF: get a one-time upload, send the file straight to storage, then
 * file it to be read. The same PDF again is the statement brought in before.
 */
export async function bringInStatement(
  file: File,
  progress: (step: string) => void,
): Promise<CardStatements> {
  if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
    throw new Error('Choose the statement’s PDF, or bring in a downloaded list instead.');
  }
  if (file.size > 10 * 1024 * 1024) throw new Error('That file is over 10 MB.');
  progress('Preparing…');
  const described = { byteSize: file.size, sha256: await sha256Hex(file) };
  const ticket = await api<{ statementId: string; bucket: string; path: string; token: string }>(
    '/v1/card-statements/uploads',
    { method: 'POST', body: JSON.stringify(described) },
  );
  progress('Uploading…');
  const storage = supabase()?.storage;
  if (!storage) throw new Error("Sign-in isn't configured on this deployment.");
  const { error } = await storage
    .from(ticket.bucket)
    .uploadToSignedUrl(ticket.path, ticket.token, file, { contentType: 'application/pdf' });
  if (error) throw new Error(`The upload failed: ${error.message}`);
  progress('Filing…');
  return api<CardStatements>('/v1/card-statements', {
    method: 'POST',
    body: JSON.stringify({ id: ticket.statementId, ...described }),
  });
}

/** Brings in a downloaded transaction list, read on the server with no model (AC6). */
export async function bringInList(
  file: File,
): Promise<{ statementId: string; added: number; matched: number; skipped: number }> {
  if (file.size > 1024 * 1024)
    throw new Error('That list is over 1 MB. Download a shorter period.');
  return api('/v1/card-statements/lists', {
    method: 'POST',
    body: JSON.stringify({ text: await file.text() }),
  });
}

/** What came of bringing a list in, in a sentence. */
export function listOutcome(r: { added: number; matched: number; skipped: number }): string {
  const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
  if (r.added === 0) return 'Nothing new: every transaction on it was already brought in.';
  return [
    `Brought in ${n(r.added, 'transaction', 'transactions')}`,
    r.matched > 0 ? `matched ${n(r.matched, 'to an expense', 'to expenses')}` : null,
  ]
    .filter(Boolean)
    .join(', ')
    .concat(r.skipped > 0 ? `. Left out ${n(r.skipped, 'row', 'rows')}, such as payments.` : '.');
}
