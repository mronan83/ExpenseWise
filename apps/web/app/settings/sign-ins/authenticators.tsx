'use client';

import {
  authenticatorOffer,
  MAX_AUTHENTICATORS,
  SECOND_FACTOR_CODE_LENGTH,
  showDate,
} from '@expensewise/domain';
import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { loadFeatures } from '../../../lib/features';
import { formText } from '../../../lib/form';
import {
  authenticators,
  cancelEnrolling,
  passCode,
  removeAuthenticator,
  SECOND_FACTOR_FLAG,
  SecondFactorError,
  startEnrolling,
  type Authenticator,
  type Enrollment,
} from '../../../lib/second-factor';
import { CodeField } from '../../second-factor';

type Load =
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'ready'; apps: Authenticator[]; switchedOn: boolean; owner: boolean };

type Message = { tone: 'ok' | 'warn'; text: string } | null;

const explain = (error: unknown) =>
  error instanceof SecondFactorError ? error.message : 'Something went wrong. Try again.';

/**
 * Authenticator apps (F-11): add one by its QR code or key and its first code, see each with
 * when it was added, and remove one. Through Supabase Auth's MFA API in the browser; nothing of
 * the organization's data goes that way (ADR-0013). Offered while the organization has the
 * second factor on, and to its owner before switching it on. `onAdded` runs once one is added
 * and its code is in, as for an email that needed its own (#88).
 */
export function Authenticators({ onAdded }: { onAdded?: () => void } = {}) {
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [adding, setAdding] = useState<(Enrollment & { name: string }) | null>(null);
  const [message, setMessage] = useState<Message>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [{ features, canSwitch }, apps] = await Promise.all([
        loadFeatures(true),
        authenticators(),
      ]);
      const switchedOn = features.some((f) => f.key === SECOND_FACTOR_FLAG && f.enabled);
      setLoad({ state: 'ready', apps, switchedOn, owner: canSwitch });
    } catch (error) {
      setLoad({ state: 'error', message: explain(error) });
    }
  }, []);

  useEffect(() => {
    // Reads the browser's session, so it can only start after mounting.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  async function run(action: () => Promise<string | null>) {
    setBusy(true);
    setMessage(null);
    try {
      const done = await action();
      if (done) setMessage({ tone: 'ok', text: done });
      await refresh();
    } catch (error) {
      setMessage({ tone: 'warn', text: explain(error) });
    } finally {
      setBusy(false);
    }
  }

  if (load.state === 'loading') return null;
  if (load.state === 'error') {
    return (
      <p role="alert" className="text-sm text-warn">
        {load.message}
      </p>
    );
  }
  const offer = authenticatorOffer({
    switchedOn: load.switchedOn,
    owner: load.owner,
    enrolled: load.apps.length,
  });
  if (!offer.shown) return null;

  const start = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = formText(new FormData(event.currentTarget), 'name').trim();
    void run(async () => {
      setAdding({ ...(await startEnrolling(name || 'Authenticator app')), name });
      return null;
    });
  };
  const finish = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!adding) return;
    const code = formText(new FormData(event.currentTarget), 'code');
    void run(async () => {
      await passCode(adding.factorId, code);
      setAdding(null);
      onAdded?.();
      return (
        `${adding.name || 'Your authenticator app'} is added. ` +
        (load.switchedOn
          ? 'Signing in now asks for its code. '
          : 'Switch the second factor on in Settings › Features when you’re ready. ') +
        'Anywhere else you were signed in has been signed out.'
      );
    });
  };
  const cancel = () => {
    if (!adding) return;
    const { factorId } = adding;
    setAdding(null);
    void run(async () => {
      await cancelEnrolling(factorId);
      return null;
    });
  };
  const remove = (app: Authenticator) =>
    void run(async () => {
      await removeAuthenticator(app.id);
      return `${app.name} is removed. Its codes no longer work.`;
    });

  return (
    <section
      aria-labelledby="authenticators-title"
      className="flex flex-col gap-3 rounded-xl border border-rule bg-sheet p-5"
    >
      <h2 id="authenticators-title" className="font-semibold">
        Authenticator apps
      </h2>
      <p className="text-sm text-ink-2">
        With an authenticator app, signing in asks for the {SECOND_FACTOR_CODE_LENGTH}-digit code it
        shows as well as your password, and so do changes to your organization&apos;s settings,
        people and keys
        {load.switchedOn ? '.' : ', once your organization switches the second factor on.'}
      </p>
      {offer.beforeSwitchingOn ? (
        <p className="text-sm">
          The second factor is off for your organization. Add your authenticator app here and enter
          its code first: switching it on in{' '}
          <Link href="/settings/features" className="font-semibold text-carbon underline">
            Settings › Features
          </Link>{' '}
          needs your own code, so no one is locked out.
        </p>
      ) : null}
      {load.apps.length > 0 ? (
        <ul className="flex flex-col divide-y divide-rule">
          {load.apps.map((app) => (
            <li key={app.id} className="flex items-center justify-between gap-3 py-2">
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-sm font-medium">{app.name}</span>
                <span className="text-xs text-ink-2">Added {showDate(app.addedAt)}</span>
              </span>
              <button
                type="button"
                onClick={() => remove(app)}
                disabled={busy}
                aria-label={`Remove ${app.name}`}
                className="rounded-lg border border-rule px-3 py-1.5 text-sm font-semibold disabled:opacity-60"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-ink-2">You haven&apos;t added one yet.</p>
      )}
      {offer.suggestAnother ? (
        <p className="text-sm text-ink-2">
          Add a second one too, on another phone or in a password manager, so losing this phone
          doesn&apos;t lock you out.
        </p>
      ) : null}
      {adding ? (
        <div className="flex flex-col gap-3">
          <p className="text-sm">
            Scan this with your authenticator app, or type the key into it. Then enter the code it
            shows.
          </p>
          {/* An SVG from Supabase Auth as a data URL; next/image adds nothing to it. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={adding.qrCode}
            alt="QR code that adds ExpenseWise to your authenticator app"
            width={180}
            height={180}
            className="size-44 rounded-lg bg-white p-2"
          />
          <p className="text-sm">
            Key: <code className="font-mono break-all">{adding.secret}</code>
          </p>
          <form onSubmit={finish} className="flex flex-col gap-3">
            <CodeField label="Code from the app" />
            <div className="flex flex-wrap gap-2">
              <button
                type="submit"
                disabled={busy}
                className="rounded-lg bg-carbon px-4 py-2 text-sm font-semibold text-carbon-ink disabled:opacity-60"
              >
                {busy ? 'Checking…' : 'Add it'}
              </button>
              <button
                type="button"
                onClick={cancel}
                disabled={busy}
                className="rounded-lg border border-rule px-4 py-2 text-sm font-semibold disabled:opacity-60"
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      ) : offer.canAdd ? (
        <form onSubmit={start} className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm font-medium">
            Name it
            <input
              name="name"
              maxLength={60}
              defaultValue={
                load.apps.length === 0 ? 'My phone' : `Authenticator ${load.apps.length + 1}`
              }
              className="rounded-lg border border-rule bg-paper px-3 py-2 text-base"
            />
          </label>
          <button
            type="submit"
            disabled={busy}
            className="rounded-lg bg-carbon px-4 py-2 text-sm font-semibold text-carbon-ink disabled:opacity-60"
          >
            {busy ? 'Working…' : 'Add an authenticator app'}
          </button>
        </form>
      ) : load.apps.length >= MAX_AUTHENTICATORS ? (
        <p className="text-sm text-ink-2">
          You have {MAX_AUTHENTICATORS}, as many as you can. Remove one to add another.
        </p>
      ) : null}
      <p
        role="status"
        className={`min-h-5 text-sm ${message?.tone === 'warn' ? 'text-warn' : 'text-ok'}`}
      >
        {message?.text}
      </p>
    </section>
  );
}
