'use client';

import { LET_IN_HOURS, showDate, showDateTime } from '@expensewise/domain';
import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, ApiProblem } from '../../../lib/api';
import { formText } from '../../../lib/form';
import { OtherSignInError, supabase, withOtherSignIn } from '../../../lib/supabase';
import { SettingsNav } from '../nav';
import { Authenticators } from './authenticators';

interface SignIn {
  id: string;
  email: string;
  linkedAt: string;
  current: boolean;
  /** While the second factor is on (#90): whether it is let in, or waits for its own code. */
  letIn?: 'yes' | 'waiting' | 'no';
  letInLapsesAt?: string | null;
}

type Load =
  | { state: 'loading' }
  | { state: 'signed-out' }
  | { state: 'error'; message: string }
  | { state: 'ready'; signIns: SignIn[]; canLetIn: boolean }
  /** This email needs its own authenticator before anything else (#88). */
  | { state: 'held'; email: string | null };

type Message = { tone: 'ok' | 'warn'; text: string } | null;

/**
 * Whether the person lets emails in (#90): the second factor is on and one of theirs is let in,
 * as once they have an authenticator and pass its code.
 */
const lettingIn = (signIns: readonly SignIn[]) =>
  signIns.some((s) => s.letIn === 'yes' || s.letIn === 'waiting');

/** Whether an email is let in, in words. */
const letInState = (s: SignIn) => {
  if (s.letIn === 'yes') return 'Let in';
  if (s.letIn === 'waiting') {
    return s.letInLapsesAt
      ? `Let in until ${showDateTime(s.letInLapsesAt)}, to add its own authenticator app`
      : 'Let in, to add its own authenticator app';
  }
  return 'Not let in: receipts sent from it are still filed';
};

const describeError = (error: unknown) => {
  if (error instanceof OtherSignInError) {
    return 'That email and password did not work. Check them and try again.';
  }
  return error instanceof ApiProblem
    ? [error.message, error.detail].filter(Boolean).join('. ')
    : 'Something went wrong. Try again.';
};

/**
 * The emails one person signs in with (ADR-0016), each reaching the same receipts, and their
 * authenticator apps for the second factor (F-11). While the second factor is on and the person
 * has an authenticator, each email says whether it is let in, and from an email let in that
 * passed its code, the person lets another in or withdraws it (#90). An email that needs its own
 * authenticator (#88), let in and held from everything else, is told so here and adds one,
 * through Supabase Auth in the browser and the organization's switches, the only things it may
 * read; once its code is in, the rest opens. An email that isn't let in sees the screen that
 * says so instead, never adding one.
 */
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
      const { signIns, canLetIn } = await api<{ signIns: SignIn[]; canLetIn?: boolean }>(
        '/v1/me/sign-ins',
      );
      setLoad({ state: 'ready', signIns, canLetIn: canLetIn === true });
    } catch (error) {
      if (error instanceof ApiProblem && error.code === 'authenticator_required') {
        const named = error.extra.email;
        setLoad({
          state: 'held',
          email: typeof named === 'string' ? named : (session.user.email ?? null),
        });
        return;
      }
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

  const letIn = (signIn: SignIn) =>
    void run(async () => {
      await api(`/v1/me/sign-ins/${signIn.id}/let-in`, { method: 'PUT' });
      return (
        `${signIn.email} is let in for ${LET_IN_HOURS} hours. Sign in with it, add its own ` +
        'authenticator app in Settings › Sign-ins and enter its code; then it signs in.'
      );
    });

  const withdraw = (signIn: SignIn) =>
    void run(async () => {
      await api(`/v1/me/sign-ins/${signIn.id}/let-in`, { method: 'DELETE' });
      return `${signIn.email} is no longer let in. Receipts sent from it are still filed.`;
    });

  return (
    <div className="mx-auto flex w-full max-w-md flex-1 flex-col px-4 pt-[max(1rem,env(safe-area-inset-top))]">
      <header className="flex items-baseline justify-between py-3">
        <Link href="/" className="tap font-mono text-xs tracking-widest text-ink-2 uppercase">
          ExpenseWise
        </Link>
        {load.state === 'ready' || load.state === 'error' || load.state === 'held' ? (
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
        {load.state === 'held' ? (
          <section
            aria-labelledby="held-title"
            className="flex flex-col gap-3 rounded-xl border border-rule bg-sheet p-5"
          >
            <h2 id="held-title" className="font-semibold">
              This email needs its own authenticator
            </h2>
            <p className="text-sm">
              <span className="font-semibold break-all">
                {load.email ?? 'The email you signed in with'}
              </span>{' '}
              has no authenticator app of its own, and another email you sign in with has one. Your
              organization asks each of your emails for its own before anything else.
            </p>
            <p className="text-sm text-ink-2">
              Add one below and enter its code; then your sign-ins, receipts and everything else
              open as before.
            </p>
          </section>
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
              {lettingIn(load.signIns) ? (
                <p className="text-sm text-ink-2">
                  You have an authenticator app, so only the emails you let in open ExpenseWise; the
                  others still forward receipts. An email you let in has {LET_IN_HOURS} hours to add
                  its own authenticator app and enter its code.
                </p>
              ) : null}
              <ul className="flex flex-col divide-y divide-rule">
                {load.signIns.map((s) => (
                  <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 py-2">
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate text-sm font-medium">{s.email}</span>
                      <span className="text-xs text-ink-2">
                        {s.current ? 'The one you are using now' : `Linked ${showDate(s.linkedAt)}`}
                      </span>
                      {lettingIn(load.signIns) ? (
                        <span className="text-xs text-ink-2">{letInState(s)}</span>
                      ) : null}
                    </span>
                    {s.current ? null : (
                      <span className="flex flex-wrap gap-2">
                        {load.canLetIn ? (
                          <button
                            type="button"
                            onClick={() => (s.letIn === 'no' ? letIn(s) : withdraw(s))}
                            disabled={busy}
                            aria-label={`${s.letIn === 'no' ? 'Let in' : 'Withdraw'} ${s.email}`}
                            className="rounded-lg border border-rule px-3 py-1.5 text-sm font-semibold disabled:opacity-60"
                          >
                            {s.letIn === 'no' ? 'Let in' : 'Withdraw'}
                          </button>
                        ) : null}
                        <button
                          type="button"
                          onClick={() => remove(s)}
                          disabled={busy}
                          aria-label={`Remove ${s.email}`}
                          className="rounded-lg border border-rule px-3 py-1.5 text-sm font-semibold disabled:opacity-60"
                        >
                          Remove
                        </button>
                      </span>
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
        {/* In one place for both, so it keeps its message once a held email adds one (#88). */}
        {load.state === 'ready' || load.state === 'held' ? (
          <Authenticators onAdded={() => void refresh()} />
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
