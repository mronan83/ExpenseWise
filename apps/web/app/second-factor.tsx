'use client';

import { LET_IN_HOURS, SECOND_FACTOR_CODE_LENGTH } from '@expensewise/domain';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { formText } from '../lib/form';
import {
  authenticators,
  codeNeeded,
  passCode,
  SecondFactorError,
  type Authenticator,
} from '../lib/second-factor';
import { onAuthenticatorRequired, onNotLetIn, onStepUp } from '../lib/step-up';
import { supabase } from '../lib/supabase';
import { Wordmark } from './brand';

const explain = (error: unknown) =>
  error instanceof SecondFactorError ? error.message : 'Something went wrong. Try again.';

/** The 6-digit code field, as authenticator apps and the phone's keyboard expect it. */
export function CodeField({ label = 'Code' }: { label?: string }) {
  return (
    <label className="flex flex-col gap-1 text-sm font-medium">
      {label}
      <input
        name="code"
        inputMode="numeric"
        autoComplete="one-time-code"
        required
        // Room for the space some apps show in the middle.
        maxLength={SECOND_FACTOR_CODE_LENGTH + 1}
        className="rounded-lg border border-rule bg-paper px-3 py-2 font-mono text-base tracking-widest"
      />
    </label>
  );
}

/**
 * Asks for the code from one of the person's authenticator apps, choosing which when they have
 * several, and checks it with Supabase Auth. `onPassed` runs once the session passed it (aal2).
 */
export function CodeForm({
  apps,
  onPassed,
  children,
}: {
  apps: readonly Authenticator[];
  onPassed: () => void;
  /** Buttons beside Continue, such as Cancel. */
  children?: ReactNode;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError(null);
    try {
      await passCode(formText(form, 'factor') || apps[0]!.id, formText(form, 'code'));
      onPassed();
    } catch (failure) {
      setError(explain(failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3">
      {apps.length > 1 ? (
        <label className="flex flex-col gap-1 text-sm font-medium">
          Which authenticator app
          <select
            name="factor"
            className="rounded-lg border border-rule bg-paper px-3 py-2 text-base"
            defaultValue={apps[0]!.id}
          >
            {apps.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <CodeField />
      <div className="flex flex-wrap gap-2">
        <button
          type="submit"
          disabled={busy}
          className="rounded-lg bg-carbon px-4 py-2 text-sm font-semibold text-carbon-ink disabled:opacity-60"
        >
          {busy ? 'Checking…' : 'Continue'}
        </button>
        {children}
      </div>
      <p role="alert" className="min-h-5 text-sm text-warn">
        {error}
      </p>
    </form>
  );
}

type Asked = { resolve: (passed: boolean) => void; apps: Authenticator[] | null };

/** Screens that ask for the code themselves, or come before it. */
const BEFORE_THE_CODE = ['/sign-in'];
const beforeTheCode = (path: string) =>
  BEFORE_THE_CODE.some((p) => path === p || path.startsWith(`${p}/`));

/**
 * The code, asked for in the middle of what needs it: an admin action (FR-GOV-04), or, for
 * someone with an authenticator whose organization asks it before anything else, any read or
 * change their session makes before passing it (#85). While it is asked, it is the only thing
 * on screen (globals.css); the page underneath keeps its place, and what it was doing carries
 * on once the code is in. Cancelled, the page shows the refusal.
 */
export function StepUpPrompt() {
  const path = usePathname();
  const [asked, setAsked] = useState<Asked | null>(null);

  useEffect(() => {
    // Two requests refused at once share one prompt, and both carry on after the one code.
    let pending: Promise<boolean> | null = null;
    onStepUp(() => {
      // The code screen asks for it itself: never a second prompt over it.
      if (beforeTheCode(window.location.pathname)) return Promise.resolve(false);
      pending ??= new Promise<boolean>((resolve) => {
        const done = (passed: boolean) => {
          pending = null;
          resolve(passed);
        };
        setAsked({ resolve: done, apps: null });
        void authenticators()
          .catch(() => [])
          .then((apps) => setAsked((a) => (a && a.resolve === done ? { ...a, apps } : a)));
      });
      return pending;
    });
    return () => onStepUp(null);
  }, []);

  // A page's reads refused as it opened can ask just before the check in front of everything
  // sends the session on to the code screen: the prompt gives way to it, so the code is asked
  // once, there.
  const onCodeScreen = beforeTheCode(path);
  useEffect(() => {
    if (!onCodeScreen || !asked) return;
    asked.resolve(false);
    // The route changed under an open prompt: a reaction to the router, not derivable state.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAsked(null);
  }, [onCodeScreen, asked]);

  if (!asked || onCodeScreen) return null;
  const finish = (passed: boolean) => {
    asked.resolve(passed);
    setAsked(null);
  };
  const cancel = (
    <button
      type="button"
      onClick={() => finish(false)}
      className="rounded-lg border border-rule px-4 py-2 text-sm font-semibold"
    >
      Cancel
    </button>
  );

  return (
    <div
      data-step-up
      className="mx-auto flex w-full max-w-md flex-1 flex-col px-4 pt-[max(1rem,env(safe-area-inset-top))]"
    >
      <header className="py-3">
        <Wordmark />
      </header>
      <main className="flex flex-1 flex-col gap-4 pb-8">
        <h1 className="text-2xl font-bold">Enter your code to continue</h1>
        <section
          aria-labelledby="step-up-title"
          className="flex flex-col gap-3 rounded-xl border border-rule bg-sheet p-5"
        >
          <h2 id="step-up-title" className="font-semibold">
            This needs your second factor
          </h2>
          {asked.apps === null ? <p className="text-sm text-ink-2">Loading…</p> : null}
          {asked.apps && asked.apps.length > 0 ? (
            <>
              <p className="text-sm text-ink-2">
                What you were doing needs the code from your authenticator app: your organization
                asks for it before anything else, or before a change to its settings, people or
                keys. Enter the one showing now, and it carries on.
              </p>
              <CodeForm apps={asked.apps} onPassed={() => finish(true)}>
                {cancel}
              </CodeForm>
            </>
          ) : null}
          {asked.apps && asked.apps.length === 0 ? (
            <>
              <p className="text-sm text-ink-2">
                You haven&apos;t added an authenticator app yet. Add one in{' '}
                <Link
                  href="/settings/sign-ins"
                  onClick={() => finish(false)}
                  className="font-semibold text-carbon underline"
                >
                  Settings › Sign-ins
                </Link>
                , enter its code, then try again.
              </p>
              <div>{cancel}</div>
            </>
          ) : null}
        </section>
      </main>
    </div>
  );
}

/** Where an email that needs its own authenticator adds one, and says so itself (#88). */
const ADD_AN_AUTHENTICATOR = '/settings/sign-ins';

/**
 * An email that needs its own authenticator (#88, Q43): a person with an authenticator on
 * another email they sign in with, signed in with one that has none, while their organization
 * has the second factor on. The API refuses its every read, and there is no code to enter yet,
 * so this says so in plain words, naming the email, and sends them to Settings › Sign-ins,
 * where adding one works; never the code prompt. While none of the person's emails is let in, it
 * is the one they first signed in with, the only one let in on its own (#91, Q45): it says so,
 * and that the email with the authenticator waits to be let in from this one. Like the prompt it
 * is the only thing on screen (globals.css). It belongs to the screen whose reads were refused:
 * moving on clears it, and the next screen's refused reads bring it back. Settings › Sign-ins
 * and the sign-in screens never show it.
 */
export function AuthenticatorRequiredScreen() {
  const path = usePathname();
  const router = useRouter();
  const [held, setHeld] = useState<{ email: string | null; noneLetIn: boolean } | null>(null);
  const [heldOn, setHeldOn] = useState(path);

  useEffect(() => {
    onAuthenticatorRequired((email, noneLetIn) => setHeld({ email, noneLetIn }));
    return () => onAuthenticatorRequired(null);
  }, []);

  // Another screen: whatever it reads says afresh whether this email is still held.
  if (heldOn !== path) {
    setHeldOn(path);
    setHeld(null);
  }

  if (!held || path === ADD_AN_AUTHENTICATOR || beforeTheCode(path)) return null;

  async function signOut() {
    await supabase()?.auth.signOut();
    setHeld(null);
    router.replace('/sign-in');
  }

  return (
    <div
      data-step-up
      className="mx-auto flex w-full max-w-md flex-1 flex-col px-4 pt-[max(1rem,env(safe-area-inset-top))]"
    >
      <header className="flex items-baseline justify-between py-3">
        <Wordmark />
        <button type="button" onClick={() => void signOut()} className="tap text-sm text-carbon">
          Sign out
        </button>
      </header>
      <main className="flex flex-1 flex-col gap-4 pb-8">
        <h1 className="text-2xl font-bold">This email needs its own authenticator</h1>
        <section
          aria-labelledby="held-email-title"
          className="flex flex-col gap-3 rounded-xl border border-rule bg-sheet p-5"
        >
          <h2 id="held-email-title" className="font-semibold break-all">
            {held.email ?? 'The email you signed in with'}
          </h2>
          <p className="text-sm text-ink-2">
            Another email you sign in with has an authenticator app, and your organization asks each
            of your emails for its own before anything else. This one hasn&apos;t got one yet, so
            there is no code to enter.
          </p>
          {held.noneLetIn ? (
            <p className="text-sm text-ink-2">
              This is the email you first signed in with, the one let in first. Add an authenticator
              app to it and enter its code; then everything opens as before, and you let your other
              emails in from Settings › Sign-ins here.
            </p>
          ) : (
            <p className="text-sm text-ink-2">
              Add an authenticator app to this email and enter its code; then everything opens as
              before. Or sign out, and sign in with the email that has yours.
            </p>
          )}
          <div>
            <Link
              href={ADD_AN_AUTHENTICATOR}
              className="inline-block rounded-lg bg-carbon px-4 py-2 text-sm font-semibold text-carbon-ink"
            >
              Add one in Settings › Sign-ins
            </Link>
          </div>
        </section>
      </main>
    </div>
  );
}

/**
 * An email that isn't let in (#90, Q44): once a person has an authenticator, only the emails they
 * let in open ExpenseWise while their organization has the second factor on; the others still
 * forward receipts. The API refuses this email's every read, so this says so in plain words,
 * naming it: that receipts sent from it are still filed, and how to let it in, from the email
 * that has the code; or, while none of the person's emails is let in, from the email they first
 * signed in with, the only one let in on its own, even if this one has an authenticator and
 * passed its code (#91, Q45). It offers signing out and nothing else: never the code prompt, and
 * never adding an authenticator, which only an email let in may do. Like the prompt it is the
 * only thing on screen (globals.css), Settings › Sign-ins included. It belongs to the screen
 * whose reads were refused: moving on clears it, and the next screen's refused reads bring it
 * back. The sign-in screens never show it.
 */
export function NotLetInScreen() {
  const path = usePathname();
  const router = useRouter();
  const [refused, setRefused] = useState<{ email: string | null; noneLetIn: boolean } | null>(null);
  const [refusedOn, setRefusedOn] = useState(path);

  useEffect(() => {
    onNotLetIn((email, noneLetIn) => setRefused({ email, noneLetIn }));
    return () => onNotLetIn(null);
  }, []);

  // Another screen: whatever it reads says afresh whether this email is still refused.
  if (refusedOn !== path) {
    setRefusedOn(path);
    setRefused(null);
  }

  if (!refused || beforeTheCode(path)) return null;

  async function signOut() {
    await supabase()?.auth.signOut();
    setRefused(null);
    router.replace('/sign-in');
  }

  return (
    <div
      data-step-up
      className="mx-auto flex w-full max-w-md flex-1 flex-col px-4 pt-[max(1rem,env(safe-area-inset-top))]"
    >
      <header className="py-3">
        <Wordmark />
      </header>
      <main className="flex flex-1 flex-col gap-4 pb-8">
        <h1 className="text-2xl font-bold">This email isn’t let in to sign in</h1>
        <section
          aria-labelledby="not-let-in-title"
          className="flex flex-col gap-3 rounded-xl border border-rule bg-sheet p-5"
        >
          <h2 id="not-let-in-title" className="font-semibold break-all">
            {refused.email ?? 'The email you signed in with'}
          </h2>
          {refused.noneLetIn ? (
            <>
              <p className="text-sm text-ink-2">
                An email you sign in with has an authenticator app, and your organization asks for
                it before anything else, so only the emails you let in open ExpenseWise. None is let
                in yet, and only the email you first signed in with is let in on its own; this
                isn&apos;t it, even with an authenticator app of its own.
              </p>
              <p className="text-sm">Receipts you send from this email are still filed.</p>
              <p className="text-sm text-ink-2">
                To let it in, sign in with the email you first signed in with, add an authenticator
                app to it if it has none, and enter its code. In Settings › Sign-ins there, choose
                Let in beside this email. Then sign in with this one again within {LET_IN_HOURS}{' '}
                hours, add an authenticator app to it if it has none, and enter its code.
              </p>
              <p className="text-sm text-ink-2">
                If you can no longer sign in with the email you first signed in with, or never added
                an authenticator app to any of your emails, tell your organization&apos;s owner.
              </p>
            </>
          ) : (
            <>
              <p className="text-sm text-ink-2">
                An email you sign in with has an authenticator app, and your organization asks for
                it before anything else, so only the emails you let in open ExpenseWise. This one
                isn&apos;t let in.
              </p>
              <p className="text-sm">Receipts you send from this email are still filed.</p>
              <p className="text-sm text-ink-2">
                To let it in, sign in with the email that has your authenticator app and enter its
                code. In Settings › Sign-ins there, choose Let in beside this email. Then sign in
                with this one again within {LET_IN_HOURS} hours, add an authenticator app to it, and
                enter its code.
              </p>
              <p className="text-sm text-ink-2">
                If you never added an authenticator app to another of your emails, someone else may
                have: tell your organization&apos;s owner.
              </p>
            </>
          )}
          <div>
            <button
              type="button"
              onClick={() => void signOut()}
              className="rounded-lg bg-carbon px-4 py-2 text-sm font-semibold text-carbon-ink"
            >
              Sign out
            </button>
          </div>
        </section>
      </main>
    </div>
  );
}

/**
 * Before anything else (FR-PLT-03): a session that signed in with a password alone, of someone
 * with an authenticator app, while their organization has the second factor on, goes to the
 * code screen first, from whatever screen it opened, and comes back after.
 */
export function SecondFactorGate() {
  const path = usePathname();
  const router = useRouter();
  useEffect(() => {
    if (beforeTheCode(path)) return;
    let live = true;
    void codeNeeded().then((needed) => {
      if (!live || !needed) return;
      const next = `${path}${window.location.search}`;
      router.replace(`/sign-in/code?next=${encodeURIComponent(next)}`);
    });
    return () => {
      live = false;
    };
  }, [path, router]);
  return null;
}
