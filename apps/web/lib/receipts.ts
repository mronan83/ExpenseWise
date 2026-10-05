import { isIsoDate, showDate, stayLine } from '@expensewise/domain';
import { api, ApiProblem } from './api';
import type { ExpenseCategory } from './categories';
import type { ExpenseAmount } from './expenses';
import type { ReportSummary } from './reports';
import { prepareReceiptFile, sha256Hex } from './receipt-file';
import { supabase } from './supabase';

export type Confidence = 'high' | 'medium' | 'low';
export interface TextField {
  value: string;
  confidence: Confidence;
}
export interface MoneyField {
  amountMinor: number;
  currency: string;
  decimal: string;
  confidence: Confidence;
  /** A tax or tip the receipt doesn't print, taken as zero rather than read. */
  assumed: boolean;
}

export interface ReceiptSummary {
  id: string;
  status: 'processing' | 'extracted' | 'needs_review' | 'failed';
  source: string;
  contentType: string;
  uploadedBy: string;
  createdAt: string;
  merchant: string | null;
  date: string | null;
  total: MoneyField | null;
  /** The expense this receipt proves (FR-EXP-08). */
  expenseId: string | null;
}

/**
 * compared: weighed by the tier decision. fallback: read only because Claude couldn't. Under
 * the organization's AI model settings: primary, the model chosen to read every receipt;
 * backup, read only because the models before it couldn't (FR-INT-16).
 */
export type ReadingRole = 'compared' | 'fallback' | 'primary' | 'backup';

/** Readings made under the organization's AI model settings, rather than side by side. */
export const underSettings = (readings: readonly Pick<Reading, 'role'>[]) =>
  readings.some((r) => r.role === 'primary' || r.role === 'backup');

/**
 * A check a reading fails, which keeps it from being Ready: its sums or date (FR-INT-04), that
 * it is a purchase summary (Q10), or a folio's stay whose nights aren't sure (FR-INT-21).
 */
export type ReadingCheck = 'sums' | 'future_date' | 'old_date' | 'summary' | 'stay';

export interface Reading {
  model: string;
  label: string;
  role: ReadingRole;
  state: 'pending' | 'missing' | 'confident' | 'unsure' | 'failed';
  error: string | null;
  latencyMs: number | null;
  costMicroUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  fields: {
    documentType: string;
    merchant: TextField | null;
    date: TextField | null;
    currency: TextField | null;
    total: MoneyField | null;
    subtotal: MoneyField | null;
    taxTotal: MoneyField | null;
    tip: MoneyField | null;
    fees: MoneyField | null;
    cardLastFour: TextField | null;
    /** When it was bought, HH:MM as printed (FR-INT-17). */
    time: TextField | null;
    /** The merchant's address as printed. */
    address: TextField | null;
    /**
     * Where a ride, flight or train went, and a folio's stay, as read; only while Journeys and
     * stays is on (FR-INT-20, FR-INT-21).
     */
    from?: TextField | null;
    to?: TextField | null;
    checkIn?: TextField | null;
    checkOut?: TextField | null;
  } | null;
  problems: string[];
  checks: ReadingCheck[];
  /**
   * The line of the receipt each field was read from, with "Where each field was read" on
   * (GAP-14); null for a reading made without them, and absent while the feature is off.
   */
  sources?: FieldSources | null;
}

/** The line or lines of the receipt each field was read from, as the model copied them. */
export type FieldSources = Record<
  | 'merchant'
  | 'date'
  | 'time'
  | 'address'
  | 'currency'
  | 'total'
  | 'subtotal'
  | 'taxTotal'
  | 'tip'
  | 'fees'
  | 'cardLastFour',
  string | null
>;

/** The fields a person can correct before filing (FR-INT-15). */
export type CorrectableField = 'merchant' | 'date' | 'currency' | 'total' | 'taxTotal' | 'tip';

export interface Confirmation {
  by: string;
  at: string;
  model: string;
  label: string;
  /** What the receipt is filed with. */
  values: {
    merchant: string;
    date: string;
    currency: string;
    total: MoneyField | null;
    taxTotal: MoneyField | null;
    tip: MoneyField | null;
  };
  corrections: { field: CorrectableField; read: string | null; corrected: string }[];
}

/** An expense's amount, as the API sends it. */
export interface Amount {
  amountMinor: number;
  currency: string;
  decimal: string;
}

/** One receipt of a possible duplicate pair, with the expense it proves. */
export interface DuplicateSide {
  receiptId: string;
  source: string;
  contentType: string;
  createdAt: string;
  expenseId: string | null;
  expenseStatus:
    'processing' | 'needs_review' | 'ready' | 'submitted' | 'approved' | 'settled' | null;
  merchant: string | null;
  date: string | null;
  amount: Amount | null;
  notes: string | null;
  trip: { id: string; name: string } | null;
  /** When and where it was bought (FR-INT-17). */
  time: string | null;
  address: string | null;
  city: string | null;
  country: string | null;
}

/**
 * exact: the same merchant, day, time and total. possible: the same purchase perhaps amended,
 * as with a tip added, or matched on the total where they don't both say when (ADR-0031).
 */
export type DuplicateKind = 'exact' | 'possible';

/**
 * Another receipt that is the same purchase (FR-INT-18). held: this one is the later copy,
 * which waits for the person and is left out of totals until they decide.
 */
export interface PossibleDuplicate {
  kind: DuplicateKind;
  held: boolean;
  self: DuplicateSide;
  other: DuplicateSide;
}

/** The fields a merge can take from the receipt merged in. */
export type MergeField = 'merchant' | 'date' | 'amount' | 'notes' | 'trip';
export const MERGE_FIELDS: MergeField[] = ['merchant', 'date', 'amount', 'notes', 'trip'];

/** An expense submitted or further along is never deleted or merged into. */
export const isLocked = (side: Pick<DuplicateSide, 'expenseStatus'>) =>
  side.expenseStatus === 'submitted' ||
  side.expenseStatus === 'approved' ||
  side.expenseStatus === 'settled';

export interface ReceiptDetail extends ReceiptSummary {
  imageUrl: string | null;
  readings: Reading[];
  differences: string[];
  /** Set when a member confirmed a reading; the headline values are then theirs. */
  confirmation: Confirmation | null;
  duplicates: PossibleDuplicate[];
}

export const FIELD_LABELS: Record<CorrectableField, string> = {
  merchant: 'Merchant',
  date: 'Date',
  currency: 'Currency',
  total: 'Total',
  taxTotal: 'Tax',
  tip: 'Tip',
};

/** Why a receipt is in the Needs you inbox (FR-EXP-02). */
export interface NeedsYouReason {
  code: 'failed' | 'duplicate' | 'fallback' | 'differ' | 'checks' | 'unsure' | 'not_read';
  fields: string[];
  checks: ReadingCheck[];
  error: string | null;
  by: string | null;
  /** duplicate: the earlier receipt it looks like. */
  duplicateOf: {
    kind: DuplicateKind;
    receiptId: string;
    merchant: string | null;
    date: string | null;
    amount: Amount | null;
    createdAt: string;
  } | null;
}

export interface ReceiptInboxItem {
  kind: 'receipt';
  receipt: ReceiptSummary;
  reason: NeedsYouReason;
}

/**
 * A report overdue, in its last week with something left, or ready to close (FR-EXP-12);
 * while approval is on, one that came back with its approver's comment, or one waiting for the
 * person's decision (FR-GOV-02, FR-GOV-11).
 */
export interface ReportInboxItem {
  kind: 'report';
  report: ReportSummary;
  reason: {
    code: 'overdue' | 'closing_soon' | 'ready_to_close' | 'returned' | 'to_approve';
    /** returned: why it came back, and who sent it. */
    comment?: string;
    by?: string;
  };
}

/**
 * An expense that needs the person: a local one that says nothing yet of why it was for
 * business (FR-EXP-14); while categories are on, one with no category and type (Q27); while
 * approval is on, one its report came back with rejected (FR-GOV-12).
 */
export interface ExpenseInboxItem {
  kind: 'expense';
  expense: {
    id: string;
    merchant: string | null;
    date: string | null;
    amount: ExpenseAmount | null;
    receiptId: string | null;
  };
  reason: {
    code: 'justification' | 'uncoded' | 'rejected';
    /** rejected: why, and whether the review rejected it on its own (FR-GOV-12). */
    why?: string;
    automatic?: boolean;
    reportId?: string;
  };
  /** uncoded: what is suggested for it, or missing when nothing is. */
  category?: ExpenseCategory;
}

/** Why an email from the person's own address wasn't proved to be theirs (ADR-0026). */
export type EmailProblem = 'unsigned' | 'signature_failed' | 'not_aligned' | 'partly_signed';

/**
 * An email from the person's own address that filed nothing, while that is on (#59): nothing
 * proved it was theirs, or it had nothing in it to read. Never its text.
 */
export interface EmailInboxItem {
  kind: 'email';
  email: { id: string; subject: string | null; from: string; receivedAt: string };
  reason: { code: 'unproved' | 'empty'; problem: EmailProblem | null };
}

export type InboxItem = ReceiptInboxItem | ReportInboxItem | ExpenseInboxItem | EmailInboxItem;

const CHECK_REASONS: Record<ReadingCheck, string> = {
  sums: 'Its parts don’t come to its total.',
  future_date: 'It’s dated after the day it was uploaded.',
  old_date: 'It’s dated more than a year before it was uploaded.',
  summary: 'It’s a purchase summary: check what was charged.',
  stay: 'Its stay’s dates can’t be right: check the nights.',
};
const KEY_ERRORS = ['no_key', 'unreadable_key', 'key_rejected'];

/** What an inbox item says, and the one thing to do about it. */
export function needsYou(item: ReceiptInboxItem): { text: string; action: string; href: string } {
  const { reason, receipt } = item;
  const check = { action: 'Check it', href: `/receipts/${receipt.id}` };
  switch (reason.code) {
    case 'failed': {
      // Every model refused or couldn't make sense of it: say so of them all, not one.
      const text =
        reason.error && !reason.error.startsWith('model_')
          ? describeReadingError(reason.error)
          : 'No model could read it.';
      // A key is fixed in Settings; an outage by reading it again; anything else by hand.
      if (KEY_ERRORS.some((e) => reason.error?.startsWith(e))) {
        return { text, action: 'Open settings', href: '/settings/ai' };
      }
      const open = reason.error?.startsWith('unavailable') ? 'Open it' : 'Fill it in';
      return { text, action: open, href: `/receipts/${receipt.id}` };
    }
    case 'duplicate': {
      const of = reason.duplicateOf;
      const what = [
        of?.merchant,
        of?.amount ? formatMoney(of.amount) : null,
        of?.date && isIsoDate(of.date) ? showDate(of.date) : of?.date,
      ]
        .filter(Boolean)
        .join(', ');
      return {
        text: `${of?.kind === 'exact' ? 'A copy' : 'Possible duplicate'} of an earlier receipt${what ? ` (${what})` : ''}.`,
        action: 'Compare',
        href: `/receipts/${receipt.id}`,
      };
    }
    case 'fallback':
      return { text: `Only ${reason.by ?? 'the fallback'} could read it.`, ...check };
    case 'differ': {
      const fields = reason.fields.map(
        (f) => FIELD_LABELS[f as CorrectableField]?.toLowerCase() ?? f,
      );
      const list = new Intl.ListFormat('en', { type: 'conjunction' }).format(fields);
      return { text: `The models read the ${list} differently.`, ...check };
    }
    case 'checks':
      return { text: reason.checks.map((c) => CHECK_REASONS[c]).join(' '), ...check };
    case 'unsure':
      return { text: 'A model wasn’t sure of it, or couldn’t read it.', ...check };
    case 'not_read':
      return {
        text: 'Every AI model is off, so nothing read it.',
        action: 'Fill it in',
        href: `/receipts/${receipt.id}`,
      };
  }
}

export interface ModelStats {
  model: string;
  label: string;
  role: ReadingRole;
  readings: number;
  confident: number;
  failed: number;
  averageLatencyMs: number | null;
  costMicroUsd: number;
}

export interface ReceiptList {
  receipts: ReceiptSummary[];
  comparison: { receipts: number; compared: number; agreed: number; models: ModelStats[] };
  readingAvailable: boolean;
  /** Capture to Ready over the receipts shown, with "Capture-to-Ready time" on (GAP-16). */
  captureToReady?: CaptureTime;
}

/** The 95th-percentile time from capture to read, over how many receipts, against the goal. */
export interface CaptureTime {
  receipts: number;
  p95Ms: number | null;
  sloMs: number;
  withinSlo: boolean | null;
}

export const RECEIPT_STATUS: Record<ReceiptSummary['status'], { label: string; tone: string }> = {
  processing: { label: 'Reading…', tone: 'text-ink-2' },
  extracted: { label: 'Ready', tone: 'text-ok' },
  needs_review: { label: 'Needs a look', tone: 'text-warn' },
  failed: { label: 'Not read', tone: 'text-bad' },
};

/** An amount for display, from the exact decimal string the API sends. */
export function formatMoney(money: Pick<MoneyField, 'decimal' | 'currency'>): string {
  try {
    // Intl takes the decimal string exactly; no float conversion.
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: money.currency }).format(
      money.decimal as unknown as number,
    );
  } catch {
    return `${money.decimal} ${money.currency}`;
  }
}

/**
 * Why these readings can't be filed as read, a sentence for each check that fails: their sums
 * or date, or being a purchase summary. Readings that fail the same way say it once.
 */
export function describeChecks(readings: readonly Reading[]): string[] {
  const said = new Set<string>();
  for (const { fields: f, checks } of readings) {
    if (!f) continue;
    for (const check of checks) {
      if (check === 'sums' && f.subtotal && f.total) {
        const parts = [
          formatMoney(f.subtotal),
          ...(f.taxTotal && !f.taxTotal.assumed ? [`${formatMoney(f.taxTotal)} tax`] : []),
          ...(f.fees ? [`${formatMoney(f.fees)} fees`] : []),
          ...(f.tip && !f.tip.assumed ? [`${formatMoney(f.tip)} tip`] : []),
        ];
        said.add(`${parts.join(' + ')} doesn’t come to the ${formatMoney(f.total)} total.`);
      } else if (check === 'future_date' && f.date) {
        said.add(
          `It’s dated ${isIsoDate(f.date.value) ? showDate(f.date.value) : f.date.value}, after the day it was uploaded.`,
        );
      } else if (check === 'old_date' && f.date) {
        said.add(`It’s dated ${f.date.value}, more than a year before it was uploaded.`);
      } else if (check === 'summary') {
        said.add('It’s a purchase summary, which shows what was ordered, not what was charged.');
      } else if (check === 'stay') {
        const stay = stayLine({
          checkIn: f.checkIn?.value ?? null,
          checkOut: f.checkOut?.value ?? null,
        });
        said.add(`${stay ?? 'Its stay’s nights aren’t sure'}. Check the dates.`);
      }
    }
  }
  return [...said];
}

/** Micro-dollars as dollars, e.g. 4521 → "$0.0045". Display only. */
export function formatCost(micro: number | null): string {
  if (micro === null) return '–';
  const whole = Math.trunc(micro / 1_000_000);
  const fraction = String(micro % 1_000_000)
    .padStart(6, '0')
    .slice(0, 4);
  return `$${whole}.${fraction}`;
}

export function formatSeconds(ms: number | null): string {
  return ms === null ? '–' : `${(ms / 1000).toFixed(1)} s`;
}

/**
 * The provider behind a reading: Claude compares, OpenAI is the fallback; under the
 * organization's AI model settings, OpenAI's model reads like any other.
 */
export const providerOf = (reading: Pick<Reading, 'role' | 'model'>) =>
  reading.role === 'fallback' || reading.model.startsWith('gpt-') ? 'OpenAI' : 'Anthropic';

/** What a failed reading's error code means for the person looking at it. */
export function describeReadingError(error: string | null, provider = 'Anthropic'): string {
  if (!error) return 'This model could not read the receipt.';
  const said = error.split(': ').slice(1).join(': ');
  if (error === 'no_key')
    return `No ${provider} key is saved. Add one in Settings, then read it again.`;
  if (error === 'unreadable_key')
    return 'The saved key can no longer be decrypted. Save it again in Settings.';
  if (error === 'not_uploaded') return 'The file never arrived. Upload it again.';
  if (error.startsWith('key_rejected')) return `${provider} rejected the key. ${said}`;
  if (error.startsWith('request_rejected')) return `${provider} refused the request. ${said}`;
  if (error.startsWith('unavailable'))
    return `${provider} didn't answer after several tries. Read it again later.`;
  if (error.startsWith('model_')) return 'The model could not read this document.';
  if (error === 'stopped') return 'Switched off for every organization for now.';
  return 'This model could not read the receipt.';
}

/**
 * Captures a receipt (architecture 6.4): get a one-time upload, send the file straight to
 * storage, then file it. Returns the receipt id, which may be an earlier receipt with the
 * same file.
 */
export async function captureReceipt(
  file: File,
  source: 'camera' | 'upload',
  progress: (step: string) => void,
): Promise<{ id: string; duplicate: boolean }> {
  progress('Preparing…');
  const { blob, contentType } = await prepareReceiptFile(file);
  const sha256 = await sha256Hex(blob);
  const described = { contentType, byteSize: blob.size, sha256 };
  let ticket: { receiptId: string; bucket: string; path: string; token: string };
  try {
    ticket = await api('/v1/receipts/uploads', { method: 'POST', body: JSON.stringify(described) });
  } catch (error) {
    // The same file is already filed: show that receipt instead.
    const existing = error instanceof ApiProblem ? error.extra.receiptId : undefined;
    if (typeof existing === 'string') return { id: existing, duplicate: true };
    throw error;
  }
  progress('Uploading…');
  const storage = supabase()?.storage;
  if (!storage) throw new Error("Sign-in isn't configured on this deployment.");
  const { error } = await storage
    .from(ticket.bucket)
    .uploadToSignedUrl(ticket.path, ticket.token, blob, { contentType });
  if (error) throw new Error(`The upload failed: ${error.message}`);
  progress('Filing…');
  await api('/v1/receipts', {
    method: 'POST',
    body: JSON.stringify({ id: ticket.receiptId, source, ...described }),
  });
  return { id: ticket.receiptId, duplicate: false };
}
