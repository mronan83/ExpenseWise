'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api } from '../../../lib/api';
import { loadFeatures } from '../../../lib/features';
import { MILEAGE_FLAG, type MileageEntry } from '../../../lib/mileage';
import { ROUTE_MILEAGE_FLAG, type RouteDrive } from '../../../lib/route-mileage';
import { supabase } from '../../../lib/supabase';
import { localToday } from '../../../lib/trips';
import { MileageForm } from '../mileage-form';
import { RouteForm } from '../route-form';

type Load =
  | { state: 'loading' }
  | { state: 'signed-out' }
  | { state: 'off' }
  | { state: 'ready'; routes: boolean };

/**
 * Add mileage (FR-CAP-03): a drive becomes an expense of miles × the rate in force on its date,
 * with that rate copied onto it (ADR-0038). Behind its flag: off, the page says so.
 */
export default function NewMileagePage() {
  const router = useRouter();
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [today, setToday] = useState('');
  // By miles typed in, or by a route measured (FR-CAP-04), while route mileage is on.
  const [by, setBy] = useState<'miles' | 'route'>('miles');

  useEffect(() => {
    // The session, the switches and the person's own date are only known after mounting.
    void (async () => {
      const session = (await supabase()?.auth.getSession())?.data.session;
      if (!session) {
        setLoad({ state: 'signed-out' });
        return;
      }
      const { features } = await loadFeatures();
      const on = (key: string) => features.some((f) => f.key === key && f.enabled);
      setToday(localToday());
      setLoad(
        on(MILEAGE_FLAG) ? { state: 'ready', routes: on(ROUTE_MILEAGE_FLAG) } : { state: 'off' },
      );
    })();
  }, []);

  return (
    <div className="mx-auto flex w-full max-w-md flex-1 flex-col px-4 pt-[max(1rem,env(safe-area-inset-top))]">
      <header className="flex items-baseline justify-between py-3">
        <Link href="/expenses" className="tap text-sm font-semibold text-carbon">
          ← Expenses
        </Link>
      </header>
      <main className="flex flex-1 flex-col gap-4 pb-8">
        <h1 className="text-2xl font-bold">Add mileage</h1>
        {load.state === 'loading' ? <p className="text-sm text-ink-2">Loading…</p> : null}
        {load.state === 'signed-out' ? (
          <p className="text-sm">
            <Link href="/sign-in" className="font-semibold text-carbon underline">
              Sign in
            </Link>{' '}
            to add mileage.
          </p>
        ) : null}
        {load.state === 'off' ? (
          <p className="text-sm">
            Mileage is switched off for your organization. Its owner can switch it on in{' '}
            <Link href="/settings/features" className="font-semibold text-carbon underline">
              Settings › Features
            </Link>
            .
          </p>
        ) : null}
        {load.state === 'ready' ? (
          <section
            aria-label="The drive"
            className="flex flex-col gap-3 rounded-xl border border-rule bg-sheet p-4 text-sm"
          >
            <p className="text-ink-2">
              A business drive, paid at the rate in force on its date. It files to your trip on that
              day, like any expense.
            </p>
            {load.routes ? (
              <div role="group" aria-label="How far it was" className="flex flex-wrap gap-2">
                {(
                  [
                    ['miles', 'By miles'],
                    ['route', 'By route'],
                  ] as const
                ).map(([value, text]) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={by === value}
                    onClick={() => setBy(value)}
                    className={`tap rounded-lg border px-3 py-1.5 text-sm font-semibold ${
                      by === value ? 'border-carbon bg-carbon text-carbon-ink' : 'border-rule'
                    }`}
                  >
                    {text}
                  </button>
                ))}
              </div>
            ) : null}
            {load.routes && by === 'route' ? (
              <>
                <p className="text-ink-2">
                  Its start, stops and end are measured by car with OpenRouteService, and it is paid
                  for the miles measured, which you can change with a reason.
                </p>
                <RouteForm
                  initial={{ date: today, purpose: '', stops: ['', ''], roundTrip: false }}
                  submitLabel="Add the drive"
                  busyLabel="Adding…"
                  onSubmit={async (draft) => {
                    const drive = await api<RouteDrive>('/v1/mileage/routes', {
                      method: 'POST',
                      body: JSON.stringify(draft),
                    });
                    router.push(`/expenses/${drive.id}`);
                  }}
                />
              </>
            ) : (
              <MileageForm
                initial={{ date: today, destination: '', purpose: '', miles: '' }}
                submitLabel="Add the drive"
                busyLabel="Adding…"
                onSubmit={async (draft) => {
                  const entry = await api<MileageEntry>('/v1/mileage', {
                    method: 'POST',
                    body: JSON.stringify(draft),
                  });
                  router.push(`/expenses/${entry.id}`);
                }}
              />
            )}
          </section>
        ) : null}
      </main>
    </div>
  );
}
