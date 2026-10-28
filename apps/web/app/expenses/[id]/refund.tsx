'use client';

import { showDate } from '@expensewise/domain';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, ApiProblem } from '../../../lib/api';
import type { ExpenseDetail, RefundCandidate, RefundLink } from '../../../lib/expenses';
import { formatMoney } from '../../../lib/receipts';

const describeError = (error: unknown) =>
  error instanceof ApiProblem
    ? [error.message, error.detail].filter(Boolean).join('. ')
    : 'Something went wrong. Try again.';

const linkLine = (link: RefundLink) =>
  [
    link.merchant ?? 'An expense',
    link.date ? showDate(link.date) : null,
    link.amount && formatMoney(link.amount),
  ]
    .filter(Boolean)
    .join(' · ');

/**
 * A refund and its purchase (FR-EXP-21, ADR-0054). On a refund, money given back: the purchase
 * it is paired with, or, while it is paired with none and counts in no claim, the purchases it
 * fits to pair it with in one tap. On a purchase: the refunds that net it down.
 */
export function Refund({
  expense,
  onSaved,
}: {
  expense: ExpenseDetail;
  onSaved: (expense: ExpenseDetail) => void;
}) {
  const refund = expense.refund;
  const isRefund = (expense.amount?.amountMinor ?? 0) < 0;
  const waiting = isRefund && refund?.of === null;
  const [candidates, setCandidates] = useState<RefundCandidate[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!waiting || !expense.editable) return;
    let live = true;
    void api<{ candidates: RefundCandidate[] }>(`/v1/expenses/${expense.id}/refund-candidates`)
      .then(({ candidates: found }) => live && setCandidates(found))
      .catch((e: unknown) => live && setError(describeError(e)));
    return () => {
      live = false;
    };
  }, [waiting, expense.editable, expense.id, expense.updatedAt]);

  if (!refund) return null;

  async function pair(purchaseId: string | null) {
    setBusy(true);
    setError(null);
    try {
      onSaved(
        await api<ExpenseDetail>(`/v1/expenses/${expense.id}/refund-of`, {
          method: 'PUT',
          body: JSON.stringify({ purchaseId }),
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
      id="refund"
      aria-labelledby="refund-title"
      className="flex flex-col gap-3 rounded-xl border border-rule bg-sheet p-4 text-sm"
    >
      <h2 id="refund-title" className="text-base font-semibold">
        {isRefund ? 'Refund' : 'Refunds'}
      </h2>
      {!isRefund ? (
        <>
          <p className="text-xs text-ink-2">
            Money given back on this purchase. Each nets it down on the claim.
          </p>
          <ul className="flex flex-col gap-1">
            {refund.refunds.map((r) => (
              <li key={r.id}>
                <Link href={`/expenses/${r.id}`} className="font-semibold text-carbon underline">
                  {linkLine(r)}
                </Link>
              </li>
            ))}
          </ul>
        </>
      ) : refund.of ? (
        <>
          <p role="status">
            Refunds{' '}
            <Link
              href={`/expenses/${refund.of.id}`}
              className="font-semibold text-carbon underline"
            >
              {linkLine(refund.of)}
            </Link>
          </p>
          <p className="text-xs text-ink-2">
            {['ready', 'needs_review', 'processing'].includes(refund.of.status)
              ? 'It goes where its purchase goes, so the two net down on the same claim.'
              : 'Its purchase was claimed already, so it goes on your open report as money paid back.'}
            {expense.paidBy === 'company'
              ? ' The company paid the purchase, so this is the company’s too.'
              : ''}
          </p>
          {expense.editable ? (
            <button
              type="button"
              onClick={() => void pair(null)}
              disabled={busy}
              className="self-start rounded-lg px-4 py-2 text-sm font-semibold text-carbon disabled:opacity-60"
            >
              Unpair
            </button>
          ) : null}
        </>
      ) : (
        <>
          <p role="status">
            Money given back. It counts in no claim until it’s paired with the purchase it refunds.
          </p>
          {!expense.editable ? (
            <p className="text-xs text-ink-2">Confirm its receipt first, then pair it here.</p>
          ) : candidates === null ? (
            <p className="text-xs text-ink-2">Looking for its purchase…</p>
          ) : candidates.length === 0 ? (
            <p className="text-xs text-ink-2">
              None of your purchases fits it: one in its currency, dated on or up to 180 days before
              it, with that much left to give back. If its purchase was never claimed here, delete
              this refund from its receipt.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {candidates.map((c) => (
                <li
                  key={c.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-rule px-3 py-2"
                >
                  <span className="min-w-0">
                    <span className="block font-semibold">{linkLine(c)}</span>
                    {c.left && c.amount && c.left.amountMinor !== c.amount.amountMinor ? (
                      <span className="block text-xs text-ink-2">
                        {formatMoney(c.left)} left to give back
                      </span>
                    ) : null}
                  </span>
                  <button
                    type="button"
                    onClick={() => void pair(c.id)}
                    disabled={busy}
                    aria-label={`Pair with ${linkLine(c)}`}
                    className="min-h-11 rounded-lg bg-carbon px-4 text-sm font-semibold text-carbon-ink disabled:opacity-60"
                  >
                    Pair
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {error ? (
        <p role="alert" className="text-sm text-warn">
          {error}
        </p>
      ) : null}
    </section>
  );
}
