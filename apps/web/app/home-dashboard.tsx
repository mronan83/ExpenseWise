'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api, ApiProblem } from '../lib/api';
import type { ExpenseAmount } from '../lib/expenses';
import { monthEnd, monthName, tripProgress, tripWhen, type Home } from '../lib/home';
import { formatMoney } from '../lib/receipts';
import { supabase } from '../lib/supabase';
import { localToday, tripDates } from '../lib/trips';
import { NeedsYouList } from './needs-you';

type Load =
  | { state: 'loading' }
  | { state: 'signed-out' }
  | { state: 'error'; message: string }
  | { state: 'ready'; home: Home };

/** Totals in each currency, never converted: "$512.98 + €99.00". */
const totals = (amounts: readonly ExpenseAmount[]) =>
  amounts.length === 0 ? '–' : amounts.map((a) => formatMoney(a)).join(' + ');

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Home (FR-INS-01): Needs you first, then the trip under way or next, this month, and the
 * last trips. Every figure opens the list behind it, and a section with nothing to say is
 * left out. Home asks for the person's own day, so a trip starts on their calendar.
 */
export function HomeDashboard() {
  const [load, setLoad] = useState<Load>({ state: 'loading' });

  const refresh = useCallback(async () => {
    const session = (await supabase()?.auth.getSession())?.data.session;
    if (!session) {
      setLoad({ state: 'signed-out' });
      return;
    }
    try {
      await api('/v1/me/organization', { method: 'POST' });
      setLoad({ state: 'ready', home: await api<Home>(`/v1/home?day=${localToday()}`) });
    } catch (error) {
      setLoad({
        state: 'error',
        message:
          error instanceof ApiProblem
            ? [error.message, error.detail].filter(Boolean).join('. ')
            : 'Something went wrong. Try again.',
      });
    }
  }, []);

  useEffect(() => {
    // Loading reads the browser's session, so it can only start after mounting.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  const count = load.state === 'ready' ? load.home.needsYou.count : 0;
  return (
    <>
      <h1 className="flex items-center gap-3 text-2xl font-bold">
        Needs you
        {count > 0 ? (
          <span className="rounded-full bg-carbon px-2 font-mono text-xs text-carbon-ink">
            {count}
          </span>
        ) : null}
      </h1>
      {load.state === 'loading' ? <p className="text-sm text-ink-2">Loading…</p> : null}
      {load.state === 'signed-out' ? (
        <p className="text-sm">
          <Link href="/sign-in" className="font-semibold text-carbon underline">
            Sign in
          </Link>{' '}
          to see what needs you.
        </p>
      ) : null}
      {load.state === 'error' ? (
        <p role="alert" className="text-sm text-warn">
          {load.message}
        </p>
      ) : null}
      {load.state === 'ready' ? <Dashboard home={load.home} /> : null}
    </>
  );
}

function Dashboard({ home }: { home: Home }) {
  const { month } = home;
  const range = `from=${month.from}&to=${monthEnd(month.from)}`;
  const name = monthName(month.from);
  return (
    <>
      <NeedsYouList items={home.needsYou.items} count={home.needsYou.count} />
      {home.trip ? <TripCard trip={home.trip} /> : null}
      {month.expenses > 0 || month.trips > 0 ? (
        <Section
          id="month"
          title={`${name} so far`}
          more={{ href: `/expenses?${range}`, label: 'Expenses' }}
        >
          <div className="grid grid-cols-2 gap-2">
            <Figure
              href={`/expenses?${range}`}
              label="Spent"
              value={totals(month.spent)}
              note={plural(month.expenses, 'expense')}
            />
            <Figure
              href="/trips"
              label="Trips"
              value={String(month.trips)}
              note={home.trip?.when === 'now' ? '1 under way' : `in ${name}`}
            />
            <Figure
              href={`/expenses?${range}&onTrip=no`}
              label="Not on a trip"
              value={String(month.notOnTrip.expenses)}
              note={
                month.notOnTrip.expenses > 0
                  ? totals(month.notOnTrip.spent)
                  : 'Everything is on a trip'
              }
            />
            <Figure
              href={`/expenses?${range}`}
              label="Ready to file"
              value={`${month.ready} of ${month.expenses}`}
              note={
                month.ready === month.expenses
                  ? 'All Ready'
                  : `${month.expenses - month.ready} not Ready yet`
              }
            />
          </div>
        </Section>
      ) : null}
      {home.reading > 0 ? (
        <Link
          href="/receipts"
          className="tap flex items-center gap-2 self-start text-sm text-ink-2"
        >
          <span
            aria-hidden="true"
            className="size-2 rounded-full bg-carbon motion-safe:animate-pulse"
          />
          {plural(home.reading, 'receipt')} being read
        </Link>
      ) : null}
      {home.recentTrips.length > 0 ? (
        <Section id="recent" title="Recent trips" more={{ href: '/trips', label: 'All trips' }}>
          <ul className="flex flex-col divide-y divide-rule rounded-xl border border-rule bg-sheet">
            {home.recentTrips.map((t) => {
              const progress = tripProgress(t);
              return (
                <li key={t.id}>
                  <Link
                    href={`/trips/${t.id}`}
                    className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 px-4 py-3"
                  >
                    <span className="truncate text-sm font-semibold">{t.name}</span>
                    <span className="text-right font-mono text-sm whitespace-nowrap">
                      {totals(t.totals)}
                    </span>
                    <span className="text-xs text-ink-2">
                      <span className="whitespace-nowrap">{tripDates(t)}</span> ·{' '}
                      {plural(t.expenseCount, 'expense')}
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
        </Section>
      ) : null}
    </>
  );
}

function TripCard({ trip }: { trip: NonNullable<Home['trip']> }) {
  const t = trip.trip;
  const now = trip.when === 'now';
  return (
    <Section id="trip" title={now ? 'On a trip' : 'Coming up'}>
      <div className="flex flex-col gap-2 rounded-xl border border-rule bg-carbon-wash p-4">
        <div className="flex items-baseline justify-between gap-3">
          <Link href={`/trips/${t.id}`} className="min-w-0 truncate font-bold">
            {t.name}
          </Link>
          <span className="font-mono text-xs whitespace-nowrap text-ink-2">{tripWhen(trip)}</span>
        </div>
        <p className="text-xs text-ink-2">{tripDates(t)}</p>
        {now ? (
          <div aria-hidden="true" className="h-1.5 overflow-hidden rounded-full bg-sheet">
            <div
              className="h-full rounded-full bg-carbon"
              style={{ width: `${(trip.day / t.days) * 100}%` }}
            />
          </div>
        ) : null}
        {t.expenseCount === 0 ? (
          <p className="text-sm text-ink-2">No expenses yet.</p>
        ) : (
          <p className="flex flex-wrap gap-x-4 text-sm text-ink-2">
            <span>
              <span className="font-mono text-ink">{totals(t.totals)}</span> so far
            </span>
            <span>{plural(t.expenseCount, 'expense')}</span>
            {t.needsReviewCount > 0 ? (
              <span className="text-warn">{t.needsReviewCount} to check</span>
            ) : null}
          </p>
        )}
        <Link
          href={now ? '/receipts' : `/trips/${t.id}`}
          className="inline-flex min-h-11 items-center self-start rounded-lg bg-carbon px-4 text-sm font-semibold text-carbon-ink"
        >
          {now ? 'Add a receipt' : 'Open the trip'}
        </Link>
      </div>
    </Section>
  );
}

function Section({
  id,
  title,
  more,
  children,
}: {
  id: string;
  title: string;
  more?: { href: string; label: string };
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={`${id}-title`} className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between">
        <h2
          id={`${id}-title`}
          className="text-xs font-semibold tracking-wider text-ink-2 uppercase"
        >
          {title}
        </h2>
        {more ? (
          <Link href={more.href} className="tap text-xs font-semibold text-carbon">
            {more.label}
          </Link>
        ) : null}
      </div>
      {children}
    </section>
  );
}

function Figure({
  href,
  label,
  value,
  note,
}: {
  href: string;
  label: string;
  value: string;
  note: string;
}) {
  return (
    <Link
      href={href}
      className="flex min-w-0 flex-col gap-0.5 rounded-xl border border-rule bg-sheet px-3 py-2.5"
    >
      <span className="text-xs text-ink-2">{label}</span>
      <span className="truncate font-mono text-lg">{value}</span>
      <span className="truncate text-xs text-ink-2">{note}</span>
    </Link>
  );
}
