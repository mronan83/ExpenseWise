'use client';

import { showDate } from '@expensewise/domain';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, ApiProblem } from '../../../lib/api';
import { describeRate, type MileageRateChange, type MileageRates } from '../../../lib/mileage';
import { localToday } from '../../../lib/trips';

type Load =
  | { state: 'loading' }
  | { state: 'off' }
  | { state: 'error'; message: string }
  | ({ state: 'ready' } & MileageRates);

type Message = { tone: 'ok' | 'warn'; text: string } | null;

const describeError = (error: unknown) =>
  error instanceof ApiProblem
    ? [error.message, error.detail].filter(Boolean).join('. ')
    : 'Something went wrong. Try again.';

/** "$0.65 a mile", or the amount as typed where the currency can't be formatted. */
function perMile(change: Pick<MileageRateChange, 'perMile' | 'currency'>): string {
  const rate = change.perMile ?? '';
  const digits = rate.split('.')[1]?.length ?? 0;
  try {
    // Intl takes the decimal string exactly; no float conversion.
    const amount = new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: change.currency ?? 'USD',
      maximumFractionDigits: Math.max(digits, 2),
    }).format(rate as unknown as number);
    return `${amount} a mile`;
  } catch {
    return `${rate} ${change.currency ?? ''} a mile`;
  }
}

/** What one change says: "From Nov 1, 2026: $0.65 a mile, your own" or "the IRS rate again". */
const changeText = (c: MileageRateChange) =>
  c.source === 'organization' ? `${perMile(c)}, your own` : 'the IRS business rate again';

/**
 * Settings › Mileage › Rate a mile (Q28, #77): the rate a drive dated today is paid at and
 * where it comes from, each change the organization made, and, for an owner or finance admin,
 * a form to set their own rate from a day or go back to the IRS business rate. A drive keeps
 * the rate it was paid at, so a change applies to drives dated from its day on (NFR-DAT-04).
 */
export function RateSection() {
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [mode, setMode] = useState<'own' | 'irs'>('own');
  const [from, setFrom] = useState('');
  const [rate, setRate] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message>(null);

  const refresh = useCallback(async () => {
    try {
      const found = await api<MileageRates>('/v1/mileage-rates');
      setLoad({ state: 'ready', ...found });
    } catch (error) {
      if (error instanceof ApiProblem && error.code === 'feature_off') setLoad({ state: 'off' });
      else setLoad({ state: 'error', message: describeError(error) });
    }
  }, []);

  useEffect(() => {
    // The person's own date and the rates are only known after mounting.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFrom(localToday());
    void refresh();
  }, [refresh]);

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const saved = await api<MileageRates>(
        `/v1/settings/mileage-rates/${encodeURIComponent(from.trim())}`,
        {
          method: 'PUT',
          body: JSON.stringify({ perMile: mode === 'own' ? rate.trim() : null }),
        },
      );
      setLoad({ state: 'ready', ...saved });
      setRate('');
      setMessage({
        tone: 'ok',
        text: `Saved. Drives dated from ${showDate(from.trim())} are paid at ${
          mode === 'own' ? 'your own rate' : 'the IRS business rate'
        }; drives already logged keep theirs.`,
      });
    } catch (error) {
      setMessage({ tone: 'warn', text: describeError(error) });
    } finally {
      setBusy(false);
    }
  }

  const ready = load.state === 'ready' ? load : null;

  return (
    <section
      aria-labelledby="rate-title"
      className="flex flex-col gap-3 rounded-xl border border-rule bg-sheet p-5 text-sm"
    >
      <h2 id="rate-title" className="text-base font-semibold">
        Rate a mile
      </h2>
      {load.state === 'loading' ? <p className="text-ink-2">Loading…</p> : null}
      {load.state === 'off' ? <p>Mileage is switched off for your organization.</p> : null}
      {load.state === 'error' ? (
        <p role="alert" className="text-warn">
          {load.message}
        </p>
      ) : null}
      {ready ? (
        <>
          <p>
            <span className="font-semibold">Today:</span>{' '}
            {ready.inForce.rate ? `${describeRate(ready.inForce.rate)}.` : ready.inForce.problem}
          </p>
          <p className="text-ink-2">
            Drives are paid at the IRS business rate unless your organization sets its own. A change
            applies to drives dated from its day on; each drive keeps the rate it was paid at.
          </p>
          {ready.changes.length > 0 ? (
            <div className="flex flex-col gap-1">
              <h3 className="text-xs font-semibold text-ink-2 uppercase">Changes</h3>
              <ul className="flex flex-col gap-1">
                {ready.changes.map((c) => (
                  <li key={c.effectiveFrom}>
                    From {showDate(c.effectiveFrom)}: {changeText(c)}.{' '}
                    <span className="text-ink-2">Set by {c.setBy}.</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {ready.canChange ? (
            <form onSubmit={(e) => void save(e)} className="flex flex-col gap-3">
              <fieldset className="flex flex-col gap-2">
                <legend className="text-xs font-medium text-ink-2">Pay drives at</legend>
                <label className="flex min-h-11 items-center gap-2">
                  <input
                    type="radio"
                    name="rate-mode"
                    value="own"
                    checked={mode === 'own'}
                    onChange={() => setMode('own')}
                  />
                  Your own rate a mile, in {ready.homeCurrency}
                </label>
                <label className="flex min-h-11 items-center gap-2">
                  <input
                    type="radio"
                    name="rate-mode"
                    value="irs"
                    checked={mode === 'irs'}
                    onChange={() => setMode('irs')}
                  />
                  The IRS business rate
                </label>
              </fieldset>
              <label className="flex flex-col gap-1 text-xs font-medium text-ink-2">
                From
                <input
                  type="date"
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                  required
                  className="min-h-11 rounded-lg border border-rule bg-paper px-3 text-base text-ink"
                />
              </label>
              {mode === 'own' ? (
                <label className="flex flex-col gap-1 text-xs font-medium text-ink-2">
                  Rate a mile ({ready.homeCurrency})
                  <input
                    inputMode="decimal"
                    value={rate}
                    onChange={(e) => setRate(e.target.value)}
                    placeholder="0.65"
                    required
                    className="min-h-11 rounded-lg border border-rule bg-paper px-3 text-base text-ink"
                  />
                </label>
              ) : null}
              <button
                type="submit"
                disabled={busy || !from || (mode === 'own' && !rate.trim())}
                className="self-start rounded-lg bg-carbon px-4 py-2 text-sm font-semibold text-carbon-ink disabled:opacity-60"
              >
                {busy ? 'Saving…' : 'Save'}
              </button>
            </form>
          ) : (
            <p className="text-ink-2">Only an owner or a finance admin changes it.</p>
          )}
        </>
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
