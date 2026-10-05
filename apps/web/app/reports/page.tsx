'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { api, ApiProblem } from '../../lib/api';
import { APPROVAL_FLAG } from '../../lib/approval';
import { useFeatures } from '../../lib/features';
import { formatMoney } from '../../lib/receipts';
import {
  asSpent,
  leftOut,
  reportHolds,
  reportName,
  reportProgress,
  reportWhen,
  type ReportSummary,
} from '../../lib/reports';
import { supabase } from '../../lib/supabase';

type Load =
  | { state: 'loading' }
  | { state: 'signed-out' }
  | { state: 'error'; message: string }
  | { state: 'ready'; reports: ReportSummary[]; toApprove: ReportSummary[] };

const describeError = (error: unknown) =>
  error instanceof ApiProblem
    ? [error.message, error.detail].filter(Boolean).join('. ')
    : 'Something went wrong. Try again.';

/**
 * Its total: in the reimbursement currency while conversion is on (FR-EXP-13), with the
 * amounts as spent beside it when they differ; otherwise one total per currency, as spent.
 */
function totals(r: ReportSummary): { main: string; aside: string | null } {
  if (!r.reimbursement) return { main: asSpent(r.totals), aside: null };
  const spent = asSpent(r.totals);
  const main = formatMoney(r.reimbursement.total);
  const notes = [...(spent !== main ? [`spent ${spent}`] : []), leftOut(r.reimbursement)];
  return { main, aside: notes.filter(Boolean).join(' · ') || null };
}

/**
 * Expense reports (FR-EXP-05): a trip joins the open one 24 hours after its return date, and
 * a local expense 24 hours after its own. Each closes within 28 days (FR-EXP-12).
 */
export default function ReportsPage() {
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const features = useFeatures();
  const approval = features(APPROVAL_FLAG);

  const refresh = useCallback(async () => {
    const session = (await supabase()?.auth.getSession())?.data.session;
    if (!session) {
      setLoad({ state: 'signed-out' });
      return;
    }
    try {
      // While approval is on, the reports waiting for the person's decision come first (#24).
      const [{ reports }, waiting] = await Promise.all([
        api<{ reports: ReportSummary[] }>('/v1/reports'),
        approval ? api<{ reports: ReportSummary[] }>('/v1/approvals') : { reports: [] },
      ]);
      setLoad({ state: 'ready', reports, toApprove: waiting.reports });
    } catch (error) {
      setLoad({ state: 'error', message: describeError(error) });
    }
  }, [approval]);

  useEffect(() => {
    // Loading reads the browser's session, so it can only start after mounting.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  const open = load.state === 'ready' ? load.reports.filter((r) => r.status === 'open') : [];
  const done = load.state === 'ready' ? load.reports.filter((r) => r.status === 'closed') : [];
  const submitted =
    load.state === 'ready'
      ? load.reports.filter((r) => r.status !== 'open' && r.status !== 'closed')
      : [];
  const toApprove = load.state === 'ready' ? load.toApprove : [];

  return (
    <div className="mx-auto flex w-full max-w-md flex-1 flex-col px-4 pt-[max(1rem,env(safe-area-inset-top))]">
      <main className="flex flex-1 flex-col gap-5 pt-3 pb-8">
        <h1 className="text-2xl font-bold">Reports</h1>
        {load.state === 'loading' ? <p className="text-sm text-ink-2">Loading…</p> : null}
        {load.state === 'signed-out' ? (
          <p className="text-sm">
            <Link href="/sign-in" className="font-semibold text-carbon underline">
              Sign in
            </Link>{' '}
            to see your reports.
          </p>
        ) : null}
        {load.state === 'error' ? (
          <p role="alert" className="text-sm text-warn">
            {load.message}
          </p>
        ) : null}
        {load.state === 'ready' && load.reports.length === 0 ? (
          <section className="rounded-xl border border-rule bg-sheet p-5">
            <h2 className="font-semibold">No reports yet</h2>
            <p className="mt-1 text-sm text-ink-2">
              A trip goes on a report 24 hours after you’re back, and so does an expense on no trip.
              You then have 28 days to close it.
            </p>
          </section>
        ) : null}
        {toApprove.length > 0 ? (
          <ReportList id="approve" title="To approve" reports={toApprove} showOwner />
        ) : null}
        {open.length > 0 ? <ReportList id="open" title="Open" reports={open} /> : null}
        {done.length > 0 ? <ReportList id="done" title="Closed" reports={done} /> : null}
        {submitted.length > 0 ? (
          <ReportList id="submitted" title="Submitted" reports={submitted} />
        ) : null}
      </main>
    </div>
  );
}

function ReportList({
  id,
  title,
  reports,
  showOwner = false,
}: {
  id: string;
  title: string;
  reports: ReportSummary[];
  /** Name whose report each is: for reports someone else submitted. */
  showOwner?: boolean;
}) {
  return (
    <section aria-labelledby={`${id}-title`} className="flex flex-col gap-2">
      <h2 id={`${id}-title`} className="text-xs font-semibold tracking-wider text-ink-2 uppercase">
        {title}
      </h2>
      <ul className="flex flex-col divide-y divide-rule rounded-xl border border-rule bg-sheet">
        {reports.map((r) => {
          const progress = reportProgress(r);
          const total = totals(r);
          return (
            <li key={r.id}>
              <Link
                href={`/reports/${r.id}`}
                className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 px-4 py-3"
              >
                <span className="truncate text-sm font-semibold">
                  {showOwner ? `${r.owner} · ` : ''}
                  {reportName(r)}
                </span>
                <span className="text-right font-mono text-sm whitespace-nowrap">{total.main}</span>
                {total.aside ? (
                  <span className="col-span-2 text-right text-xs break-words text-ink-2">
                    {total.aside}
                  </span>
                ) : null}
                <span className="text-xs text-ink-2">
                  {reportHolds(r)} · <span className="whitespace-nowrap">{reportWhen(r)}</span>
                </span>
                <span
                  className={`justify-self-end text-xs font-semibold whitespace-nowrap ${progress.tone === 'ok' ? 'text-ok' : progress.tone === 'warn' ? 'text-warn' : 'text-ink-2'}`}
                >
                  {progress.text}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
