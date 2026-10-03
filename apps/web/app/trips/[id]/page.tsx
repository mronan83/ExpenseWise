'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, ApiProblem } from '../../../lib/api';
import { EXPENSE_STATUS, type ExpenseSummary } from '../../../lib/expenses';
import { formText } from '../../../lib/form';
import { formatMoney } from '../../../lib/receipts';
import { supabase } from '../../../lib/supabase';
import { dayLabel, tripDates, type TripDetail } from '../../../lib/trips';
import { TripFields } from '../trip-fields';

type Load =
  | { state: 'loading' }
  | { state: 'signed-out' }
  | { state: 'error'; message: string }
  | { state: 'ready'; trip: TripDetail };

const describeError = (error: unknown) =>
  error instanceof ApiProblem
    ? [error.message, error.detail].filter(Boolean).join('. ')
    : 'Something went wrong. Try again.';

/** One trip as a timeline: the trip is the report (design: Trip timeline). */
export default function TripPage() {
  const { id } = useParams<{ id: string }>();
  const [load, setLoad] = useState<Load>({ state: 'loading' });

  const refresh = useCallback(async () => {
    const session = (await supabase()?.auth.getSession())?.data.session;
    if (!session) {
      setLoad({ state: 'signed-out' });
      return;
    }
    try {
      setLoad({ state: 'ready', trip: await api<TripDetail>(`/v1/trips/${id}`) });
    } catch (error) {
      setLoad({ state: 'error', message: describeError(error) });
    }
  }, [id]);

  useEffect(() => {
    // Loading reads the browser's session, so it can only start after mounting.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  const trip = load.state === 'ready' ? load.trip : null;

  return (
    <div className="mx-auto flex w-full max-w-md flex-1 flex-col px-4 pt-[max(1rem,env(safe-area-inset-top))]">
      <header className="flex items-baseline justify-between py-3">
        <Link href="/trips" className="tap text-sm font-semibold text-carbon">
          ← Trips
        </Link>
      </header>
      <main className="flex flex-1 flex-col gap-4 pb-8">
        <h1 className="text-2xl font-bold">{trip?.name ?? 'Trip'}</h1>
        {load.state === 'loading' ? <p className="text-sm text-ink-2">Loading…</p> : null}
        {load.state === 'signed-out' ? (
          <p className="text-sm">
            <Link href="/sign-in" className="font-semibold text-carbon underline">
              Sign in
            </Link>{' '}
            to see this trip.
          </p>
        ) : null}
        {load.state === 'error' ? (
          <p role="alert" className="text-sm text-warn">
            {load.message}
          </p>
        ) : null}
        {trip ? (
          <>
            <Overview trip={trip} />
            <Timeline trip={trip} />
            <Manage
              key={trip.name + trip.startDate + trip.endDate + (trip.purpose ?? '')}
              trip={trip}
              onSaved={(next) => setLoad({ state: 'ready', trip: next })}
            />
          </>
        ) : null}
      </main>
    </div>
  );
}

function Overview({ trip }: { trip: TripDetail }) {
  const about = [
    tripDates(trip),
    `${trip.days} ${trip.days === 1 ? 'day' : 'days'}`,
    trip.purpose,
    trip.primaryCity,
  ].filter(Boolean);
  return (
    <section
      aria-label="Overview"
      className="flex flex-col gap-1 rounded-xl border border-rule bg-sheet px-4 py-3 text-sm"
    >
      <p className="text-ink-2">{about.join(' · ')}</p>
      <p role="status">
        {trip.expenseCount === 0 ? (
          'No expenses yet.'
        ) : (
          <>
            <span className="font-semibold">
              {trip.readyCount} of {trip.expenseCount} ready
            </span>
            {trip.needsReviewCount > 0 ? (
              <span className="text-warn">
                {' '}
                · {trip.needsReviewCount} {trip.needsReviewCount === 1 ? 'needs' : 'need'} a look
              </span>
            ) : null}
          </>
        )}
      </p>
      {trip.totals.length > 0 ? (
        <p className="text-lg font-semibold tabular-nums">
          {trip.totals.map(formatMoney).join(' + ')}
        </p>
      ) : null}
    </section>
  );
}

/** Its expenses by day, with what needs attention flagged on each. */
function Timeline({ trip }: { trip: TripDetail }) {
  const days = new Map<string, ExpenseSummary[]>();
  for (const e of trip.expenses) {
    const key = e.date ?? '';
    days.set(key, [...(days.get(key) ?? []), e]);
  }
  return (
    <section aria-labelledby="timeline-title" className="flex flex-col gap-3">
      <h2 id="timeline-title" className="text-base font-semibold">
        Timeline
      </h2>
      {trip.expenses.length === 0 ? (
        <p className="text-sm text-ink-2">
          Expenses dated {tripDates(trip)} file here on their own. To add one from another day, such
          as a flight booked ahead, open it and choose this trip.
        </p>
      ) : (
        [...days].map(([date, expenses]) => (
          <div key={date || 'undated'} className="flex flex-col gap-1">
            <h3 className="text-xs font-semibold tracking-wide text-ink-2 uppercase">
              {date ? dayLabel(date) : 'No date yet'}
              {date && (date < trip.startDate || date > trip.endDate) ? ' · outside the trip' : ''}
            </h3>
            <ul className="flex flex-col divide-y divide-rule rounded-xl border border-rule bg-sheet">
              {expenses.map((e) => (
                <li key={e.id}>
                  <Link
                    href={`/expenses/${e.id}`}
                    className="flex items-center justify-between gap-3 px-4 py-3"
                  >
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate text-sm font-medium">
                        {e.merchant ?? (e.status === 'processing' ? 'A receipt' : 'Expense')}
                      </span>
                      <Flags expense={e} />
                    </span>
                    <span className="text-sm tabular-nums">
                      {e.amount ? formatMoney(e.amount) : ''}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))
      )}
    </section>
  );
}

function Flags({ expense }: { expense: ExpenseSummary }) {
  const status = EXPENSE_STATUS[expense.status];
  return (
    <span className="text-xs text-ink-2">
      <span className={status.tone}>{status.label}</span>
      {expense.matchesReceipt === false ? (
        <span className="text-warn"> · differs from its receipt</span>
      ) : null}
      {expense.tripFiledBy === 'person' ? ' · put here by hand' : ''}
    </span>
  );
}

/** Edit or delete the trip. New dates file its expenses again (ADR-0023). */
function Manage({ trip, onSaved }: { trip: TripDetail; onSaved: (trip: TripDetail) => void }) {
  const router = useRouter();
  const [mode, setMode] = useState<'idle' | 'editing' | 'deleting'>('idle');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const entered = {
      name: formText(form, 'name').trim(),
      purpose: formText(form, 'purpose').trim() || null,
      primaryCity: formText(form, 'primaryCity').trim() || null,
      startDate: formText(form, 'startDate'),
      endDate: formText(form, 'endDate'),
    };
    const changed = Object.fromEntries(
      Object.entries(entered).filter(
        ([field, value]) => trip[field as keyof typeof entered] !== value,
      ),
    );
    if (Object.keys(changed).length === 0) {
      setMode('idle');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      onSaved(
        await api<TripDetail>(`/v1/trips/${trip.id}`, {
          method: 'PATCH',
          body: JSON.stringify(changed),
        }),
      );
    } catch (e) {
      setError(describeError(e));
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      await api<void>(`/v1/trips/${trip.id}`, { method: 'DELETE' });
      router.push('/trips');
    } catch (e) {
      setError(describeError(e));
      setBusy(false);
    }
  }

  return (
    <section
      aria-labelledby="manage-title"
      className="flex flex-col gap-3 rounded-xl border border-rule bg-sheet p-4 text-sm"
    >
      <h2 id="manage-title" className="text-base font-semibold">
        This trip
      </h2>
      {mode === 'editing' ? (
        <form onSubmit={(e) => void save(e)} className="flex flex-col gap-3">
          <TripFields trip={trip} />
          <p className="text-xs text-ink-2">
            New dates file expenses again: those dated in the trip join it, and those outside it
            leave, unless someone put them here by hand.
          </p>
          <div className="flex flex-wrap gap-3">
            <button
              type="submit"
              disabled={busy}
              className="rounded-lg bg-carbon px-4 py-2 text-sm font-semibold text-carbon-ink disabled:opacity-60"
            >
              {busy ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              onClick={() => {
                setMode('idle');
                setError(null);
              }}
              className="rounded-lg border border-rule px-4 py-2 text-sm font-semibold"
            >
              Cancel
            </button>
          </div>
        </form>
      ) : mode === 'deleting' ? (
        <div className="flex flex-col gap-3">
          <p>
            Delete {trip.name}? Its expenses stay, and file by date to any other trip that covers
            them.
          </p>
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              disabled={busy}
              onClick={() => void remove()}
              className="rounded-lg bg-bad px-4 py-2 text-sm font-semibold text-paper disabled:opacity-60"
            >
              {busy ? 'Deleting…' : 'Delete the trip'}
            </button>
            <button
              type="button"
              onClick={() => {
                setMode('idle');
                setError(null);
              }}
              className="rounded-lg border border-rule px-4 py-2 text-sm font-semibold"
            >
              Keep it
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            onClick={() => setMode('editing')}
            className="rounded-lg border border-rule px-4 py-2 text-sm font-semibold"
          >
            Edit
          </button>
          <button
            type="button"
            onClick={() => setMode('deleting')}
            className="rounded-lg border border-rule px-4 py-2 text-sm font-semibold text-bad"
          >
            Delete
          </button>
        </div>
      )}
      {error ? (
        <p role="alert" className="text-sm text-warn">
          {error}
        </p>
      ) : null}
    </section>
  );
}
