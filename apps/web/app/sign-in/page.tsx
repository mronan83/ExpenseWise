'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { formText } from '../../lib/form';
import { codeNeeded } from '../../lib/second-factor';
import { supabase } from '../../lib/supabase';
import { Wordmark } from '../brand';

/**
 * Where to go after signing in: an invite link that sent the person here (#29). Only a path
 * on this site, so a link can never send someone elsewhere.
 */
function returnTo(search: string): string | undefined {
  const next = new URLSearchParams(search).get('next');
  return next && /^\/invite\/[A-Za-z0-9_-]+$/.test(next) ? next : undefined;
}

/**
 * Email and password sign-in (D-15). Accounts are created in Supabase; sign-ups are off. Someone
 * with an authenticator app goes on to its code while their organization asks for it (F-11).
 */
export default function SignInPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const auth = supabase()?.auth;

  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!auth) return;
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError(null);
    const { error: failure } = await auth.signInWithPassword({
      email: formText(form, 'email'),
      password: formText(form, 'password'),
    });
    if (failure) {
      setBusy(false);
      setError(failure.message);
      return;
    }
    const next = returnTo(window.location.search) ?? '/settings/ai';
    // The code, on its own screen, before anything else (FR-PLT-03).
    const needed = await codeNeeded(true);
    setBusy(false);
    router.push(needed ? `/sign-in/code?next=${encodeURIComponent(next)}` : next);
  }

  return (
    <div className="mx-auto flex w-full max-w-md flex-1 flex-col px-4 pt-[max(1rem,env(safe-area-inset-top))]">
      <header className="flex items-baseline justify-between py-3">
        <Link href="/" className="tap">
          <Wordmark />
        </Link>
      </header>
      <main className="flex flex-1 flex-col gap-4">
        <h1 className="text-2xl font-bold">Sign in</h1>
        {auth ? (
          <form onSubmit={(e) => void signIn(e)} className="flex flex-col gap-3">
            <label className="flex flex-col gap-1 text-sm font-medium">
              Email
              <input
                name="email"
                type="email"
                autoComplete="email"
                required
                className="rounded-lg border border-rule bg-sheet px-3 py-2 text-base"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm font-medium">
              Password
              <input
                name="password"
                type="password"
                autoComplete="current-password"
                required
                className="rounded-lg border border-rule bg-sheet px-3 py-2 text-base"
              />
            </label>
            <button
              type="submit"
              disabled={busy}
              className="mt-2 rounded-lg bg-carbon px-4 py-2 font-semibold text-carbon-ink disabled:opacity-60"
            >
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
            <p role="alert" className="min-h-5 text-sm text-warn">
              {error}
            </p>
          </form>
        ) : (
          <p className="text-sm text-ink-2">Sign-in isn&apos;t configured on this deployment.</p>
        )}
      </main>
    </div>
  );
}
