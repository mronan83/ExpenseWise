'use client';

import { SECOND_FACTOR_CODE_LENGTH } from '@expensewise/domain';
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
import { onStepUp } from '../lib/step-up';

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

/**
 * The code, asked for in the middle of an admin action that needs it (FR-GOV-04). While it is
 * asked, it is the only thing on screen (globals.css); the page underneath keeps its place,
 * and the action carries on once the code is in. Cancelled, the page shows the refusal.
 */
export function StepUpPrompt() {
  const [asked, setAsked] = useState<Asked | null>(null);

  useEffect(() => {
    // Two actions refused at once share one prompt, and both carry on after the one code.
    let pending: Promise<boolean> | null = null;
    onStepUp(() => {
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

  if (!asked) return null;
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
        <span className="font-mono text-xs tracking-widest text-ink-2 uppercase">ExpenseWise</span>
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
                What you were doing needs the code from your authenticator app, such as a change to
                your organization&apos;s settings, people or keys. Enter the one showing now, and it
                carries on.
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

/** Screens that ask for the code themselves, or come before it. */
const BEFORE_THE_CODE = ['/sign-in'];

/**
 * Before anything else (FR-PLT-03): a session that signed in with a password alone, of someone
 * with an authenticator app, while their organization has the second factor on, goes to the
 * code screen first, from whatever screen it opened, and comes back after.
 */
export function SecondFactorGate() {
  const path = usePathname();
  const router = useRouter();
  useEffect(() => {
    if (BEFORE_THE_CODE.some((p) => path === p || path.startsWith(`${p}/`))) return;
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
