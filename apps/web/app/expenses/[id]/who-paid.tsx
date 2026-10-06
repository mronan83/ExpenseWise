'use client';

import { useState } from 'react';
import { api, ApiProblem } from '../../../lib/api';
import { paidByText, type PaidBy } from '../../../lib/company-paid';
import type { ExpenseDetail } from '../../../lib/expenses';

const describeError = (error: unknown) =>
  error instanceof ApiProblem
    ? [error.message, error.detail].filter(Boolean).join('. ')
    : 'Something went wrong. Try again.';

/**
 * Who paid an expense (FR-EXP-17, Q46): the person, or the company directly by the
 * organization's policy for its type or as set by hand, with a control to switch it and to hand
 * it back to the policy. Read-only once it is submitted. The page shows it only while Paid by the
 * company is on, and never for a drive.
 */
export function WhoPaid({
  expense,
  paidBy,
  pinned,
  onSaved,
}: {
  expense: ExpenseDetail;
  paidBy: PaidBy;
  pinned: boolean;
  onSaved: (expense: ExpenseDetail) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const changeable = expense.status === 'processing' || expense.editable;

  async function choose(body: { paidBy: PaidBy } | { byPolicy: true }) {
    setBusy(true);
    setError(null);
    try {
      onSaved(
        await api<ExpenseDetail>(`/v1/expenses/${expense.id}/paid-by`, {
          method: 'PUT',
          body: JSON.stringify(body),
        }),
      );
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      aria-labelledby="who-paid-title"
      className="flex flex-col gap-3 rounded-xl border border-rule bg-sheet p-4 text-sm"
    >
      <h2 id="who-paid-title" className="text-base font-semibold">
        Who paid
      </h2>
      <p role="status">{paidByText(paidBy, pinned)}</p>
      <p className="text-xs text-ink-2">
        {paidBy === 'company'
          ? 'It stays on its trip and in the trip’s cost, and is never claimed.'
          : 'You paid it, so it is claimed with the rest of its report.'}
        {pinned ? ' Set by hand: your organization’s policy leaves it as it is.' : ''}
      </p>
      {changeable ? (
        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            onClick={() => void choose({ paidBy: paidBy === 'company' ? 'claimant' : 'company' })}
            disabled={busy}
            className="rounded-lg border border-rule px-4 py-2 text-sm font-semibold disabled:opacity-60"
          >
            {paidBy === 'company' ? 'I paid it' : 'The company paid it'}
          </button>
          {pinned ? (
            <button
              type="button"
              onClick={() => void choose({ byPolicy: true })}
              disabled={busy}
              className="rounded-lg px-4 py-2 text-sm font-semibold text-carbon disabled:opacity-60"
            >
              Follow the policy
            </button>
          ) : null}
        </div>
      ) : (
        <p className="text-xs text-ink-2">
          It is on a submitted report, so it stays as it went in.
        </p>
      )}
      {error ? (
        <p role="alert" className="text-sm text-warn">
          {error}
        </p>
      ) : null}
    </section>
  );
}
