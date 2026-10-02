import { api, ApiProblem } from './api';
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
}

/** compared: weighed by the tier decision. fallback: read only because Claude couldn't. */
export type ReadingRole = 'compared' | 'fallback';

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
    cardLastFour: TextField | null;
  } | null;
  problems: string[];
}

export interface ReceiptDetail extends ReceiptSummary {
  imageUrl: string | null;
  readings: Reading[];
  differences: string[];
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

/** The provider behind a reading, by its role: Claude compares, OpenAI is the fallback. */
export const providerOf = (reading: Pick<Reading, 'role'>) =>
  reading.role === 'fallback' ? 'OpenAI' : 'Anthropic';

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
