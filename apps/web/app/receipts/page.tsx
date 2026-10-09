'use client';

import { showDate } from '@expensewise/domain';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState, type ChangeEvent } from 'react';
import { api, ApiProblem } from '../../lib/api';
import { useFeatures } from '../../lib/features';
import { ReceiptFileError } from '../../lib/receipt-file';
import {
  captureReceipt,
  formatCost,
  formatMoney,
  formatSeconds,
  RECEIPT_STATUS,
  type CaptureTime,
  type ReceiptList,
} from '../../lib/receipts';
import { supabase } from '../../lib/supabase';
import { Wordmark } from '../brand';

type Load =
  | { state: 'loading' }
  | { state: 'signed-out' }
  | { state: 'error'; message: string }
  | { state: 'ready'; list: ReceiptList };

const describeError = (error: unknown) =>
  error instanceof ReceiptFileError
    ? error.message
    : error instanceof ApiProblem
      ? [error.message, error.detail].filter(Boolean).join('. ')
      : error instanceof Error
        ? error.message
        : 'Something went wrong. Try again.';

/** Capture receipts and see how the two compared models read them (ADR-0017). */
export default function ReceiptsPage() {
  const router = useRouter();
  const isOn = useFeatures();
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [progress, setProgress] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const session = (await supabase()?.auth.getSession())?.data.session;
    if (!session) {
      setLoad({ state: 'signed-out' });
      return;
    }
    try {
      await api('/v1/me/organization', { method: 'POST' });
      setLoad({ state: 'ready', list: await api<ReceiptList>('/v1/receipts') });
    } catch (error) {
      setLoad({ state: 'error', message: describeError(error) });
    }
  }, []);

  useEffect(() => {
    // Loading reads the browser's session, so it can only start after mounting.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  // While anything is being read, check again every few seconds.
  const reading =
    load.state === 'ready' && load.list.receipts.some((r) => r.status === 'processing');
  useEffect(() => {
    if (!reading) return;
    const timer = setInterval(() => void refresh(), 3000);
    return () => clearInterval(timer);
  }, [reading, refresh]);

  const capture = (source: 'camera' | 'upload') => (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file) return;
    setProblem(null);
    void (async () => {
      try {
        const { id } = await captureReceipt(file, source, setProgress);
        router.push(`/receipts/${id}`);
      } catch (error) {
        setProblem(describeError(error));
        setProgress(null);
      }
    })();
  };

  const list = load.state === 'ready' ? load.list : null;

  return (
    <div className="mx-auto flex w-full max-w-md flex-1 flex-col px-4 pt-[max(1rem,env(safe-area-inset-top))]">
      <header className="flex items-baseline justify-between py-3">
        <Link href="/" className="tap">
          <Wordmark />
        </Link>
        <Link href="/settings/ai" className="tap text-xs font-semibold text-carbon">
          Settings
        </Link>
      </header>
      <main className="flex flex-1 flex-col gap-4 pb-8">
        <h1 className="text-2xl font-bold">Receipts</h1>
        {load.state === 'loading' ? <p className="text-sm text-ink-2">Loading…</p> : null}
        {load.state === 'signed-out' ? (
          <p className="text-sm">
            <Link href="/sign-in" className="font-semibold text-carbon underline">
              Sign in
            </Link>{' '}
            to capture receipts.
          </p>
        ) : null}
        {load.state === 'error' ? (
          <p role="alert" className="text-sm text-warn">
            {load.message}
          </p>
        ) : null}

        {list ? (
          <>
            <section
              aria-labelledby="capture-title"
              className="flex flex-col gap-3 rounded-xl border border-rule bg-sheet p-5"
            >
              <h2 id="capture-title" className="font-semibold">
                Add a receipt
              </h2>
              <p className="text-sm text-ink-2">
                Each receipt is read by both Haiku and Sonnet, so you can see which reads your
                receipts well enough. Reading one costs about two cents on your Anthropic key.
              </p>
              <div className="flex flex-wrap gap-2">
                <label
                  className={`cursor-pointer rounded-lg bg-carbon px-4 py-2 text-sm font-semibold text-carbon-ink ${progress ? 'pointer-events-none opacity-60' : ''}`}
                >
                  Take a photo
                  <input
                    type="file"
                    accept="image/*"
                    capture="environment"
                    className="sr-only"
                    disabled={progress !== null}
                    onChange={capture('camera')}
                  />
                </label>
                <label
                  className={`cursor-pointer rounded-lg border border-rule px-4 py-2 text-sm font-semibold ${progress ? 'pointer-events-none opacity-60' : ''}`}
                >
                  Upload a file
                  <input
                    type="file"
                    accept="image/*,application/pdf"
                    className="sr-only"
                    disabled={progress !== null}
                    onChange={capture('upload')}
                  />
                </label>
              </div>
              <p role="status" className="min-h-5 text-sm text-ink-2">
                {progress}
              </p>
              {problem ? (
                <p role="alert" className="text-sm text-warn">
                  {problem}
                </p>
              ) : null}
              {!list.readingAvailable ? (
                <p className="text-sm text-warn">
                  Receipts are stored, but this server can&apos;t have them read yet: the workflow
                  runner (Inngest) isn&apos;t connected.
                </p>
              ) : null}
            </section>

            {list.comparison.receipts > 0 ? (
              <Comparison
                list={list}
                captureTime={isOn('receipts.capture-time') ? list.captureToReady : undefined}
              />
            ) : null}

            <section aria-labelledby="recent-title" className="flex flex-col gap-2">
              <h2 id="recent-title" className="font-semibold">
                Recent
              </h2>
              {list.receipts.length === 0 ? (
                <p className="text-sm text-ink-2">No receipts yet.</p>
              ) : (
                <ul className="flex flex-col divide-y divide-rule rounded-xl border border-rule bg-sheet">
                  {list.receipts.map((r) => (
                    <li key={r.id}>
                      <Link
                        href={`/receipts/${r.id}`}
                        className="flex items-center justify-between gap-3 px-4 py-3"
                      >
                        <span className="flex min-w-0 flex-col">
                          <span className="truncate text-sm font-medium">
                            {r.merchant ?? (r.status === 'processing' ? 'Reading…' : 'Receipt')}
                          </span>
                          <span className="text-xs text-ink-2">
                            {showDate(r.date ?? r.createdAt)} ·{' '}
                            <span className={RECEIPT_STATUS[r.status].tone}>
                              {RECEIPT_STATUS[r.status].label}
                            </span>
                          </span>
                        </span>
                        <span className="shrink-0 text-sm font-semibold tabular-nums">
                          {r.total ? formatMoney(r.total) : ''}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        ) : null}
      </main>
    </div>
  );
}

function Comparison({ list, captureTime }: { list: ReceiptList; captureTime?: CaptureTime }) {
  const { comparison } = list;
  return (
    <section
      aria-labelledby="comparison-title"
      className="flex flex-col gap-3 rounded-xl border border-rule bg-sheet p-5"
    >
      <h2 id="comparison-title" className="font-semibold">
        How the models compare
      </h2>
      <p className="text-sm text-ink-2">
        {comparison.compared === 0
          ? 'No receipt has been read by both models yet.'
          : `They read ${comparison.agreed} of ${comparison.compared} receipts the same way (merchant, date, currency and total).`}
      </p>
      <table className="w-full text-sm">
        <caption className="sr-only">Results per model over the receipts shown</caption>
        <thead>
          <tr className="text-left text-xs text-ink-2">
            <th scope="col" className="pb-1 font-medium">
              Model
            </th>
            <th scope="col" className="pb-1 text-right font-medium">
              Sure
            </th>
            <th scope="col" className="pb-1 text-right font-medium">
              Avg time
            </th>
            <th scope="col" className="pb-1 text-right font-medium">
              Spent
            </th>
          </tr>
        </thead>
        <tbody>
          {comparison.models.map((m) => (
            <tr key={m.model} className="border-t border-rule">
              <th scope="row" className="py-1.5 text-left font-medium">
                {m.label}
                {m.role === 'fallback' ? (
                  <span className="ml-1 text-xs font-normal text-ink-2">fallback</span>
                ) : null}
              </th>
              <td className="py-1.5 text-right tabular-nums">
                {m.confident}/{m.readings}
              </td>
              <td className="py-1.5 text-right tabular-nums">
                {formatSeconds(m.averageLatencyMs)}
              </td>
              <td className="py-1.5 text-right tabular-nums">{formatCost(m.costMicroUsd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {captureTime ? <CaptureToReady time={captureTime} /> : null}
    </section>
  );
}

/**
 * How long receipts take from capture to read, at the 95th percentile, against the goal of
 * under 30 seconds (NFR-PERF-01, GAP-16).
 */
function CaptureToReady({ time }: { time: CaptureTime }) {
  const goal = formatSeconds(time.sloMs);
  return (
    <p className="border-t border-rule pt-3 text-sm">
      <span className="font-semibold">Capture to Ready: </span>
      {time.p95Ms === null ? (
        <>no receipt has been read yet. The goal is under {goal}.</>
      ) : (
        <>
          95 in every 100 are read within{' '}
          <span className="font-semibold tabular-nums">{formatSeconds(time.p95Ms)}</span>, over{' '}
          {time.receipts} {time.receipts === 1 ? 'receipt' : 'receipts'}.{' '}
          <span className={time.withinSlo ? 'text-ok' : 'text-warn'}>
            {time.withinSlo ? `Under the goal of ${goal}.` : `Over the goal of ${goal}.`}
          </span>
        </>
      )}
    </p>
  );
}
