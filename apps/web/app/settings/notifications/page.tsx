'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { api, ApiProblem } from '../../../lib/api';
import {
  allowOnThisDevice,
  pushAvailability,
  renewThisDevice,
  stopOnThisDevice,
  type NotificationKindSetting,
  type NotificationSettings,
} from '../../../lib/push';
import { supabase } from '../../../lib/supabase';
import { Wordmark } from '../../brand';
import { RefreshButton } from '../../refresh';
import { SettingsNav } from '../nav';

/** Whether this device gets notifications, or why it can't yet. */
type Device =
  'add_to_home_screen' | 'unsupported' | 'no_server' | 'denied' | 'off' | 'on' | 'checking';

type Load =
  | { state: 'loading' }
  | { state: 'signed-out' }
  | { state: 'error'; message: string }
  | ({ state: 'ready' } & NotificationSettings);

type Message = { tone: 'ok' | 'warn'; text: string } | null;

const describeError = (error: unknown) =>
  error instanceof ApiProblem
    ? [error.message, error.detail].filter(Boolean).join('. ')
    : 'Something went wrong. Try again.';

const DEVICE_TEXT: Record<Exclude<Device, 'off' | 'on' | 'checking'>, string> = {
  add_to_home_screen:
    'On an iPhone, notifications come to ExpenseWise on your Home Screen. In Safari, tap Share, then Add to Home Screen, and open ExpenseWise from there.',
  unsupported: 'This browser can’t get notifications.',
  no_server: 'Notifications can’t be sent from this server yet.',
  denied:
    'Notifications are turned off for ExpenseWise on this device. Turn them on in your iPhone’s Settings › Notifications › ExpenseWise, then come back here.',
};

/**
 * Notifications on your phone (FR-PLT-12, ADR-0053): allow them on this device, switch each
 * kind, and send yourself a test. A notification says what and where, never an amount (Q58).
 */
export default function NotificationsPage() {
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [device, setDevice] = useState<Device>('checking');
  const [message, setMessage] = useState<Message>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const session = (await supabase()?.auth.getSession())?.data.session;
    if (!session) {
      setLoad({ state: 'signed-out' });
      return;
    }
    try {
      await api('/v1/me/organization', { method: 'POST' });
      const found = await api<NotificationSettings>('/v1/me/notifications');
      setLoad({ state: 'ready', ...found });
      const available = pushAvailability();
      if (available !== 'ready') return setDevice(available);
      if (!found.publicKey) return setDevice('no_server');
      if (Notification.permission === 'denied') return setDevice('denied');
      // A device whose renewal fails is offered allowing again, which renews it too.
      const renewed = await renewThisDevice(found.publicKey).catch(() => null);
      setDevice(renewed ? 'on' : 'off');
    } catch (error) {
      setLoad({ state: 'error', message: describeError(error) });
    }
  }, []);

  useEffect(() => {
    // Loading reads the browser's session, so it can only start after mounting.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  const ready = load.state === 'ready' ? load : null;

  async function run(what: string, work: () => Promise<void>) {
    setBusy(what);
    setMessage(null);
    try {
      await work();
    } catch (error) {
      setMessage({ tone: 'warn', text: describeError(error) });
    } finally {
      setBusy(null);
    }
  }

  const reload = async () => {
    const found = await api<NotificationSettings>('/v1/me/notifications');
    setLoad({ state: 'ready', ...found });
  };

  const allow = () =>
    run('allow', async () => {
      if (!ready?.publicKey) return;
      if ((await allowOnThisDevice(ready.publicKey)) === 'denied') {
        setDevice('denied');
        return;
      }
      setDevice('on');
      await reload();
      setMessage({ tone: 'ok', text: 'This device gets your notifications now.' });
    });

  const test = () =>
    run('test', async () => {
      await api('/v1/me/notifications/test', { method: 'POST' });
      setMessage({
        tone: 'ok',
        text: 'A test notification is on its way. It takes a few seconds.',
      });
    });

  const stop = () =>
    run('stop', async () => {
      await stopOnThisDevice();
      setDevice('off');
      await reload();
      setMessage({ tone: 'ok', text: 'This device gets no more notifications.' });
    });

  const toggle = (kind: NotificationKindSetting) =>
    run(kind.kind, async () => {
      const saved = await api<NotificationSettings>(`/v1/me/notifications/${kind.kind}`, {
        method: 'PUT',
        body: JSON.stringify({ on: !kind.on }),
      });
      setLoad({ state: 'ready', ...saved });
      setMessage({ tone: 'ok', text: `${kind.label}: ${kind.on ? 'off' : 'on'}.` });
    });

  return (
    <div className="mx-auto flex w-full max-w-md flex-1 flex-col px-4 pt-[max(1rem,env(safe-area-inset-top))]">
      <header className="flex items-baseline justify-between py-3">
        <Link href="/" className="tap">
          <Wordmark />
        </Link>
        <RefreshButton />
      </header>
      <main className="flex flex-1 flex-col gap-4 pb-8">
        <SettingsNav current="/settings/notifications" />
        <h1 className="text-2xl font-bold">Notifications</h1>
        <p className="text-sm text-ink-2">
          Hear on your phone when a receipt you emailed is filed, something needs a look, or a
          report needs you. Each says what and where, never an amount, and opens what it is about.
        </p>
        {load.state === 'loading' ? <p className="text-sm text-ink-2">Loading…</p> : null}
        {load.state === 'signed-out' ? (
          <p className="text-sm">
            <Link href="/sign-in" className="tap font-semibold text-carbon underline">
              Sign in
            </Link>{' '}
            to set your notifications.
          </p>
        ) : null}
        {load.state === 'error' ? (
          <p role="alert" className="text-sm text-warn">
            {load.message}
          </p>
        ) : null}
        {ready ? (
          <>
            <section
              aria-labelledby="device-title"
              className="flex flex-col gap-3 rounded-xl border border-rule bg-sheet p-5"
            >
              <h2 id="device-title" className="font-semibold">
                This device
              </h2>
              {device === 'checking' ? <p className="text-sm text-ink-2">Checking…</p> : null}
              {device === 'off' ? (
                <>
                  <p className="text-sm text-ink-2">
                    It gets no notifications yet. Your iPhone asks you once.
                  </p>
                  <button
                    type="button"
                    onClick={() => void allow()}
                    disabled={busy !== null}
                    className="self-start rounded-lg bg-carbon px-4 py-2 text-sm font-semibold text-carbon-ink disabled:opacity-60"
                  >
                    {busy === 'allow' ? 'Allowing…' : 'Allow notifications on this device'}
                  </button>
                </>
              ) : null}
              {device === 'on' ? (
                <>
                  <p className="text-sm">It gets your notifications.</p>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => void test()}
                      disabled={busy !== null}
                      className="rounded-lg bg-carbon px-4 py-2 text-sm font-semibold text-carbon-ink disabled:opacity-60"
                    >
                      {busy === 'test' ? 'Sending…' : 'Send a test notification'}
                    </button>
                    <button
                      type="button"
                      onClick={() => void stop()}
                      disabled={busy !== null}
                      className="rounded-lg border border-rule px-4 py-2 text-sm font-semibold disabled:opacity-60"
                    >
                      {busy === 'stop' ? 'Stopping…' : 'Stop on this device'}
                    </button>
                  </div>
                </>
              ) : null}
              {device !== 'checking' && device !== 'off' && device !== 'on' ? (
                <p className="text-sm text-ink-2">{DEVICE_TEXT[device]}</p>
              ) : null}
              {ready.devices > 0 ? (
                <p className="text-xs text-ink-2">
                  {ready.devices === 1
                    ? 'One of your devices gets notifications.'
                    : `${ready.devices} of your devices get notifications.`}
                </p>
              ) : null}
            </section>
            <section
              aria-labelledby="kinds-title"
              className="flex flex-col rounded-xl border border-rule bg-sheet p-5"
            >
              <h2 id="kinds-title" className="font-semibold">
                What to tell you
              </h2>
              <ul className="divide-y divide-rule">
                {ready.kinds.map((k) => (
                  <li key={k.kind} className="flex items-center justify-between gap-3 py-3">
                    <span className="min-w-0 text-sm">{k.label}</span>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={k.on}
                      aria-label={k.label}
                      onClick={() => void toggle(k)}
                      disabled={busy !== null}
                      className={`shrink-0 rounded-lg px-3 py-1.5 text-sm font-semibold disabled:opacity-60 ${
                        k.on ? 'bg-carbon text-carbon-ink' : 'border border-rule'
                      }`}
                    >
                      {busy === k.kind ? 'Working…' : k.on ? 'On' : 'Off'}
                    </button>
                  </li>
                ))}
              </ul>
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
