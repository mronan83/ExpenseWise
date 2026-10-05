'use client';

import { showDate } from '@expensewise/domain';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { api, ApiProblem } from '../../../lib/api';
import { loadFeatures, type Feature, type FeatureList } from '../../../lib/features';
import { SECOND_FACTOR_FLAG } from '../../../lib/second-factor';
import { supabase } from '../../../lib/supabase';
import { SettingsNav } from '../nav';

type Load =
  | { state: 'loading' }
  | { state: 'signed-out' }
  | { state: 'error'; message: string }
  | ({ state: 'ready' } & FeatureList);

type Message = { tone: 'ok' | 'warn'; text: string } | null;

const describeError = (error: unknown) =>
  error instanceof ApiProblem
    ? [error.message, error.detail].filter(Boolean).join('. ')
    : 'Something went wrong. Try again.';

function stateText(f: Feature): string {
  if (f.source === 'override') return `${f.enabled ? 'On' : 'Off'} for everyone, set on the server`;
  if (f.source === 'organization' && f.switchedAt) {
    return `${f.enabled ? 'On' : 'Off'} since ${showDate(f.switchedAt)}`;
  }
  return 'Off: not switched on yet';
}

/**
 * New features ship switched off (Q5). The owner switches each one on here, once they have
 * checked it on their phone, and off again at once if it misbehaves. No release is needed.
 */
export default function FeaturesPage() {
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [message, setMessage] = useState<Message>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async (fresh = false) => {
    const session = (await supabase()?.auth.getSession())?.data.session;
    if (!session) {
      setLoad({ state: 'signed-out' });
      return;
    }
    try {
      await api('/v1/me/organization', { method: 'POST' });
      // Read directly, so a failure shows here rather than as every feature off.
      const list = await api<FeatureList>('/v1/features');
      if (fresh) void loadFeatures(true);
      setLoad({ state: 'ready', ...list });
    } catch (error) {
      setLoad({ state: 'error', message: describeError(error) });
    }
  }, []);

  useEffect(() => {
    // Loading reads the browser's session, so it can only start after mounting.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  async function toggle(f: Feature) {
    setBusy(f.key);
    setMessage(null);
    try {
      await api(`/v1/settings/features/${f.key}`, {
        method: 'PUT',
        body: JSON.stringify({ enabled: !f.enabled }),
      });
      setMessage({
        tone: 'ok',
        text: `${f.name} is ${f.enabled ? 'off' : 'on'} for everyone in your organization.`,
      });
      await refresh(true);
    } catch (error) {
      setMessage({ tone: 'warn', text: describeError(error) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-md flex-1 flex-col px-4 pt-[max(1rem,env(safe-area-inset-top))]">
      <header className="flex items-baseline justify-between py-3">
        <Link href="/" className="tap font-mono text-xs tracking-widest text-ink-2 uppercase">
          ExpenseWise
        </Link>
      </header>
      <main className="flex flex-1 flex-col gap-4 pb-8">
        <SettingsNav current="/settings/features" />
        <h1 className="text-2xl font-bold">Features</h1>
        <p className="text-sm text-ink-2">
          New features arrive switched off. Try one on your phone, then switch it on for everyone in
          your organization. Switching it off hides it again at once.
        </p>
        {load.state === 'loading' ? <p className="text-sm text-ink-2">Loading…</p> : null}
        {load.state === 'signed-out' ? (
          <p className="text-sm">
            <Link href="/sign-in" className="tap font-semibold text-carbon underline">
              Sign in
            </Link>{' '}
            to see your features.
          </p>
        ) : null}
        {load.state === 'error' ? (
          <p role="alert" className="text-sm text-warn">
            {load.message}
          </p>
        ) : null}
        {load.state === 'ready' ? (
          <section
            aria-labelledby="features-title"
            className="flex flex-col gap-3 rounded-xl border border-rule bg-sheet p-5"
          >
            <h2 id="features-title" className="font-semibold">
              {load.canSwitch ? 'Switch features on or off' : 'Features in your organization'}
            </h2>
            {load.canSwitch ? null : (
              <p className="text-sm text-ink-2">
                Only your organization&apos;s owner can switch them.
              </p>
            )}
            <ul className="flex flex-col divide-y divide-rule">
              {load.features.map((f) => (
                <li key={f.key} className="flex items-start justify-between gap-3 py-3">
                  <span className="flex min-w-0 flex-col gap-1">
                    <span className="text-sm font-medium">{f.name}</span>
                    <span className="text-xs text-ink-2">{f.description}</span>
                    <span className="text-xs font-medium">{stateText(f)}</span>
                    {f.key === SECOND_FACTOR_FLAG &&
                    load.canSwitch &&
                    !f.enabled &&
                    f.source !== 'override' ? (
                      <span className="text-xs text-ink-2">
                        Switching it on needs your own code first, so no one is locked out: add an
                        authenticator app in{' '}
                        <Link
                          href="/settings/sign-ins"
                          className="font-semibold text-carbon underline"
                        >
                          Settings › Sign-ins
                        </Link>{' '}
                        and enter its code, then switch it on here.
                      </span>
                    ) : null}
                  </span>
                  {load.canSwitch && f.source !== 'override' ? (
                    <button
                      type="button"
                      role="switch"
                      aria-checked={f.enabled}
                      aria-label={f.name}
                      onClick={() => void toggle(f)}
                      disabled={busy !== null}
                      className={`shrink-0 rounded-lg px-3 py-1.5 text-sm font-semibold disabled:opacity-60 ${
                        f.enabled ? 'bg-carbon text-carbon-ink' : 'border border-rule'
                      }`}
                    >
                      {busy === f.key ? 'Working…' : f.enabled ? 'On' : 'Off'}
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
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
