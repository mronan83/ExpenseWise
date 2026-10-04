'use client';

import { showDateTime } from '@expensewise/domain';
import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, ApiProblem } from '../../../lib/api';
import { useFeatures } from '../../../lib/features';
import { formText } from '../../../lib/form';
import { supabase } from '../../../lib/supabase';
import { SettingsNav } from '../nav';

type Provider = 'anthropic' | 'openai';

interface KeyStatus {
  provider: Provider;
  configured: boolean;
  keyHint: string | null;
  authScheme: 'api_key' | 'bearer' | null;
  verifiedAt: string | null;
  updatedAt: string | null;
}

const PROVIDERS: Record<
  Provider,
  { name: string; where: string; url: string; use: string; useWithModels: string }
> = {
  anthropic: {
    name: 'Anthropic',
    where: 'Claude Console → API keys',
    url: 'https://console.anthropic.com/settings/keys',
    use: 'Reads every receipt with Haiku 4.5 and Sonnet 5.5, side by side.',
    useWithModels: 'Reads receipts with the Claude models you switch on in AI models.',
  },
  openai: {
    name: 'OpenAI',
    where: 'OpenAI Platform → API keys',
    url: 'https://platform.openai.com/api-keys',
    use: "Reads a receipt with GPT-5.6 Luna only when Claude can't: no credit, a rejected key or an outage.",
    useWithModels: 'Reads receipts with GPT-5.6 Luna when you switch it on in AI models.',
  },
};

type Load =
  | { state: 'loading' }
  | { state: 'signed-out' }
  | { state: 'error'; message: string }
  | { state: 'ready'; keys: KeyStatus[] };

const describeError = (error: unknown) =>
  error instanceof ApiProblem
    ? [error.message, error.detail].filter(Boolean).join('. ')
    : 'Something went wrong. Try again.';

/** AI provider keys (ADR-0015): stored encrypted, checked on save, never shown again. */
export default function AiSettingsPage() {
  const [load, setLoad] = useState<Load>({ state: 'loading' });

  const refresh = useCallback(async () => {
    const session = (await supabase()?.auth.getSession())?.data.session;
    if (!session) {
      setLoad({ state: 'signed-out' });
      return;
    }
    try {
      // Creates the owner's one-person organization on first sign-in.
      await api('/v1/me/organization', { method: 'POST' });
      const { providers } = await api<{ providers: KeyStatus[] }>('/v1/settings/ai-providers');
      setLoad({ state: 'ready', keys: providers });
    } catch (error) {
      setLoad({ state: 'error', message: describeError(error) });
    }
  }, []);

  useEffect(() => {
    // Loading reads the browser's session, so it can only start after mounting.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  const replace = (next: KeyStatus) =>
    setLoad((prev) =>
      prev.state === 'ready'
        ? { state: 'ready', keys: prev.keys.map((k) => (k.provider === next.provider ? next : k)) }
        : prev,
    );

  async function signOut() {
    await supabase()?.auth.signOut();
    setLoad({ state: 'signed-out' });
  }

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
        <SettingsNav current="/settings/ai" />
        <h1 className="text-2xl font-bold">AI providers</h1>
        <p className="text-sm text-ink-2">
          Receipts are read with your own provider keys. Each key is checked with the provider when
          you save it, stored encrypted, and never shown again: only its last four characters.
        </p>
        {load.state === 'loading' ? <p className="text-sm text-ink-2">Loading…</p> : null}
        {load.state === 'signed-out' ? (
          <p className="text-sm">
            <Link href="/sign-in" className="font-semibold text-carbon underline">
              Sign in
            </Link>{' '}
            to manage AI provider keys.
          </p>
        ) : null}
        {load.state === 'error' ? (
          <p role="alert" className="text-sm text-warn">
            {load.message}
          </p>
        ) : null}
        {load.state === 'ready'
          ? load.keys.map((status) => (
              <ProviderCard key={status.provider} status={status} onChange={replace} />
            ))
          : null}
      </main>
    </div>
  );
}

function ProviderCard({
  status,
  onChange,
}: {
  status: KeyStatus;
  onChange: (next: KeyStatus) => void;
}) {
  const info = PROVIDERS[status.provider];
  // With AI model settings on, which models read is chosen there (FR-INT-16).
  const withModels = useFeatures()('receipts.model-settings');
  const [message, setMessage] = useState<{ tone: 'ok' | 'warn'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const inputId = `key-${status.provider}`;

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setMessage(null);
    try {
      await action();
    } catch (error) {
      setMessage({ tone: 'warn', text: describeError(error) });
    } finally {
      setBusy(false);
    }
  }

  const save = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const apiKey = formText(new FormData(form), 'apiKey').trim();
    void run(async () => {
      const next = await api<KeyStatus>(`/v1/settings/ai-providers/${status.provider}`, {
        method: 'PUT',
        body: JSON.stringify({ apiKey }),
      });
      form.reset();
      onChange(next);
      setMessage({ tone: 'ok', text: `${info.name} accepted the key. It is saved.` });
    });
  };

  const test = () =>
    void run(async () => {
      const result = await api<{
        valid: boolean;
        reason?: string;
        detail?: string;
        status: KeyStatus;
      }>(`/v1/settings/ai-providers/${status.provider}/test`, { method: 'POST' });
      onChange(result.status);
      const answered = result.detail ? ` ${result.detail}.` : '';
      setMessage(
        result.valid
          ? { tone: 'ok', text: 'The key works.' }
          : {
              tone: 'warn',
              text:
                result.reason === 'rejected'
                  ? `${info.name} no longer accepts this key.${answered} Save a new one.`
                  : result.reason === 'unreadable'
                    ? 'The stored key can no longer be decrypted. Save it again.'
                    : result.reason === 'refused'
                      ? `${info.name} refused the check.${answered}`
                      : `${info.name} could not be reached.${answered} Try again shortly.`,
            },
      );
    });

  const remove = () =>
    void run(async () => {
      await api(`/v1/settings/ai-providers/${status.provider}`, { method: 'DELETE' });
      onChange({
        ...status,
        configured: false,
        keyHint: null,
        authScheme: null,
        verifiedAt: null,
        updatedAt: null,
      });
      setMessage({ tone: 'ok', text: 'The key is removed.' });
    });

  return (
    <section
      aria-labelledby={`${inputId}-title`}
      className="flex flex-col gap-3 rounded-xl border border-rule bg-sheet p-5"
    >
      <div className="flex items-baseline justify-between gap-2">
        <h2 id={`${inputId}-title`} className="font-semibold">
          {info.name}
        </h2>
        <span className="text-sm text-ink-2">
          {status.configured ? `Key ending ${status.keyHint}` : 'No key'}
        </span>
      </div>
      <p className="text-sm text-ink-2">{withModels ? info.useWithModels : info.use}</p>
      {status.verifiedAt ? (
        <p className="text-sm text-ink-2">Last checked {showDateTime(status.verifiedAt)}</p>
      ) : null}
      <form onSubmit={save} className="flex flex-col gap-2">
        <label htmlFor={inputId} className="text-sm font-medium">
          {status.configured ? `Replace the ${info.name} key` : `${info.name} API key`}
        </label>
        <input
          id={inputId}
          name="apiKey"
          type="password"
          autoComplete="off"
          spellCheck={false}
          required
          minLength={8}
          className="rounded-lg border border-rule bg-paper px-3 py-2 font-mono text-sm"
        />
        <p className="text-xs text-ink-2">
          From{' '}
          <a href={info.url} target="_blank" rel="noreferrer" className="text-carbon underline">
            {info.where}
          </a>
          .
        </p>
        <div className="flex flex-wrap gap-2">
          <button
            type="submit"
            disabled={busy}
            className="rounded-lg bg-carbon px-4 py-2 text-sm font-semibold text-carbon-ink disabled:opacity-60"
          >
            {busy ? 'Working…' : 'Check and save'}
          </button>
          {status.configured ? (
            <>
              <button
                type="button"
                onClick={test}
                disabled={busy}
                className="rounded-lg border border-rule px-4 py-2 text-sm font-semibold disabled:opacity-60"
              >
                Test
              </button>
              <button
                type="button"
                onClick={remove}
                disabled={busy}
                className="rounded-lg border border-rule px-4 py-2 text-sm font-semibold disabled:opacity-60"
              >
                Remove
              </button>
            </>
          ) : null}
        </div>
      </form>
      <p
        role="status"
        className={`min-h-5 text-sm ${message?.tone === 'warn' ? 'text-warn' : 'text-ok'}`}
      >
        {message?.text}
      </p>
    </section>
  );
}
