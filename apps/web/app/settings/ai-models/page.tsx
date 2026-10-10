'use client';

import { showDate } from '@expensewise/domain';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { api, ApiProblem } from '../../../lib/api';
import { formatCost, formatSeconds } from '../../../lib/receipts';
import { supabase } from '../../../lib/supabase';
import { SettingsNav } from '../nav';
import { Wordmark } from '../../brand';

/** One AI model, as Settings › AI models shows it (FR-INT-16). */
interface AiModel {
  model: string;
  label: string;
  provider: 'anthropic' | 'openai';
  tier: string;
  price: { input: string; output: string };
  enabled: boolean;
  primary: boolean;
  reads: 'primary' | 'backup' | 'off';
  keyConfigured: boolean;
  stopped: boolean;
  record: {
    readings: number;
    confident: number;
    unsure: number;
    failed: number;
    averageLatencyMs: number | null;
    costMicroUsd: number;
  };
}

interface AiModelSettings {
  primary: string | null;
  models: AiModel[];
  saved: boolean;
  updatedAt: string | null;
  canChange: boolean;
  comparison: { receipts: number; compared: number; agreed: number };
}

/** What the person is choosing, before it is saved. */
interface Draft {
  primary: string | null;
  models: { model: string; enabled: boolean }[];
}

type Load =
  | { state: 'loading' }
  | { state: 'signed-out' }
  | { state: 'error'; message: string }
  | { state: 'ready'; settings: AiModelSettings; draft: Draft };

type Message = { tone: 'ok' | 'warn'; text: string } | null;

const PROVIDER = { anthropic: 'Anthropic', openai: 'OpenAI' } as const;

const describeError = (error: unknown) =>
  error instanceof ApiProblem
    ? [error.message, error.detail].filter(Boolean).join('. ')
    : 'Something went wrong. Try again.';

const draftOf = (settings: AiModelSettings): Draft => ({
  primary: settings.primary,
  models: settings.models.map(({ model, enabled }) => ({ model, enabled })),
});

const sameDraft = (a: Draft, b: Draft) =>
  a.primary === b.primary &&
  a.models.length === b.models.length &&
  a.models.every((m, i) => m.model === b.models[i]?.model && m.enabled === b.models[i]?.enabled);

/** What a model does now, in a few words. */
function doing(m: AiModel, place: number): string {
  if (m.stopped) return 'Stopped for every organization for now: it reads nothing';
  if (!m.keyConfigured) return `Off: add an ${PROVIDER[m.provider]} key in AI providers first`;
  if (m.reads === 'primary') return 'Reads every receipt and statement';
  if (m.reads === 'backup') return `Back-up ${place}: reads only when the ones before it can’t`;
  return 'Off';
}

/** How it has read your receipts: the running comparison, beside the choice. */
function record(m: AiModel): string {
  const r = m.record;
  if (r.readings === 0) return 'Hasn’t read any of your recent receipts yet.';
  return [
    `${r.confident} of ${r.readings} sure`,
    r.failed > 0 ? `${r.failed} not read` : null,
    `${formatSeconds(r.averageLatencyMs)} on average`,
    `${formatCost(r.costMicroUsd)} spent`,
  ]
    .filter(Boolean)
    .join(' · ');
}

/**
 * Settings › AI models (FR-INT-16, #52): switch each model on or off and choose the one that
 * reads every receipt; the others that are on are back-ups, in the order set. How each has
 * read your receipts sits beside it, so the choice is an informed one.
 */
export default function AiModelsPage() {
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
      const settings = await api<AiModelSettings>('/v1/settings/ai-models');
      setLoad({ state: 'ready', settings, draft: draftOf(settings) });
    } catch (error) {
      setLoad({ state: 'error', message: describeError(error) });
    }
  }, []);

  useEffect(() => {
    // Loading reads the browser's session, so it can only start after mounting.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  const change = (next: (draft: Draft) => Draft) => {
    setMessage(null);
    setLoad((prev) => (prev.state === 'ready' ? { ...prev, draft: next(prev.draft) } : prev));
  };

  /** On or off. The first model switched on becomes primary; a primary switched off hands on. */
  const toggle = (model: string) =>
    change((d) => {
      const models = d.models.map((m) => (m.model === model ? { ...m, enabled: !m.enabled } : m));
      const on = models.filter((m) => m.enabled).map((m) => m.model);
      const primary = d.primary !== null && on.includes(d.primary) ? d.primary : (on[0] ?? null);
      return { primary, models };
    });

  const makePrimary = (model: string) => change((d) => ({ ...d, primary: model }));

  const move = (model: string, by: -1 | 1) =>
    change((d) => {
      const i = d.models.findIndex((m) => m.model === model);
      const j = i + by;
      if (i < 0 || j < 0 || j >= d.models.length) return d;
      const models = [...d.models];
      [models[i], models[j]] = [models[j]!, models[i]!];
      return { ...d, models };
    });

  async function save(draft: Draft) {
    setBusy(true);
    setMessage(null);
    try {
      const settings = await api<AiModelSettings>('/v1/settings/ai-models', {
        method: 'PUT',
        body: JSON.stringify(draft),
      });
      setLoad({ state: 'ready', settings, draft: draftOf(settings) });
      setMessage({
        tone: 'ok',
        text: settings.primary
          ? 'Saved. The next receipt is read this way, and so is any you read again.'
          : 'Saved. Every model is off: receipts are filed for you to fill in.',
      });
    } catch (error) {
      setMessage({ tone: 'warn', text: describeError(error) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-md flex-1 flex-col px-4 pt-[max(1rem,env(safe-area-inset-top))]">
      <header className="flex items-baseline justify-between py-3">
        <Link href="/" className="tap">
          <Wordmark />
        </Link>
      </header>
      <main className="flex flex-1 flex-col gap-4 pb-8">
        <SettingsNav current="/settings/ai-models" />
        <h1 className="text-2xl font-bold">AI models</h1>
        <p className="text-sm text-ink-2">
          One model, the primary, reads every receipt and card statement, and one confident reading
          makes a receipt Ready. The others you switch on are back-ups: each reads only when the
          ones before it couldn’t, in the order below. With every model off, receipts are filed for
          you to fill in.
        </p>
        {load.state === 'loading' ? <p className="text-sm text-ink-2">Loading…</p> : null}
        {load.state === 'signed-out' ? (
          <p className="text-sm">
            <Link href="/sign-in" className="tap font-semibold text-carbon underline">
              Sign in
            </Link>{' '}
            to see your AI models.
          </p>
        ) : null}
        {load.state === 'error' ? (
          <p role="alert" className="text-sm text-warn">
            {load.message}
          </p>
        ) : null}
        {load.state === 'ready' ? (
          <Models
            settings={load.settings}
            draft={load.draft}
            busy={busy}
            onToggle={toggle}
            onPrimary={makePrimary}
            onMove={move}
            onSave={() => void save(load.draft)}
            onUndo={() => change(() => draftOf(load.settings))}
          />
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

function Models({
  settings,
  draft,
  busy,
  onToggle,
  onPrimary,
  onMove,
  onSave,
  onUndo,
}: {
  settings: AiModelSettings;
  draft: Draft;
  busy: boolean;
  onToggle: (model: string) => void;
  onPrimary: (model: string) => void;
  onMove: (model: string, by: -1 | 1) => void;
  onSave: () => void;
  onUndo: () => void;
}) {
  const { canChange, comparison } = settings;
  const changed = !sameDraft(draft, draftOf(settings));
  const byModel = new Map(settings.models.map((m) => [m.model, m]));
  // Back-ups are numbered in the order they are tried, as saved.
  const backups = settings.models.filter((m) => m.reads === 'backup').map((m) => m.model);
  return (
    <section
      aria-labelledby="models-title"
      className="flex flex-col gap-3 rounded-xl border border-rule bg-sheet p-5"
    >
      <h2 id="models-title" className="font-semibold">
        {canChange ? 'Choose your models' : 'Your organization’s models'}
      </h2>
      <p className="text-sm text-ink-2">
        {comparison.receipts === 0
          ? 'No receipts read yet, so there is nothing to compare.'
          : `How each read your latest ${comparison.receipts} receipts.${
              comparison.compared > 0
                ? ` Read side by side, two models agreed on ${comparison.agreed} of ${comparison.compared}.`
                : ''
            }`}
      </p>
      {canChange ? null : (
        <p className="text-sm text-ink-2">Only an owner or finance admin can change them.</p>
      )}
      <ol className="flex flex-col divide-y divide-rule">
        {draft.models.map(({ model, enabled }, i) => {
          const m = byModel.get(model);
          if (!m) return null;
          const switchable = canChange && (enabled || m.keyConfigured);
          return (
            <li key={model} className="flex flex-col gap-2 py-3">
              <div className="flex items-start justify-between gap-3">
                <span className="flex min-w-0 flex-col gap-1">
                  <span className="text-sm font-medium">
                    {m.label}
                    {draft.primary === model ? (
                      <span className="ml-2 text-xs font-semibold text-ok">Primary</span>
                    ) : null}
                  </span>
                  <span className="text-xs text-ink-2">
                    {PROVIDER[m.provider]} · {m.tier} · ${m.price.input} in, ${m.price.output} out
                    per million tokens
                  </span>
                  <span className="text-xs font-medium">
                    {doing(m, backups.indexOf(model) + 1)}
                  </span>
                  <span className="text-xs text-ink-2">{record(m)}</span>
                </span>
                {canChange ? (
                  <button
                    type="button"
                    role="switch"
                    aria-checked={enabled}
                    aria-label={m.label}
                    onClick={() => onToggle(model)}
                    disabled={busy || !switchable}
                    className={`shrink-0 rounded-lg px-3 py-1.5 text-sm font-semibold disabled:opacity-60 ${
                      enabled ? 'bg-carbon text-carbon-ink' : 'border border-rule'
                    }`}
                  >
                    {enabled ? 'On' : 'Off'}
                  </button>
                ) : null}
              </div>
              {canChange ? (
                <div className="flex flex-wrap items-center gap-2">
                  <label className="flex min-h-11 items-center gap-2 text-sm">
                    <input
                      type="radio"
                      name="primary"
                      value={model}
                      checked={draft.primary === model}
                      disabled={busy || !enabled}
                      onChange={() => onPrimary(model)}
                    />
                    Primary
                  </label>
                  <button
                    type="button"
                    onClick={() => onMove(model, -1)}
                    disabled={busy || i === 0}
                    aria-label={`Move ${m.label} up`}
                    className="tap rounded-lg border border-rule px-3 py-1.5 text-sm disabled:opacity-40"
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    onClick={() => onMove(model, 1)}
                    disabled={busy || i === draft.models.length - 1}
                    aria-label={`Move ${m.label} down`}
                    className="tap rounded-lg border border-rule px-3 py-1.5 text-sm disabled:opacity-40"
                  >
                    ↓
                  </button>
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>
      {canChange ? (
        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            onClick={onSave}
            disabled={busy || !changed}
            className="rounded-lg bg-carbon px-4 py-2 text-sm font-semibold text-carbon-ink disabled:opacity-60"
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
          {changed ? (
            <button
              type="button"
              onClick={onUndo}
              disabled={busy}
              className="rounded-lg border border-rule px-4 py-2 text-sm font-semibold"
            >
              Undo changes
            </button>
          ) : null}
        </div>
      ) : null}
      <p className="text-xs text-ink-2">
        {settings.saved && settings.updatedAt
          ? `Last changed ${showDate(settings.updatedAt)}. Every change is in the audit trail.`
          : 'These are the starting choices: nothing has been saved yet.'}
      </p>
    </section>
  );
}
