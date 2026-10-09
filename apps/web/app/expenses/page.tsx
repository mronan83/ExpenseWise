'use client';

import { showDate } from '@expensewise/domain';
import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, ApiProblem } from '../../lib/api';
import { statusOf, type ExpenseSummary } from '../../lib/expenses';
import { useFeatures } from '../../lib/features';
import { formText } from '../../lib/form';
import { CARD_STATEMENTS_FLAG } from '../../lib/card-statements';
import { MILEAGE_FLAG } from '../../lib/mileage';
import { formatMoney } from '../../lib/receipts';
import { supabase } from '../../lib/supabase';
import { Wordmark } from '../brand';

type Load =
  | { state: 'loading' }
  | { state: 'signed-out' }
  | { state: 'error'; message: string }
  | { state: 'ready'; expenses: ExpenseSummary[]; searched: boolean };

/** onTrip: 'no' for expenses on no trip, as Home's "Not on a trip" opens them. */
type Search = { q: string; from: string; to: string; amount: string; onTrip: '' | 'yes' | 'no' };
const NO_SEARCH: Search = { q: '', from: '', to: '', amount: '', onTrip: '' };

/** A search a link asked for, such as one of Home's figures. */
function searchInLink(): Search {
  const params = new URLSearchParams(window.location.search);
  const onTrip = params.get('onTrip');
  return {
    q: params.get('q') ?? '',
    from: params.get('from') ?? '',
    to: params.get('to') ?? '',
    amount: params.get('amount') ?? '',
    onTrip: onTrip === 'yes' || onTrip === 'no' ? onTrip : '',
  };
}

const describeError = (error: unknown) =>
  error instanceof ApiProblem
    ? [error.message, error.detail].filter(Boolean).join('. ')
    : 'Something went wrong. Try again.';

/**
 * Every expense, each made from a receipt that stays linked as its proof (ADR-0022), and a
 * search by merchant, dates or amount (FR-INS-02).
 */
export default function ExpensesPage() {
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [search, setSearch] = useState<Search>(NO_SEARCH);
  const featureOn = useFeatures();

  const refresh = useCallback(async (terms: Search) => {
    const session = (await supabase()?.auth.getSession())?.data.session;
    if (!session) {
      setLoad({ state: 'signed-out' });
      return;
    }
    const query = new URLSearchParams(
      Object.entries(terms)
        .map(([k, v]) => [k, v.trim()])
        .filter(([, v]) => v !== ''),
    );
    try {
      const { expenses } = await api<{ expenses: ExpenseSummary[] }>(
        `/v1/expenses?${query.toString()}`,
      );
      setLoad({ state: 'ready', expenses, searched: query.size > 0 });
    } catch (error) {
      setLoad({ state: 'error', message: describeError(error) });
    }
  }, []);

  useEffect(() => {
    // Loading reads the browser's session and the link, so it can only start after mounting.
    const linked = searchInLink();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSearch(linked);
    void refresh(linked);
  }, [refresh]);

  const searchFor = (terms: Search) => {
    setSearch(terms);
    void refresh(terms);
  };

  return (
    <div className="mx-auto flex w-full max-w-md flex-1 flex-col px-4 pt-[max(1rem,env(safe-area-inset-top))]">
      <header className="flex items-baseline justify-between py-3">
        <Link href="/" className="tap">
          <Wordmark />
        </Link>
        <span className="flex items-baseline gap-4">
          {featureOn(CARD_STATEMENTS_FLAG) ? (
            <Link href="/card" className="tap text-xs font-semibold text-carbon">
              Card
            </Link>
          ) : null}
          {featureOn(MILEAGE_FLAG) ? (
            <Link href="/mileage/new" className="tap text-xs font-semibold text-carbon">
              Add mileage
            </Link>
          ) : null}
          <Link href="/receipts" className="tap text-xs font-semibold text-carbon">
            Capture
          </Link>
        </span>
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
        {load.state === 'ready' && (load.searched || load.expenses.length > 0) ? (
          <SearchExpenses search={search} onSearch={searchFor} />
        ) : null}
        {load.state === 'ready' && load.searched && load.expenses.length === 0 ? (
          <p className="text-sm text-ink-2">No expenses match.</p>
        ) : null}
        {load.state === 'ready' && !load.searched && load.expenses.length === 0 ? (
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
                      {e.merchant ?? (e.status === 'processing' ? 'A receipt' : 'Expense')}
                    </span>
                    <span className="text-xs text-ink-2">
                      <span className={statusOf(e).tone}>{statusOf(e).label}</span>
                      {e.date ? ` · ${showDate(e.date)}` : ''}
                      {e.source === 'mileage' ? ' · Mileage' : ''}
                      {e.trip ? ` · ${e.trip.name}` : ''}
                      {e.matchesReceipt === false ? (
                        <span className="text-warn"> · differs from its receipt</span>
                      ) : null}
                      {/* Sent only while categories are switched on (FR-EXP-11). */}
                      {e.category?.state === 'confirmed'
                        ? ` · ${e.category.type?.name ?? ''}`
                        : null}
                      {e.category?.state === 'suggested' ? (
                        <span className="text-warn"> · {e.category.type?.name}, suggested</span>
                      ) : null}
                      {e.category?.state === 'missing' ? (
                        <span className="text-warn"> · no category</span>
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

function SearchExpenses({ search, onSearch }: { search: Search; onSearch: (s: Search) => void }) {
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    onSearch({
      q: formText(form, 'q'),
      from: formText(form, 'from'),
      to: formText(form, 'to'),
      amount: formText(form, 'amount'),
      onTrip: search.onTrip,
    });
  };
  const searching = Object.values(search).some((v) => v !== '');
  const field =
    'w-full min-w-0 rounded-lg border border-rule bg-paper px-3 py-2 text-base text-ink';
  const label = 'flex min-w-0 flex-col gap-1 text-xs font-medium text-ink-2';
  return (
    <form
      role="search"
      aria-label="Expenses"
      onSubmit={submit}
      key={JSON.stringify(search)}
      className="flex flex-col gap-3 rounded-xl border border-rule bg-sheet p-4"
    >
      <div className="grid grid-cols-[2fr_1fr] gap-3">
        <label className={label}>
          Merchant
          <input
            name="q"
            type="search"
            defaultValue={search.q}
            autoComplete="off"
            maxLength={200}
            className={field}
          />
        </label>
        <label className={label}>
          Amount
          <input
            name="amount"
            defaultValue={search.amount}
            inputMode="decimal"
            autoComplete="off"
            pattern="\d+(\.\d{1,3})?"
            title="An amount such as 18.92"
            className={field}
          />
        </label>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <label className={label}>
          From
          <input name="from" type="date" defaultValue={search.from} className={field} />
        </label>
        <label className={label}>
          To
          <input name="to" type="date" defaultValue={search.to} className={field} />
        </label>
      </div>
      {search.onTrip === 'no' ? (
        <p className="text-xs text-ink-2">Only expenses on no trip.</p>
      ) : search.onTrip === 'yes' ? (
        <p className="text-xs text-ink-2">Only expenses on a trip.</p>
      ) : null}
      <div className="flex flex-wrap gap-3">
        <button
          type="submit"
          className="rounded-lg border border-rule px-4 py-2 text-sm font-semibold"
        >
          Search
        </button>
        {searching ? (
          <button
            type="button"
            onClick={() => onSearch(NO_SEARCH)}
            className="rounded-lg px-4 py-2 text-sm font-semibold text-carbon"
          >
            Show all expenses
          </button>
        ) : null}
      </div>
    </form>
  );
}
