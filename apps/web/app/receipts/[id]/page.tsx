'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api, ApiProblem } from '../../../lib/api';
import {
  describeReadingError,
  providerOf,
  formatCost,
  formatMoney,
  formatSeconds,
  RECEIPT_STATUS,
  type MoneyField,
  type Reading,
  type ReceiptDetail,
  type TextField,
} from '../../../lib/receipts';
import { supabase } from '../../../lib/supabase';

type Load =
  | { state: 'loading' }
  | { state: 'signed-out' }
  | { state: 'error'; message: string }
  | { state: 'ready'; receipt: ReceiptDetail };

const describeError = (error: unknown) =>
  error instanceof ApiProblem
    ? [error.message, error.detail].filter(Boolean).join('. ')
    : 'Something went wrong. Try again.';

type Fields = NonNullable<Reading['fields']>;
const ROWS: { key: keyof Fields; label: string; filing?: string }[] = [
  { key: 'merchant', label: 'Merchant', filing: 'merchant' },
  { key: 'date', label: 'Date', filing: 'date' },
  { key: 'total', label: 'Total', filing: 'total' },
  { key: 'currency', label: 'Currency', filing: 'currency' },
  { key: 'subtotal', label: 'Subtotal' },
  { key: 'taxTotal', label: 'Tax' },
  { key: 'tip', label: 'Tip' },
  { key: 'cardLastFour', label: 'Card' },
  { key: 'documentType', label: 'Type' },
];

/** Gives up refreshing after this long; the page offers to read it again instead. */
const POLL_LIMIT_MS = 3 * 60 * 1000;

/** One receipt, read by each compared model, side by side (ADR-0017). */
export default function ReceiptPage() {
  const { id } = useParams<{ id: string }>();
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [stale, setStale] = useState(false);

  const refresh = useCallback(async () => {
    const session = (await supabase()?.auth.getSession())?.data.session;
    if (!session) {
      setLoad({ state: 'signed-out' });
      return;
    }
    try {
      setLoad({ state: 'ready', receipt: await api<ReceiptDetail>(`/v1/receipts/${id}`) });
    } catch (error) {
      setLoad({ state: 'error', message: describeError(error) });
    }
  }, [id]);

  useEffect(() => {
    // Loading reads the browser's session, so it can only start after mounting.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  const reading = load.state === 'ready' && load.receipt.status === 'processing';
  useEffect(() => {
    if (!reading) return;
    const started = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - started < POLL_LIMIT_MS) {
        void refresh();
        return;
      }
      setStale(true);
      clearInterval(timer);
    }, 2500);
    return () => clearInterval(timer);
  }, [reading, refresh]);

  async function readAgain() {
    setBusy(true);
    setMessage(null);
    setStale(false);
    try {
      await api(`/v1/receipts/${id}/read`, { method: 'POST' });
      await refresh();
    } catch (error) {
      setMessage(describeError(error));
    } finally {
      setBusy(false);
    }
  }

  const receipt = load.state === 'ready' ? load.receipt : null;

  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col px-4 pt-[max(1rem,env(safe-area-inset-top))]">
      <header className="flex items-baseline justify-between py-3">
        <Link href="/receipts" className="text-sm font-semibold text-carbon">
          ← Receipts
        </Link>
      </header>
      <main className="flex flex-1 flex-col gap-4 pb-8">
        <h1 className="text-2xl font-bold">{receipt?.merchant ?? 'Receipt'}</h1>
        {load.state === 'loading' ? <p className="text-sm text-ink-2">Loading…</p> : null}
        {load.state === 'signed-out' ? (
          <p className="text-sm">
            <Link href="/sign-in" className="font-semibold text-carbon underline">
              Sign in
            </Link>{' '}
            to see this receipt.
          </p>
        ) : null}
        {load.state === 'error' ? (
          <p role="alert" className="text-sm text-warn">
            {load.message}
          </p>
        ) : null}

        {receipt ? (
          <>
            <Verdict receipt={receipt} stale={reading && stale} />
            <Comparison receipt={receipt} />
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => void readAgain()}
                disabled={busy || (reading && !stale)}
                className="rounded-lg border border-rule px-4 py-2 text-sm font-semibold disabled:opacity-60"
              >
                {busy ? 'Working…' : 'Read again'}
              </button>
              <span className="text-xs text-ink-2">
                Added by {receipt.uploadedBy}, {new Date(receipt.createdAt).toLocaleString()}
              </span>
            </div>
            {message ? (
              <p role="alert" className="text-sm text-warn">
                {message}
              </p>
            ) : null}
            <Original receipt={receipt} />
          </>
        ) : null}
      </main>
    </div>
  );
}

function Verdict({ receipt, stale }: { receipt: ReceiptDetail; stale: boolean }) {
  const status = RECEIPT_STATUS[receipt.status];
  const fallback = receipt.readings.find((r) => r.role === 'fallback');
  let text: string;
  if (receipt.status === 'processing') {
    text = stale
      ? 'This is taking longer than it should. Try reading it again.'
      : 'Both models are reading it. This takes a few seconds.';
  } else if (receipt.status === 'extracted') {
    text = 'Both models read it with confidence and agree.';
  } else if (receipt.status === 'failed') {
    text = 'No model could read it. See why below.';
  } else if (fallback?.fields) {
    text = `Claude couldn't read it, so ${fallback.label} did. One reading, so check it before you rely on it.`;
  } else if (receipt.differences.length > 0) {
    text = `The models disagree on ${receipt.differences.join(', ')}.`;
  } else {
    text = 'At least one model was unsure or could not read it.';
  }
  return (
    <p role="status" className="rounded-xl border border-rule bg-sheet px-4 py-3 text-sm">
      <span className={`font-semibold ${status.tone}`}>{status.label}.</span> {text}
    </p>
  );
}

const isMoney = (v: unknown): v is MoneyField =>
  typeof v === 'object' && v !== null && 'decimal' in v;

function Value({ value }: { value: TextField | MoneyField | string | null | undefined }) {
  if (value === null || value === undefined) return <span className="text-ink-3">–</span>;
  if (typeof value === 'string') return <span>{value.replaceAll('_', ' ')}</span>;
  const text = isMoney(value) ? formatMoney(value) : value.value;
  return (
    <span className="flex flex-col">
      <span className="tabular-nums">{text}</span>
      {isMoney(value) && value.assumed ? (
        <span className="text-xs text-ink-2">not on receipt</span>
      ) : value.confidence === 'high' ? null : (
        <span className="text-xs text-warn">{value.confidence} confidence</span>
      )}
    </span>
  );
}

function Comparison({ receipt }: { receipt: ReceiptDetail }) {
  const { readings } = receipt;
  const cell = (r: Reading, content: ReactNode) =>
    r.state === 'pending' ? <span className="text-ink-3">…</span> : content;
  return (
    <section
      aria-labelledby="readings-title"
      className="rounded-xl border border-rule bg-sheet p-4"
    >
      <h2 id="readings-title" className="sr-only">
        What each model read
      </h2>
      <table className="w-full table-fixed text-sm">
        <caption className="sr-only">Each model&apos;s reading, side by side</caption>
        <thead>
          <tr className="text-left">
            <th scope="col" className="w-1/4 pb-2 text-xs font-medium text-ink-2">
              <span className="sr-only">Field</span>
            </th>
            {readings.map((r) => (
              <th key={r.model} scope="col" className="pb-2 font-semibold">
                {r.label}
                {r.role === 'fallback' ? (
                  <span className="block text-xs font-normal text-ink-2">fallback</span>
                ) : null}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {readings.some((r) => r.state === 'failed' || r.state === 'missing') ? (
            <tr className="border-t border-rule align-top">
              <th scope="row" className="py-2 text-left text-xs font-medium text-ink-2">
                Problem
              </th>
              {readings.map((r) => (
                <td key={r.model} className="py-2 pr-2 text-xs text-warn">
                  {r.state === 'failed' || r.state === 'missing'
                    ? describeReadingError(r.error, providerOf(r))
                    : ''}
                </td>
              ))}
            </tr>
          ) : null}
          {ROWS.map((row) => {
            const differs = row.filing !== undefined && receipt.differences.includes(row.filing);
            return (
              <tr
                key={row.key}
                className={`border-t border-rule align-top ${differs ? 'bg-carbon-wash' : ''}`}
              >
                <th scope="row" className="py-2 text-left text-xs font-medium text-ink-2">
                  {row.label}
                  {differs ? <span className="block text-warn">differs</span> : null}
                </th>
                {readings.map((r) => (
                  <td key={r.model} className="py-2 pr-2 break-words">
                    {cell(r, <Value value={r.fields?.[row.key]} />)}
                  </td>
                ))}
              </tr>
            );
          })}
          <tr className="border-t border-rule">
            <th scope="row" className="py-2 text-left text-xs font-medium text-ink-2">
              Time
            </th>
            {readings.map((r) => (
              <td key={r.model} className="py-2 tabular-nums">
                {cell(r, formatSeconds(r.latencyMs))}
              </td>
            ))}
          </tr>
          <tr className="border-t border-rule">
            <th scope="row" className="py-2 text-left text-xs font-medium text-ink-2">
              Cost
            </th>
            {readings.map((r) => (
              <td key={r.model} className="py-2 tabular-nums">
                {cell(r, formatCost(r.costMicroUsd))}
              </td>
            ))}
          </tr>
        </tbody>
      </table>
    </section>
  );
}

function Original({ receipt }: { receipt: ReceiptDetail }) {
  if (!receipt.imageUrl) return null;
  if (receipt.contentType === 'application/pdf') {
    return (
      <a
        href={receipt.imageUrl}
        target="_blank"
        rel="noreferrer"
        className="text-sm text-carbon underline"
      >
        Open the original PDF
      </a>
    );
  }
  return (
    <figure className="flex flex-col gap-1">
      {/* A short-lived signed link to a private file; next/image can't cache it usefully. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={receipt.imageUrl}
        alt={`The original receipt${receipt.merchant ? ` from ${receipt.merchant}` : ''}`}
        className="w-full rounded-xl border border-rule"
      />
      <figcaption className="text-xs text-ink-2">The original, as uploaded.</figcaption>
    </figure>
  );
}
