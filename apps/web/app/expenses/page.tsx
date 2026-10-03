'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { api, ApiProblem } from '../../lib/api';
import { EXPENSE_STATUS, type ExpenseSummary } from '../../lib/expenses';
import { formatMoney } from '../../lib/receipts';
import { supabase } from '../../lib/supabase';

type Load =
  | { state: 'loading' }
  | { state: 'signed-out' }
  | { state: 'error'; message: string }
  | { state: 'ready'; expenses: ExpenseSummary[] };

const describeError = (error: unknown) =>
  error instanceof ApiProblem
    ? [error.message, error.detail].filter(Boolean).join('. ')
    : 'Something went wrong. Try again.';

/** Every expense, each made from a receipt that stays linked as its proof (ADR-0022). */
export default function ExpensesPage() {
  const [load, setLoad] = useState<Load>({ state: 'loading' });

  const refresh = useCallback(async () => {
    const session = (await supabase()?.auth.getSession())?.data.session;
    if (!session) {
      setLoad({ state: 'signed-out' });
      return;
    }
    try {
      const { expenses } = await api<{ expenses: ExpenseSummary[] }>('/v1/expenses');
      setLoad({ state: 'ready', expenses });
    } catch (error) {
      setLoad({ state: 'error', message: describeError(error) });
    }
  }, []);

  useEffect(() => {
    // Loading reads the browser's session, so it can only start after mounting.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col px-4 pt-[max(1rem,env(safe-area-inset-top))]">
      <header className="flex items-baseline justify-between py-3">
        <Link href="/" className="font-mono text-xs tracking-widest text-ink-2 uppercase">
          ExpenseWise
        </Link>
        <Link href="/receipts" className="text-xs font-semibold text-carbon">
          Capture
        </Link>
      </header>
      <main className="flex flex-1 flex-col gap-4 pb-8">
        <h1 className="text-2xl font-bold">Expenses</h1>
        {load.state === 'loading' ? <p className="text-sm text-ink-2">Loading…</p> : null}
        {load.state === 'signed-out' ? (
          <p className="text-sm">
            <Link href="/sign-in" className="font-semibold text-carbon underline">
              Sign in
            </Link>{' '}
            to see your expenses.
          </p>
        ) : null}
        {load.state === 'error' ? (
          <p role="alert" className="text-sm text-warn">
            {load.message}
          </p>
        ) : null}
        {load.state === 'ready' && load.expenses.length === 0 ? (
          <p className="text-sm text-ink-2">
            No expenses yet.{' '}
            <Link href="/receipts" className="font-semibold text-carbon underline">
              Capture a receipt
            </Link>{' '}
            and it becomes one.
          </p>
        ) : null}
        {load.state === 'ready' && load.expenses.length > 0 ? (
          <ul className="flex flex-col divide-y divide-rule rounded-xl border border-rule bg-sheet">
            {load.expenses.map((e) => (
              <li key={e.id}>
                <Link
                  href={`/expenses/${e.id}`}
                  className="flex items-center justify-between gap-3 px-4 py-3"
                >
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate text-sm font-medium">
                      {e.merchant ?? (e.status === 'processing' ? 'Reading…' : 'Expense')}
                    </span>
                    <span className="text-xs text-ink-2">
                      <span className={EXPENSE_STATUS[e.status].tone}>
                        {EXPENSE_STATUS[e.status].label}
                      </span>
                      {e.date ? ` · ${e.date}` : ''}
                      {e.matchesReceipt === false ? (
                        <span className="text-warn"> · differs from its receipt</span>
                      ) : null}
                    </span>
                  </span>
                  <span className="text-sm tabular-nums">
                    {e.amount ? formatMoney(e.amount) : ''}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        ) : null}
      </main>
    </div>
  );
}
