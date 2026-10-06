'use client';

import { showDate } from '@expensewise/domain';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { api, apiDownload, ApiProblem } from '../../../lib/api';
import { EXPENSE_STATUS } from '../../../lib/expenses';
import { useFeatures } from '../../../lib/features';
import { formatMoney } from '../../../lib/receipts';
import {
  asSpent,
  leftOut,
  rateSource,
  REPORT_STATUS,
  reportHolds,
  reportName,
  reportWhen,
  type Reimbursed,
  type ReimbursementTotal,
  type ReportDetail,
  type ReportSummary,
} from '../../../lib/reports';
import { supabase } from '../../../lib/supabase';
import { tripDates } from '../../../lib/trips';
import { HistoryLink } from '../../history-link';
import { CATEGORIES_FLAG } from '../../../lib/categories';
import { SPLIT_FLAG } from '../../../lib/itemized';
import { APPROVAL_FLAG } from '../../../lib/approval';
import type { CompanyPaidSection } from '../../../lib/company-paid';
import { ApprovalPanel } from './approval';
import { ByCategory } from './by-category';

type Load =
  | { state: 'loading' }
  | { state: 'signed-out' }
  | { state: 'error'; message: string }
  | { state: 'ready'; report: ReportDetail; open: ReportSummary[] };

const describeError = (error: unknown) =>
  error instanceof ApiProblem
    ? [error.message, error.detail].filter(Boolean).join('. ')
    : 'Something went wrong. Try again.';

const totals = asSpent;

/** A trip's total in the reimbursement currency, and what it leaves out (FR-EXP-13). */
function converted(r: ReimbursementTotal | undefined, spent: string) {
  if (!r) return { main: spent, aside: null };
  const main = formatMoney(r.total);
  const notes = [...(spent !== main ? [`spent ${spent}`] : []), leftOut(r)];
  return { main, aside: notes.filter(Boolean).join(' · ') || null };
}

/** A local expense's amount in the reimbursement currency, in a few words. */
function reimbursedText(r: Reimbursed): string {
  if (r.kind === 'converting') return 'Converting…';
  if (r.kind === 'unconverted') return 'Not converted: no reference rate';
  return r.amount ? formatMoney(r.amount) : '–';
}

const day = (iso: string) => showDate(iso);

/** What the report needs, in a sentence (FR-EXP-12); with approval on, its approval too. */
function verdict(report: ReportDetail, approval: boolean): string {
  const n = report.needsAttention;
  const things = n === 1 ? '1 thing needs you' : `${n} things need you`;
  if (report.status === 'closed') {
    return approval
      ? 'Submit it for approval when you’re ready. Until then you can reopen it.'
      : 'You can reopen it until it is submitted. Submitting for reimbursement comes next.';
  }
  if (report.status === 'approved') return 'It is approved, and locked.';
  if (report.status !== 'open') return 'It is submitted, and locked.';
  if (report.overdue) {
    return `It was due to close ${day(report.closesAt)}. ${things} first; reimbursement waits until then.`;
  }
  if (report.warning) {
    return `${things}. Close it by ${day(report.closesAt)}, or reimbursement will be delayed.`;
  }
  if (report.canClose) return 'Everything on it is ready. Close it when you’re done.';
  if (n > 0) return `${things} before it can close. It closes itself ${day(report.closesAt)}.`;
  return 'Nothing is on it yet.';
}

/**
 * One report (FR-EXP-05, FR-EXP-12, FR-EXP-14): its trips and local expenses, what still needs
 * the person, and closing or reopening it. A trip or local expense moves to another open
 * report, or a new one. A closed report exports as CSV or PDF, while `reports.export` is on;
 * with approval on, a submitted or approved one does instead (Q29), and the report is
 * submitted, approved or returned here (#24).
 */
export default function ReportPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState<'csv' | 'pdf' | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const features = useFeatures();

  const refresh = useCallback(async () => {
    const session = (await supabase()?.auth.getSession())?.data.session;
    if (!session) {
      setLoad({ state: 'signed-out' });
      return;
    }
    try {
      const [report, list] = await Promise.all([
        api<ReportDetail>(`/v1/reports/${id}`),
        api<{ reports: ReportSummary[] }>('/v1/reports'),
      ]);
      setLoad({
        state: 'ready',
        report,
        open: list.reports.filter((r) => r.status === 'open' && r.id !== id),
      });
    } catch (error) {
      setLoad({ state: 'error', message: describeError(error) });
    }
  }, [id]);

  useEffect(() => {
    // Loading reads the browser's session, so it can only start after mounting.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  async function act(path: 'close' | 'reopen', done: string) {
    setBusy(true);
    setMessage(null);
    try {
      const report = await api<ReportDetail>(`/v1/reports/${id}/${path}`, { method: 'POST' });
      setLoad((l) => (l.state === 'ready' ? { ...l, report } : l));
      setMessage(done);
    } catch (error) {
      setMessage(describeError(error));
    } finally {
      setBusy(false);
    }
  }

  /** Downloads the closed report as CSV or as a PDF summary (FR-SET-01). */
  async function download(format: 'csv' | 'pdf') {
    setExporting(format);
    setMessage(null);
    try {
      await apiDownload(`/v1/reports/${id}/export.${format}`, `expense-report.${format}`);
    } catch (error) {
      setMessage(describeError(error));
    } finally {
      setExporting(null);
    }
  }

  async function move(path: string, target: string) {
    setBusy(true);
    setMessage(null);
    try {
      const body = target === 'new' ? { newReport: true } : { reportId: target };
      const result = await api<{ reportId: string; dropped: string | null }>(path, {
        method: 'PUT',
        body: JSON.stringify(body),
      });
      // A report left holding nothing is gone: show the one it moved to.
      if (result.dropped === id) router.replace(`/reports/${result.reportId}`);
      else {
        await refresh();
        setMessage('Moved.');
      }
    } catch (error) {
      setMessage(describeError(error));
    } finally {
      setBusy(false);
    }
  }

  const report = load.state === 'ready' ? load.report : null;
  const others = load.state === 'ready' ? load.open : [];
  const open = report?.status === 'open';
  // What the company paid is listed apart from the claim (Q47), local or on a trip.
  const claimedLocals = report?.localItems.filter((e) => e.paidBy !== 'company') ?? [];

  return (
    <div className="mx-auto flex w-full max-w-md flex-1 flex-col px-4 pt-[max(1rem,env(safe-area-inset-top))]">
      <header className="flex items-baseline justify-between py-3">
        <Link href="/reports" className="tap text-sm font-semibold text-carbon">
          ← Reports
        </Link>
        <HistoryLink entityType="report" entityId={id} />
      </header>
      <main className="flex flex-1 flex-col gap-4 pb-8">
        <h1 className="text-2xl font-bold">{report ? reportName(report) : 'Report'}</h1>
        {load.state === 'loading' ? <p className="text-sm text-ink-2">Loading…</p> : null}
        {load.state === 'signed-out' ? (
          <p className="text-sm">
            <Link href="/sign-in" className="font-semibold text-carbon underline">
              Sign in
            </Link>{' '}
            to see this report.
          </p>
        ) : null}
        {load.state === 'error' ? (
          <p role="alert" className="text-sm text-warn">
            {load.message}
          </p>
        ) : null}

        {report ? (
          <>
            <p
              role="status"
              className={`rounded-xl border bg-sheet px-4 py-3 text-sm ${report.warning ? 'border-warn' : 'border-rule'}`}
            >
              <span className={`font-semibold ${REPORT_STATUS[report.status].tone}`}>
                {REPORT_STATUS[report.status].label}.
              </span>{' '}
              {verdict(report, features(APPROVAL_FLAG))}
            </p>

            <section
              aria-labelledby="totals-title"
              className="grid grid-cols-2 gap-2 rounded-xl border border-rule bg-sheet p-4"
            >
              <h2 id="totals-title" className="sr-only">
                Totals
              </h2>
              {report.reimbursement ? (
                <div className="flex flex-col">
                  <span className="text-xs font-medium text-ink-2">To reimburse</span>
                  <span className="font-mono text-base">
                    {formatMoney(report.reimbursement.total)}
                  </span>
                  <span className="text-xs break-words text-ink-2">
                    {leftOut(report.reimbursement) ?? `all in ${report.currency}`}
                  </span>
                </div>
              ) : (
                <div className="flex flex-col">
                  <span className="text-xs font-medium text-ink-2">Total</span>
                  <span className="font-mono text-base">{totals(report.totals)}</span>
                  <span className="text-xs text-ink-2">each currency apart</span>
                </div>
              )}
              <div className="flex flex-col">
                <span className="text-xs font-medium text-ink-2">On it</span>
                <span className="text-base">{reportHolds(report)}</span>
                <span className="text-xs text-ink-2">{reportWhen(report)}</span>
              </div>
              {report.reimbursement ? (
                <p className="col-span-2 text-xs break-words text-ink-2">
                  As spent: <span className="font-mono">{totals(report.totals)}</span>. Each amount
                  is converted at its purchase date’s reference rate.
                </p>
              ) : null}
            </section>

            {report.tripItems.length > 0 ? (
              <section aria-labelledby="trips-title" className="flex flex-col gap-2">
                <h2
                  id="trips-title"
                  className="text-xs font-semibold tracking-wider text-ink-2 uppercase"
                >
                  Trips
                </h2>
                <ul className="flex flex-col divide-y divide-rule rounded-xl border border-rule bg-sheet">
                  {report.tripItems.map((t) => {
                    // While Paid by the company is on, a trip counts its claim here; what the
                    // company paid is listed apart below (Q47).
                    const total = converted(
                      t.reimbursement,
                      totals(t.cost ? t.cost.claimed : t.totals),
                    );
                    return (
                      <li key={t.id} className="flex flex-col gap-1 px-4 py-3">
                        <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3">
                          <Link
                            href={`/trips/${t.id}`}
                            className="tap truncate text-sm font-semibold"
                          >
                            {t.name}
                          </Link>
                          <span className="text-right font-mono text-sm whitespace-nowrap">
                            {total.main}
                          </span>
                          {total.aside ? (
                            <span className="col-span-2 text-right text-xs break-words text-ink-2">
                              {total.aside}
                            </span>
                          ) : null}
                          <span className="text-xs text-ink-2">
                            <span className="whitespace-nowrap">{tripDates(t)}</span> ·{' '}
                            {t.expenseCount} {t.expenseCount === 1 ? 'expense' : 'expenses'}
                          </span>
                          <span
                            className={`justify-self-end text-xs font-semibold whitespace-nowrap ${t.ready ? 'text-ok' : 'text-warn'}`}
                          >
                            {t.ready
                              ? 'Ready'
                              : `${t.unsettled} ${t.unsettled === 1 ? 'needs' : 'need'} a look`}
                          </span>
                        </div>
                        {open ? (
                          <MoveTo
                            label={t.name}
                            others={others}
                            busy={busy}
                            onMove={(target) => void move(`/v1/trips/${t.id}/report`, target)}
                          />
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              </section>
            ) : null}

            {claimedLocals.length > 0 ? (
              <section aria-labelledby="local-title" className="flex flex-col gap-2">
                <h2
                  id="local-title"
                  className="text-xs font-semibold tracking-wider text-ink-2 uppercase"
                >
                  Local expenses
                </h2>
                <ul className="flex flex-col divide-y divide-rule rounded-xl border border-rule bg-sheet">
                  {claimedLocals.map((e) => {
                    const name = e.merchant ?? 'An expense';
                    return (
                      <li key={e.id} className="flex flex-col gap-1 px-4 py-3">
                        <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3">
                          <Link
                            href={`/expenses/${e.id}`}
                            className="tap truncate text-sm font-semibold"
                          >
                            {name}
                          </Link>
                          <span className="text-right font-mono text-sm whitespace-nowrap">
                            {e.reimbursed && e.reimbursed.kind !== 'same'
                              ? reimbursedText(e.reimbursed)
                              : e.amount
                                ? formatMoney(e.amount)
                                : '–'}
                          </span>
                          {e.reimbursed && e.reimbursed.kind !== 'same' && e.amount ? (
                            <span className="col-span-2 text-right text-xs break-words text-ink-2">
                              spent {formatMoney(e.amount)}
                              {e.reimbursed.rate
                                ? ` · at ${e.reimbursed.rate.rate}, ${rateSource(e.reimbursed.rate)}`
                                : ''}
                            </span>
                          ) : null}
                          <span className="text-xs text-ink-2">
                            <span className="whitespace-nowrap">
                              {e.date ? showDate(e.date) : 'No date'}
                            </span>
                            {e.held ? ' · possible duplicate' : ''}
                          </span>
                          <span
                            className={`justify-self-end text-xs font-semibold whitespace-nowrap ${e.ready ? 'text-ok' : 'text-warn'}`}
                          >
                            {e.ready
                              ? 'Ready'
                              : e.status !== 'ready'
                                ? EXPENSE_STATUS[e.status].label
                                : 'Needs a reason'}
                          </span>
                        </div>
                        {e.justification ? (
                          <p className="text-sm break-words text-ink-2">{e.justification}</p>
                        ) : (
                          <Link
                            href={`/expenses/${e.id}`}
                            className="tap self-start text-sm font-semibold text-carbon underline"
                          >
                            Add a reason<span className="sr-only">: {name}</span>
                          </Link>
                        )}
                        {open ? (
                          <MoveTo
                            label={name}
                            others={others}
                            busy={busy}
                            onMove={(target) => void move(`/v1/expenses/${e.id}/report`, target)}
                          />
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              </section>
            ) : null}

            {report.companyPaid && report.companyPaid.expenses.length > 0 ? (
              <CompanyPaid section={report.companyPaid} />
            ) : null}

            {features(APPROVAL_FLAG) ? (
              <ApprovalPanel
                key={`${report.status}-${report.closedAt ?? ''}`}
                reportId={id}
                onChanged={() => void refresh()}
              />
            ) : null}

            {features(SPLIT_FLAG) && features(CATEGORIES_FLAG) ? (
              <ByCategory key={JSON.stringify(report.totals)} reportId={id} />
            ) : null}

            {report.rates && report.rates.length > 0 ? (
              <section aria-labelledby="rates-title" className="flex flex-col gap-2">
                <h2
                  id="rates-title"
                  className="text-xs font-semibold tracking-wider text-ink-2 uppercase"
                >
                  Rates used
                </h2>
                <ul className="flex flex-col divide-y divide-rule rounded-xl border border-rule bg-sheet">
                  {report.rates.map((r) => (
                    <li
                      key={`${r.from}-${r.to}-${r.date}-${r.rate}`}
                      className="flex flex-col gap-0.5 px-4 py-3 text-sm"
                    >
                      <span className="font-mono break-words">
                        1 {r.from} = {r.rate} {r.to}
                      </span>
                      <span className="text-xs text-ink-2">
                        {rateSource(r)} · {r.expenses} {r.expenses === 1 ? 'amount' : 'amounts'}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            <div className="flex flex-wrap items-center gap-3">
              {open ? (
                <button
                  type="button"
                  onClick={() => void act('close', 'Closed. Submitting it comes next.')}
                  disabled={busy || !report.canClose}
                  className="rounded-lg bg-carbon px-4 py-2 text-sm font-semibold text-carbon-ink disabled:opacity-60"
                >
                  {busy ? 'Working…' : 'Close the report'}
                </button>
              ) : null}
              {report.status === 'closed' ? (
                <button
                  type="button"
                  onClick={() => void act('reopen', 'Reopened.')}
                  disabled={busy}
                  className="rounded-lg border border-rule px-4 py-2 text-sm font-semibold disabled:opacity-60"
                >
                  {busy ? 'Working…' : 'Reopen'}
                </button>
              ) : null}
              <span className="text-xs text-ink-2">Opened {showDate(report.openedAt)}</span>
            </div>
            {features('reports.export') &&
            (features(APPROVAL_FLAG)
              ? !['open', 'closed'].includes(report.status)
              : report.status !== 'open') ? (
              <div className="flex flex-wrap items-center gap-3">
                {(['csv', 'pdf'] as const).map((format) => (
                  <button
                    key={format}
                    type="button"
                    onClick={() => void download(format)}
                    disabled={busy || exporting !== null}
                    className="rounded-lg border border-rule px-4 py-2 text-sm font-semibold disabled:opacity-60"
                  >
                    {exporting === format ? 'Exporting…' : `Export ${format.toUpperCase()}`}
                  </button>
                ))}
              </div>
            ) : null}
            {message ? (
              <p role="status" className="text-sm">
                {message}
              </p>
            ) : null}
          </>
        ) : null}
      </main>
    </div>
  );
}

/**
 * What the company paid directly, listed apart, below the claim and outside its total, with
 * its total and the full cost per currency (FR-EXP-17, Q47). Each still has to be ready, like
 * anything on the report.
 */
function CompanyPaid({ section }: { section: CompanyPaidSection }) {
  return (
    <section aria-labelledby="company-paid-title" className="flex flex-col gap-2">
      <h2
        id="company-paid-title"
        className="text-xs font-semibold tracking-wider text-ink-2 uppercase"
      >
        Paid by the company, not claimed
      </h2>
      <ul className="flex flex-col divide-y divide-rule rounded-xl border border-rule bg-sheet">
        {section.expenses.map((e) => {
          const name = e.merchant ?? 'An expense';
          return (
            <li key={e.id} className="flex flex-col gap-1 px-4 py-3">
              <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3">
                <Link href={`/expenses/${e.id}`} className="tap truncate text-sm font-semibold">
                  {name}
                </Link>
                <span className="text-right font-mono text-sm whitespace-nowrap">
                  {e.amount ? formatMoney(e.amount) : '–'}
                </span>
                <span className="text-xs break-words text-ink-2">
                  <span className="whitespace-nowrap">{e.date ? showDate(e.date) : 'No date'}</span>
                  {e.trip ? ` · ${e.trip.name}` : ' · local'}
                  {e.held ? ' · possible duplicate' : ''}
                </span>
                <span
                  className={`justify-self-end text-xs font-semibold whitespace-nowrap ${e.ready ? 'text-ok' : 'text-warn'}`}
                >
                  {e.ready
                    ? 'Ready'
                    : e.status !== 'ready'
                      ? EXPENSE_STATUS[e.status].label
                      : 'Needs a reason'}
                </span>
              </div>
            </li>
          );
        })}
      </ul>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 rounded-xl border border-rule bg-sheet px-4 py-3 text-sm">
        <dt className="text-ink-2">Paid by the company</dt>
        <dd className="text-right font-mono break-words">{totals(section.totals)}</dd>
        <dt className="text-ink-2">Full cost</dt>
        <dd className="text-right font-mono break-words">{totals(section.fullCost)}</dd>
      </dl>
      <p className="text-xs text-ink-2">
        Your employer paid these directly. They are on the report so it shows the trip’s full cost,
        never in what you’re reimbursed.
      </p>
    </section>
  );
}

/** Moves one trip or local expense to another open report, or a new one. */
function MoveTo({
  label,
  others,
  busy,
  onMove,
}: {
  label: string;
  others: ReportSummary[];
  busy: boolean;
  onMove: (target: string) => void;
}) {
  const [opened, setOpened] = useState(false);
  const [target, setTarget] = useState('new');
  if (!opened) {
    return (
      <button
        type="button"
        onClick={() => setOpened(true)}
        className="tap self-start text-xs font-semibold text-carbon"
      >
        Move to another report<span className="sr-only">: {label}</span>
      </button>
    );
  }
  return (
    <div className="flex flex-wrap items-end gap-2">
      <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs font-medium text-ink-2">
        Move {label} to
        <select
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          className="min-h-11 rounded-lg border border-rule bg-paper px-3 text-base text-ink"
        >
          <option value="new">A new report</option>
          {others.map((r) => (
            <option key={r.id} value={r.id}>
              {reportName(r)}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        onClick={() => onMove(target)}
        disabled={busy}
        className="min-h-11 rounded-lg border border-rule px-4 text-sm font-semibold disabled:opacity-60"
      >
        Move
      </button>
      <button
        type="button"
        onClick={() => setOpened(false)}
        className="min-h-11 rounded-lg px-3 text-sm font-semibold text-ink-2"
      >
        Cancel
      </button>
    </div>
  );
}
