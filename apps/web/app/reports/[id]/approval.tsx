'use client';

import { APPROVAL_NOTE_MAX, showDate } from '@expensewise/domain';
import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, ApiProblem } from '../../../lib/api';
import { checkLabel, type Approval, type ReviewedExpense } from '../../../lib/approval';
import { formatMoney } from '../../../lib/receipts';

const describeError = (error: unknown) =>
  error instanceof ApiProblem
    ? [error.message, error.detail].filter(Boolean).join('. ')
    : 'Something went wrong. Try again.';

const field = 'rounded-lg border border-rule bg-paper px-3 py-2 text-base text-ink';

/** Where a report's approval stands, in a sentence. */
function standing(a: Approval): string | null {
  const latest = a.steps.at(-1);
  const when = (iso: string | null | undefined) => (iso ? showDate(iso) : '');
  if (a.status === 'in_approval' && a.approver) {
    return a.selfAttests
      ? `Submitted ${when(latest?.createdAt)}. You approve it yourself: you’re the only one here, and the audit trail says so.`
      : `Submitted ${when(latest?.createdAt)}, with ${a.approver.name} for approval.`;
  }
  if (a.status === 'approved' && latest) {
    return a.selfAttests
      ? `Approved ${when(latest.decidedAt)}, by you alone: self-attested, as the audit trail records.`
      : `Approved ${when(latest.decidedAt)} by ${latest.approver}. Its expenses are locked.`;
  }
  return null;
}

/**
 * A report's approval (FR-GOV-02, #24), while `reports.approval` is on: submitting a closed
 * report, who it is with, each expense against its receipt (Q6), and, for whoever decides it,
 * approving it or returning it with a comment and each rejected expense (FR-GOV-10 to
 * FR-GOV-12). A report that came back shows why, and each rejected expense with its reason.
 */
export function ApprovalPanel({
  reportId,
  onChanged,
}: {
  reportId: string;
  onChanged: () => void;
}) {
  const [approval, setApproval] = useState<Approval | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [returning, setReturning] = useState(false);

  const load = useCallback(async () => {
    try {
      setApproval(await api<Approval>(`/v1/reports/${reportId}/approval`));
    } catch (error) {
      setFailed(describeError(error));
    }
  }, [reportId]);

  useEffect(() => {
    // The approval is read with the browser's session, after mounting.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  async function act(path: 'submit' | 'approve' | 'return', body?: unknown, done = '') {
    setBusy(true);
    setMessage(null);
    try {
      const next = await api<Approval>(`/v1/reports/${reportId}/${path}`, {
        method: 'POST',
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      setApproval(next);
      setConfirming(false);
      setReturning(false);
      setMessage(done);
      onChanged();
    } catch (error) {
      setMessage(describeError(error));
    } finally {
      setBusy(false);
    }
  }

  if (failed) {
    return (
      <p role="alert" className="text-sm text-warn">
        {failed}
      </p>
    );
  }
  if (!approval) return null;
  const said = standing(approval);
  const deciding = approval.can.approve || approval.can.return;

  return (
    <section aria-labelledby="approval-title" className="flex flex-col gap-3">
      <h2 id="approval-title" className="text-xs font-semibold tracking-wider text-ink-2 uppercase">
        Approval
      </h2>
      {approval.returned ? (
        <div role="status" className="rounded-xl border border-bad bg-sheet px-4 py-3 text-sm">
          <p className="font-semibold text-bad">Returned {showDate(approval.returned.at)}</p>
          <p className="mt-1 break-words">
            {approval.returned.by}: “{approval.returned.comment}”
          </p>
          <p className="mt-1 text-xs text-ink-2">
            Put right what is rejected below, then close it and submit it again.
          </p>
        </div>
      ) : null}
      {said ? <p className="text-sm">{said}</p> : null}
      {!approval.mine && approval.status !== 'open' && approval.status !== 'closed' ? (
        <p className="text-xs text-ink-2">{approval.member}’s report.</p>
      ) : null}

      <ul className="flex flex-col divide-y divide-rule rounded-xl border border-rule bg-sheet">
        {approval.expenses.map((e) => (
          <ExpenseCheck key={e.id} expense={e} />
        ))}
      </ul>

      {approval.why ? <p className="text-sm text-ink-2">{approval.why.detail}</p> : null}
      {approval.secondFactor === 'needed' ? (
        <Link
          href="/settings/sign-ins"
          className="tap self-start text-sm font-semibold text-carbon underline"
        >
          Your second factor, in Settings › Sign-ins
        </Link>
      ) : null}

      {approval.can.submit ? (
        confirming ? (
          <div className="flex flex-col gap-3 rounded-xl border border-rule bg-sheet p-4 text-sm">
            <p>
              {approval.selfAttests
                ? 'You’re the only one here, so you approve it yourself next; the audit trail says so.'
                : `It goes to ${approval.approver?.name ?? 'its approver'} for approval.`}{' '}
              Its expenses can’t change while it waits.
            </p>
            <div className="flex flex-wrap gap-3">
              <button
                type="button"
                onClick={() => void act('submit', undefined, 'Submitted.')}
                disabled={busy}
                className="rounded-lg bg-carbon px-4 py-2 text-sm font-semibold text-carbon-ink disabled:opacity-60"
              >
                {busy ? 'Submitting…' : 'Submit it'}
              </button>
              <button
                type="button"
                onClick={() => setConfirming(false)}
                className="rounded-lg border border-rule px-4 py-2 text-sm font-semibold"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div>
            <button
              type="button"
              onClick={() => setConfirming(true)}
              className="rounded-lg bg-carbon px-4 py-2 text-sm font-semibold text-carbon-ink"
            >
              Submit for approval
            </button>
          </div>
        )
      ) : null}

      {deciding && !returning ? (
        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            onClick={() => void act('approve', undefined, 'Approved.')}
            disabled={busy || !approval.can.approve}
            className="rounded-lg bg-carbon px-4 py-2 text-sm font-semibold text-carbon-ink disabled:opacity-60"
          >
            {busy ? 'Working…' : 'Approve'}
          </button>
          {approval.can.return ? (
            <button
              type="button"
              onClick={() => setReturning(true)}
              className="rounded-lg border border-rule px-4 py-2 text-sm font-semibold"
            >
              Return it
            </button>
          ) : null}
        </div>
      ) : null}
      {returning ? (
        <ReturnForm
          approval={approval}
          busy={busy}
          onCancel={() => setReturning(false)}
          onReturn={(body) => void act('return', body, 'Returned to its member.')}
        />
      ) : null}
      {message ? (
        <p role="status" className="text-sm">
          {message}
        </p>
      ) : null}
    </section>
  );
}

/** One expense, how it holds up against its receipt, and why it was rejected if it was. */
function ExpenseCheck({ expense: e }: { expense: ReviewedExpense }) {
  const label = checkLabel(e.check);
  return (
    <li className="flex flex-col gap-1 px-4 py-3 text-sm">
      <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3">
        <Link href={`/expenses/${e.id}`} className="tap truncate font-semibold">
          {e.merchant ?? 'An expense'}
        </Link>
        <span className="text-right font-mono whitespace-nowrap">
          {e.amount ? formatMoney(e.amount) : '–'}
        </span>
        <span className="text-xs text-ink-2">
          <span className="whitespace-nowrap">{e.date ? showDate(e.date) : 'No date'}</span>
          {e.trip ? ` · ${e.trip}` : ' · local'}
        </span>
        {e.receipt?.amount && e.check.state !== 'matches' ? (
          <span className="text-right text-xs whitespace-nowrap text-ink-2">
            receipt {formatMoney(e.receipt.amount)}
          </span>
        ) : (
          <span />
        )}
      </div>
      <p
        className={`text-xs font-semibold ${label.tone === 'warn' ? 'text-warn' : label.tone === 'ok' ? 'text-ok' : 'text-ink-2'}`}
      >
        {label.text}
      </p>
      {e.claimReason ? (
        <p className="text-xs break-words text-ink-2">Why less: {e.claimReason}</p>
      ) : null}
      {e.rejection ? (
        <p className="text-sm break-words text-bad">
          <span className="font-semibold">Rejected</span>
          {e.rejection.automatic ? ' (it differs from its receipt)' : ''}: {e.rejection.reason}
        </p>
      ) : null}
    </li>
  );
}

/**
 * Returning a report: why it goes back, and each expense rejected with why. One that differs
 * from its receipt is rejected anyway (FR-GOV-10), so it is ticked and can't be unticked.
 */
function ReturnForm({
  approval,
  busy,
  onCancel,
  onReturn,
}: {
  approval: Approval;
  busy: boolean;
  onCancel: () => void;
  onReturn: (body: {
    comment: string;
    rejections: { expenseId: string; reason: string }[];
  }) => void;
}) {
  const [comment, setComment] = useState('');
  const [chosen, setChosen] = useState<Record<string, string>>({});

  function submit(event: FormEvent) {
    event.preventDefault();
    onReturn({
      comment,
      rejections: Object.entries(chosen).map(([expenseId, reason]) => ({ expenseId, reason })),
    });
  }

  const missingReason = Object.values(chosen).some((r) => r.trim() === '');
  return (
    <form
      onSubmit={submit}
      className="flex flex-col gap-3 rounded-xl border border-rule bg-sheet p-4 text-sm"
    >
      <label className="flex flex-col gap-1 text-xs font-medium text-ink-2">
        Why it goes back, for {approval.member} to read
        <textarea
          name="comment"
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          maxLength={APPROVAL_NOTE_MAX}
          rows={3}
          required
          className={field}
        />
      </label>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-xs font-semibold text-ink">
          Reject an expense, if any. The whole report goes back either way.
        </legend>
        {approval.expenses.map((e) => {
          const name = e.merchant ?? 'An expense';
          const differs = e.check.state === 'differs';
          const ticked = differs || e.id in chosen;
          return (
            <div key={e.id} className="flex flex-col gap-1">
              <label className="flex min-h-11 items-center gap-2">
                <input
                  type="checkbox"
                  checked={ticked}
                  disabled={differs}
                  onChange={(ev) =>
                    setChosen((c) => {
                      const next = { ...c };
                      if (ev.target.checked) next[e.id] = '';
                      else delete next[e.id];
                      return next;
                    })
                  }
                  className="size-5"
                />
                Reject {name}
                {e.amount ? ` · ${formatMoney(e.amount)}` : ''}
              </label>
              {differs ? (
                <p className="pl-7 text-xs text-warn">{e.check.text}</p>
              ) : e.id in chosen ? (
                <label className="flex flex-col gap-1 pl-7 text-xs font-medium text-ink-2">
                  Why {name} is rejected
                  <input
                    name={`reason-${e.id}`}
                    value={chosen[e.id] ?? ''}
                    onChange={(ev) => setChosen((c) => ({ ...c, [e.id]: ev.target.value }))}
                    maxLength={APPROVAL_NOTE_MAX}
                    required
                    className={`min-h-11 ${field}`}
                  />
                </label>
              ) : null}
            </div>
          );
        })}
      </fieldset>
      <div className="flex flex-wrap gap-3">
        <button
          type="submit"
          disabled={busy || comment.trim() === '' || missingReason}
          className="rounded-lg bg-carbon px-4 py-2 text-sm font-semibold text-carbon-ink disabled:opacity-60"
        >
          {busy ? 'Returning…' : 'Return the report'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg border border-rule px-4 py-2 text-sm font-semibold"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
