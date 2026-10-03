'use client';

import { tripPhase, type TripPhase } from '@expensewise/domain';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, ApiProblem } from '../../lib/api';
import { formText } from '../../lib/form';
import { formatMoney } from '../../lib/receipts';
import { supabase } from '../../lib/supabase';
import { localToday, tripDates, type TripDetail, type TripSummary } from '../../lib/trips';
import { TripFields } from './trip-fields';

type Load =
  | { state: 'loading' }
  | { state: 'signed-out' }
  | { state: 'error'; message: string }
  | { state: 'ready'; trips: TripSummary[]; searched: boolean };

type Search = { q: string; from: string; to: string };
const NO_SEARCH: Search = { q: '', from: '', to: '' };

const describeError = (error: unknown) =>
  error instanceof ApiProblem
    ? [error.message, error.detail].filter(Boolean).join('. ')
    : 'Something went wrong. Try again.';

const PHASES: { phase: TripPhase; title: string }[] = [
  { phase: 'under_way', title: 'Under way' },
  { phase: 'upcoming', title: 'Upcoming' },
  { phase: 'past', title: 'Past trips' },
];

/** Trips and trip history (FR-EXP-04, FR-INS-02): expenses file to them by date (ADR-0023). */
export default function TripsPage() {
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [search, setSearch] = useState<Search>(NO_SEARCH);

  const refresh = useCallback(async (terms: Search) => {
    const session = (await supabase()?.auth.getSession())?.data.session;
    if (!session) {
      setLoad({ state: 'signed-out' });
      return;
    }
    const query = new URLSearchParams(Object.entries(terms).filter(([, v]) => v.trim() !== ''));
    try {
      const { trips } = await api<{ trips: TripSummary[] }>(`/v1/trips?${query.toString()}`);
      setLoad({ state: 'ready', trips, searched: query.size > 0 });
    } catch (error) {
      setLoad({ state: 'error', message: describeError(error) });
    }
  }, []);

  useEffect(() => {
    // Loading reads the browser's session, so it can only start after mounting.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh(NO_SEARCH);
  }, [refresh]);

  const today = localToday();

  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col px-4 pt-[max(1rem,env(safe-area-inset-top))]">
      <header className="flex items-baseline justify-between py-3">
        <Link href="/" className="font-mono text-xs tracking-widest text-ink-2 uppercase">
          ExpenseWise
        </Link>
        <Link href="/expenses" className="text-xs font-semibold text-carbon">
          Expenses
        </Link>
      </header>
      <main className="flex flex-1 flex-col gap-4 pb-8">
        <h1 className="text-2xl font-bold">Trips</h1>
        {load.state === 'loading' ? <p className="text-sm text-ink-2">Loading…</p> : null}
        {load.state === 'signed-out' ? (
          <p className="text-sm">
            <Link href="/sign-in" className="font-semibold text-carbon underline">
              Sign in
            </Link>{' '}
            to see your trips.
          </p>
        ) : null}
        {load.state === 'error' ? (
          <p role="alert" className="text-sm text-warn">
            {load.message}
          </p>
        ) : null}
        {load.state === 'ready' ? (
          <>
            <NewTrip />
            <SearchTrips
              search={search}
              onSearch={(terms) => {
                setSearch(terms);
                void refresh(terms);
              }}
            />
            {load.trips.length === 0 ? (
              <p className="text-sm text-ink-2">
                {load.searched
                  ? 'No trips match.'
                  : 'No trips yet. Make one before you travel, and every expense dated in it files to it on its own.'}
              </p>
            ) : (
              PHASES.map(({ phase, title }) => {
                const trips = load.trips.filter((t) => tripPhase(t, today) === phase);
                return trips.length > 0 ? (
                  <section
                    key={phase}
                    aria-labelledby={`trips-${phase}`}
                    className="flex flex-col gap-2"
                  >
                    <h2 id={`trips-${phase}`} className="text-base font-semibold">
                      {title}
                    </h2>
                    <ul className="flex flex-col divide-y divide-rule rounded-xl border border-rule bg-sheet">
                      {trips.map((t) => (
                        <li key={t.id}>
                          <TripRow trip={t} />
                        </li>
                      ))}
                    </ul>
                  </section>
                ) : null;
              })
            )}
          </>
        ) : null}
      </main>
    </div>
  );
}

function TripRow({ trip }: { trip: TripSummary }) {
  const total = trip.totals.map(formatMoney).join(' + ');
  return (
    <Link href={`/trips/${trip.id}`} className="flex items-center justify-between gap-3 px-4 py-3">
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-sm font-medium">{trip.name}</span>
        <span className="text-xs text-ink-2">
          {tripDates(trip)}
          {trip.primaryCity ? ` · ${trip.primaryCity}` : ''}
        </span>
        <span className="text-xs text-ink-2">
          {trip.expenseCount === 0
            ? 'No expenses yet'
            : `${trip.readyCount} of ${trip.expenseCount} ready`}
          {trip.needsReviewCount > 0 ? (
            <span className="text-warn">
              {' '}
              · {trip.needsReviewCount} {trip.needsReviewCount === 1 ? 'needs' : 'need'} a look
            </span>
          ) : null}
        </span>
      </span>
      <span className="text-right text-sm tabular-nums">{total}</span>
    </Link>
  );
}

function SearchTrips({ search, onSearch }: { search: Search; onSearch: (s: Search) => void }) {
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    onSearch({ q: formText(form, 'q'), from: formText(form, 'from'), to: formText(form, 'to') });
  };
  const searching = search.q !== '' || search.from !== '' || search.to !== '';
  return (
    <form
      role="search"
      aria-label="Trips"
      onSubmit={submit}
      key={JSON.stringify(search)}
      className="flex flex-col gap-3 rounded-xl border border-rule bg-sheet p-4"
    >
      <label className="flex min-w-0 flex-col gap-1 text-xs font-medium text-ink-2">
        Name, purpose, city or merchant
        <input
          name="q"
          type="search"
          defaultValue={search.q}
          autoComplete="off"
          maxLength={200}
          className="w-full min-w-0 rounded-lg border border-rule bg-paper px-3 py-2 text-base text-ink"
        />
      </label>
      <div className="grid grid-cols-2 gap-3">
        <label className="flex min-w-0 flex-col gap-1 text-xs font-medium text-ink-2">
          From
          <input
            name="from"
            type="date"
            defaultValue={search.from}
            className="w-full min-w-0 rounded-lg border border-rule bg-paper px-3 py-2 text-base text-ink"
          />
        </label>
        <label className="flex min-w-0 flex-col gap-1 text-xs font-medium text-ink-2">
          To
          <input
            name="to"
            type="date"
            defaultValue={search.to}
            className="w-full min-w-0 rounded-lg border border-rule bg-paper px-3 py-2 text-base text-ink"
          />
        </label>
      </div>
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
            Show all trips
          </button>
        ) : null}
      </div>
    </form>
  );
}

/** Makes a trip and opens it, with the expenses that filed to it. */
function NewTrip() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const optional = (name: string) => formText(form, name).trim() || null;
    setBusy(true);
    setError(null);
    try {
      const trip = await api<TripDetail>('/v1/trips', {
        method: 'POST',
        body: JSON.stringify({
          name: formText(form, 'name'),
          purpose: optional('purpose'),
          primaryCity: optional('primaryCity'),
          startDate: formText(form, 'startDate'),
          endDate: formText(form, 'endDate'),
        }),
      });
      router.push(`/trips/${trip.id}`);
    } catch (e) {
      setError(describeError(e));
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <div>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="rounded-lg bg-carbon px-4 py-2 text-sm font-semibold text-carbon-ink"
        >
          New trip
        </button>
      </div>
    );
  }
  return (
    <section
      aria-labelledby="new-trip-title"
      className="flex flex-col gap-3 rounded-xl border border-rule bg-sheet p-4 text-sm"
    >
      <h2 id="new-trip-title" className="text-base font-semibold">
        New trip
      </h2>
      <form onSubmit={(e) => void create(e)} className="flex flex-col gap-3">
        <TripFields />
        <div className="flex flex-wrap gap-3">
          <button
            type="submit"
            disabled={busy}
            className="rounded-lg bg-carbon px-4 py-2 text-sm font-semibold text-carbon-ink disabled:opacity-60"
          >
            {busy ? 'Making it…' : 'Make the trip'}
          </button>
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              setError(null);
            }}
            className="rounded-lg border border-rule px-4 py-2 text-sm font-semibold"
          >
            Cancel
          </button>
        </div>
      </form>
      {error ? (
        <p role="alert" className="text-sm text-warn">
          {error}
        </p>
      ) : null}
    </section>
  );
}
