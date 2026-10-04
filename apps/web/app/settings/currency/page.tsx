'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { api, ApiProblem } from '../../../lib/api';
import { supabase } from '../../../lib/supabase';
import { SettingsNav } from '../nav';

/** The person's reimbursement currency (FR-EXP-13, Q23), as the API answers it. */
interface ReimbursementCurrency {
  currency: string;
  chosen: string | null;
  homeCurrency: string;
  currencies: { code: string; converts: boolean }[];
}

type Load =
  | { state: 'loading' }
  | { state: 'signed-out' }
  | { state: 'error'; message: string }
  | ({ state: 'ready' } & ReimbursementCurrency);

type Message = { tone: 'ok' | 'warn'; text: string } | null;

/** The select's value for following the organization's home currency. */
const FOLLOW = '';

const describeError = (error: unknown) =>
  error instanceof ApiProblem
    ? [error.message, error.detail].filter(Boolean).join('. ')
    : 'Something went wrong. Try again.';

/**
 * The currency you are reimbursed in (FR-EXP-13). Every amount on your reports is converted
 * to it at its purchase date's reference rate (Q25), beside the amount as spent. Until you
 * choose, it is your organization's home currency (Q23).
 */
export default function CurrencyPage() {
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [choice, setChoice] = useState(FOLLOW);
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
      const found = await api<ReimbursementCurrency>('/v1/me/reimbursement-currency');
      setLoad({ state: 'ready', ...found });
      setChoice(found.chosen ?? FOLLOW);
    } catch (error) {
      setLoad({ state: 'error', message: describeError(error) });
    }
  }, []);

  useEffect(() => {
    // Loading reads the browser's session, so it can only start after mounting.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  async function save() {
    setBusy(true);
    setMessage(null);
    try {
      const saved = await api<ReimbursementCurrency>('/v1/me/reimbursement-currency', {
        method: 'PUT',
        body: JSON.stringify({ currency: choice === FOLLOW ? null : choice }),
      });
      setLoad({ state: 'ready', ...saved });
      setMessage({
        tone: 'ok',
        text: `Your open and closed reports are now in ${saved.currency}. Their amounts convert in a minute or two.`,
      });
    } catch (error) {
      setMessage({ tone: 'warn', text: describeError(error) });
    } finally {
      setBusy(false);
    }
  }

  const ready = load.state === 'ready' ? load : null;
  const picked = ready?.currencies.find((c) => c.code === (choice || ready.homeCurrency));

  return (
    <div className="mx-auto flex w-full max-w-md flex-1 flex-col px-4 pt-[max(1rem,env(safe-area-inset-top))]">
      <header className="flex items-baseline justify-between py-3">
        <Link href="/" className="tap font-mono text-xs tracking-widest text-ink-2 uppercase">
          ExpenseWise
        </Link>
      </header>
      <main className="flex flex-1 flex-col gap-4 pb-8">
        <SettingsNav current="/settings/currency" />
        <h1 className="text-2xl font-bold">Currency</h1>
        <p className="text-sm text-ink-2">
          Your reports show every amount in the currency you are reimbursed in, beside what you
          spent. Each is converted at the European Central Bank’s reference rate for its purchase
          date, and keeps that rate.
        </p>
        {load.state === 'loading' ? <p className="text-sm text-ink-2">Loading…</p> : null}
        {load.state === 'signed-out' ? (
          <p className="text-sm">
            <Link href="/sign-in" className="tap font-semibold text-carbon underline">
              Sign in
            </Link>{' '}
            to choose your currency.
          </p>
        ) : null}
        {load.state === 'error' ? (
          <p role="alert" className="text-sm text-warn">
            {load.message}
          </p>
        ) : null}
        {ready ? (
          <section
            aria-labelledby="currency-title"
            className="flex flex-col gap-3 rounded-xl border border-rule bg-sheet p-5"
          >
            <h2 id="currency-title" className="font-semibold">
              Reimbursed in {ready.currency}
            </h2>
            <p className="text-sm text-ink-2">
              {ready.chosen
                ? 'You chose it. A submitted report keeps the currency it was submitted in.'
                : `Your organization’s home currency, until you choose another.`}
            </p>
            <label className="flex flex-col gap-1 text-xs font-medium text-ink-2">
              Currency
              <select
                value={choice}
                onChange={(e) => setChoice(e.target.value)}
                className="min-h-11 rounded-lg border border-rule bg-paper px-3 text-base text-ink"
              >
                <option value={FOLLOW}>Your organization’s: {ready.homeCurrency}</option>
                {ready.currencies.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.code}
                    {c.converts ? '' : ' (no reference rate)'}
                  </option>
                ))}
              </select>
            </label>
            {picked && !picked.converts ? (
              <p className="text-sm text-warn">
                The European Central Bank publishes no rate for {picked.code}, so amounts in other
                currencies would stay as spent.
              </p>
            ) : null}
            <button
              type="button"
              onClick={() => void save()}
              disabled={busy || choice === (ready.chosen ?? FOLLOW)}
              className="self-start rounded-lg bg-carbon px-4 py-2 text-sm font-semibold text-carbon-ink disabled:opacity-60"
            >
              {busy ? 'Saving…' : 'Save'}
            </button>
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
