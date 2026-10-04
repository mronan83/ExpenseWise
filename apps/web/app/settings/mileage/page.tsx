'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api } from '../../../lib/api';
import { supabase } from '../../../lib/supabase';
import { SettingsNav } from '../nav';
import { RateSection } from './rate-section';

type Load = { state: 'loading' } | { state: 'signed-out' } | { state: 'ready' };

/**
 * Settings › Mileage (Q28): what drives are paid at. Behind `expenses.mileage`; with it off,
 * the section says so and the settings menu leaves the page out.
 */
export default function MileageSettingsPage() {
  const [load, setLoad] = useState<Load>({ state: 'loading' });

  useEffect(() => {
    // The session is only known after mounting.
    void (async () => {
      const session = (await supabase()?.auth.getSession())?.data.session;
      if (!session) {
        setLoad({ state: 'signed-out' });
        return;
      }
      await api('/v1/me/organization', { method: 'POST' }).catch(() => undefined);
      setLoad({ state: 'ready' });
    })();
  }, []);

  return (
    <div className="mx-auto flex w-full max-w-md flex-1 flex-col px-4 pt-[max(1rem,env(safe-area-inset-top))]">
      <header className="flex items-baseline justify-between py-3">
        <Link href="/" className="tap font-mono text-xs tracking-widest text-ink-2 uppercase">
          ExpenseWise
        </Link>
      </header>
      <main className="flex flex-1 flex-col gap-4 pb-8">
        <SettingsNav current="/settings/mileage" />
        <h1 className="text-2xl font-bold">Mileage</h1>
        {load.state === 'loading' ? <p className="text-sm text-ink-2">Loading…</p> : null}
        {load.state === 'signed-out' ? (
          <p className="text-sm">
            <Link href="/sign-in" className="tap font-semibold text-carbon underline">
              Sign in
            </Link>{' '}
            to see what drives are paid at.
          </p>
        ) : null}
        {load.state === 'ready' ? <RateSection /> : null}
      </main>
    </div>
  );
}
