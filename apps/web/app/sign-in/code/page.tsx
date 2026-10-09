'use client';

import { afterSecondFactor, SECOND_FACTOR_CODE_LENGTH } from '@expensewise/domain';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { assuranceLevels, authenticators, type Authenticator } from '../../../lib/second-factor';
import { supabase } from '../../../lib/supabase';
import { CodeForm } from '../../second-factor';
import { Wordmark } from '../../brand';

type Load =
  | { state: 'loading' }
  | { state: 'signed-out' }
  | { state: 'error'; message: string }
  | { state: 'ready'; apps: Authenticator[] };

/** Where the code takes the person: the page that sent them here, on this site only. */
const next = () => afterSecondFactor(new URLSearchParams(window.location.search).get('next'));

/**
 * The second factor at sign-in (FR-PLT-03): after the password, before anything else, the code
 * from an authenticator app, on its own screen, with a way to sign out instead.
 */
export default function CodePage() {
  const router = useRouter();
  const [load, setLoad] = useState<Load>({ state: 'loading' });

  useEffect(() => {
    let live = true;
    void (async () => {
      const session = (await supabase()?.auth.getSession())?.data.session;
      if (!session) {
        if (live) setLoad({ state: 'signed-out' });
        return;
      }
      // Already past it, as after entering it in another tab: nothing to ask.
      if ((await assuranceLevels())?.current === 'aal2') {
        router.replace(next());
        return;
      }
      try {
        const apps = await authenticators();
        if (!live) return;
        if (apps.length === 0) router.replace(next());
        else setLoad({ state: 'ready', apps });
      } catch (error) {
        if (live) {
          setLoad({
            state: 'error',
            message: error instanceof Error ? error.message : 'Something went wrong.',
          });
        }
      }
    })();
    return () => {
      live = false;
    };
  }, [router]);

  async function signOut() {
    await supabase()?.auth.signOut();
    router.replace('/sign-in');
  }

  return (
    <div className="mx-auto flex w-full max-w-md flex-1 flex-col px-4 pt-[max(1rem,env(safe-area-inset-top))]">
      <header className="flex items-baseline justify-between py-3">
        <Wordmark />
        {load.state === 'ready' || load.state === 'error' ? (
          <button type="button" onClick={() => void signOut()} className="tap text-sm text-carbon">
            Sign out
          </button>
        ) : null}
      </header>
      <main className="flex flex-1 flex-col gap-4">
        <h1 className="text-2xl font-bold">Enter your code</h1>
        {load.state === 'loading' ? <p className="text-sm text-ink-2">Loading…</p> : null}
        {load.state === 'signed-out' ? (
          <p className="text-sm">
            <Link href="/sign-in" className="font-semibold text-carbon underline">
              Sign in
            </Link>{' '}
            first.
          </p>
        ) : null}
        {load.state === 'error' ? (
          <p role="alert" className="text-sm text-warn">
            {load.message}
          </p>
        ) : null}
        {load.state === 'ready' ? (
          <>
            <p className="text-sm text-ink-2">
              Your organization asks for a second factor. Open your authenticator app and enter the{' '}
              {SECOND_FACTOR_CODE_LENGTH}-digit code it shows for ExpenseWise.
            </p>
            <CodeForm apps={load.apps} onPassed={() => router.replace(next())} />
            <p className="text-sm text-ink-2">
              Lost your phone? Use another authenticator you added, or ask your organization’s owner
              to remove the lost one; then you sign in with your password and add a new one.
            </p>
          </>
        ) : null}
      </main>
    </div>
  );
}
