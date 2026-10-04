'use client';

import { showDate } from '@expensewise/domain';
import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, ApiProblem } from '../../../lib/api';
import { formText } from '../../../lib/form';
import { OtherSignInError, supabase, withOtherSignIn } from '../../../lib/supabase';
import { SettingsNav } from '../nav';

interface SignIn {
  id: string;
  email: string;
  linkedAt: string;
  current: boolean;
}

type Load =
  | { state: 'loading' }
  | { state: 'signed-out' }
  | { state: 'error'; message: string }
  | { state: 'ready'; signIns: SignIn[] };

type Message = { tone: 'ok' | 'warn'; text: string } | null;

const describeError = (error: unknown) => {
  if (error instanceof OtherSignInError) {
    return 'That email and password did not work. Check them and try again.';
  }
  return error instanceof ApiProblem
    ? [error.message, error.detail].filter(Boolean).join('. ')
    : 'Something went wrong. Try again.';
};

/** The emails one person signs in with (ADR-0016). Each reaches the same receipts. */
export default function SignInsPage() {
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [message, setMessage] = useState<Message>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const session = (await supabase()?.auth.getSession())?.data.session;
    if (!session) {
      setLoad({ state: 'signed-out' });
      return;
    }
    try {
      await api('/v1/me/organization', { method: 'POST' });
      const { signIns } = await api<{ signIns: SignIn[] }>('/v1/me/sign-ins');
      setLoad({ state: 'ready', signIns });
    } catch (error) {
      setLoad({ state: 'error', message: describeError(error) });
    }
  }, []);

  useEffect(() => {
    // Loading reads the browser's session, so it can only start after mounting.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  async function run(action: () => Promise<string>) {
    setBusy(true);
    setMessage(null);
    try {
      setMessage({ tone: 'ok', text: await action() });
      await refresh();
    } catch (error) {
      setMessage({ tone: 'warn', text: describeError(error) });
    } finally {
      setBusy(false);
    }
  }

  const link = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const email = formText(data, 'email').trim();
    const password = formText(data, 'password');
    void run(async () => {
      await withOtherSignIn(email, password, (accessToken) =>
        api('/v1/me/sign-ins', { method: 'POST', body: JSON.stringify({ accessToken }) }),
      );
      form.reset();
      return `${email} now opens the same receipts and settings.`;
    });
  };

  async function signOut() {
    await supabase()?.auth.signOut();
    setLoad({ state: 'signed-out' });
    setMessage(null);
  }

  const remove = (signIn: SignIn) =>
    void run(async () => {
      await api(`/v1/me/sign-ins/${signIn.id}`, { method: 'DELETE' });
      return `${signIn.email} no longer opens this account.`;
    });

  return (
    <div className="mx-auto flex w-full max-w-md flex-1 flex-col px-4 pt-[max(1rem,env(safe-area-inset-top))]">
      <header className="flex items-baseline justify-between py-3">
        <Link href="/" className="tap font-mono text-xs tracking-widest text-ink-2 uppercase">
          ExpenseWise
        </Link>
        {load.state === 'ready' || load.state === 'error' ? (
          <button type="button" onClick={() => void signOut()} className="tap text-sm text-carbon">
            Sign out
          </button>
        ) : null}
      </header>
      <main className="flex flex-1 flex-col gap-4 pb-8">
        <SettingsNav current="/settings/sign-ins" />
        <h1 className="text-2xl font-bold">Sign-ins</h1>
        <p className="text-sm text-ink-2">
          If you sign in with more than one email, such as a personal and a work address, link them
          here. Each one opens the same receipts, expenses and settings, as the same person.
        </p>
        {load.state === 'loading' ? <p className="text-sm text-ink-2">Loading…</p> : null}
        {load.state === 'signed-out' ? (
          <p className="text-sm">
            <Link href="/sign-in" className="font-semibold text-carbon underline">
              Sign in
            </Link>{' '}
            to manage your sign-ins.
          </p>
        ) : null}
        {load.state === 'error' ? (
          <p role="alert" className="text-sm text-warn">
            {load.message}
          </p>
        ) : null}
        {load.state === 'ready' ? (
          <>
            <section
              aria-labelledby="sign-ins-title"
              className="flex flex-col gap-3 rounded-xl border border-rule bg-sheet p-5"
            >
              <h2 id="sign-ins-title" className="font-semibold">
                Your sign-ins
              </h2>
              <ul className="flex flex-col divide-y divide-rule">
                {load.signIns.map((s) => (
                  <li key={s.id} className="flex items-center justify-between gap-3 py-2">
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate text-sm font-medium">{s.email}</span>
                      <span className="text-xs text-ink-2">
                        {s.current ? 'The one you are using now' : `Linked ${showDate(s.linkedAt)}`}
                      </span>
                    </span>
                    {s.current ? null : (
                      <button
                        type="button"
                        onClick={() => remove(s)}
                        disabled={busy}
                        aria-label={`Remove ${s.email}`}
                        className="rounded-lg border border-rule px-3 py-1.5 text-sm font-semibold disabled:opacity-60"
                      >
                        Remove
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </section>
            <section
              aria-labelledby="link-title"
              className="flex flex-col gap-3 rounded-xl border border-rule bg-sheet p-5"
            >
              <h2 id="link-title" className="font-semibold">
                Add another email you use
              </h2>
              <p className="text-sm text-ink-2">
                Enter that account&apos;s email and password to show it&apos;s yours. You stay
                signed in as you are now.
              </p>
              <form onSubmit={link} className="flex flex-col gap-3">
                <label className="flex flex-col gap-1 text-sm font-medium">
                  Email
                  <input
                    name="email"
                    type="email"
                    autoComplete="off"
                    required
                    className="rounded-lg border border-rule bg-paper px-3 py-2 text-base"
                  />
                </label>
                <label className="flex flex-col gap-1 text-sm font-medium">
                  Password
                  <input
                    name="password"
                    type="password"
                    autoComplete="off"
                    required
                    className="rounded-lg border border-rule bg-paper px-3 py-2 text-base"
                  />
                </label>
                <button
                  type="submit"
                  disabled={busy}
                  className="rounded-lg bg-carbon px-4 py-2 text-sm font-semibold text-carbon-ink disabled:opacity-60"
                >
                  {busy ? 'Working…' : 'Link this email'}
                </button>
              </form>
            </section>
          </>
        ) : null}
        <p
          role="status"
          className={`min-h-5 text-sm ${message?.tone === 'warn' ? 'text-warn' : 'text-ok'}`}
        >
          {message?.text}
        </p>
      </main>
    </div>
  );
}
