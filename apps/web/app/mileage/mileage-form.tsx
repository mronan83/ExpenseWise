'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiProblem } from '../../lib/api';
import { describeRate, PURPOSE_MAX, type Mileage, type MileageQuote } from '../../lib/mileage';
import { formatMoney } from '../../lib/receipts';

export type MileageDraft = Pick<Mileage, 'date' | 'destination' | 'purpose' | 'miles'>;

const describeError = (error: unknown) =>
  error instanceof ApiProblem
    ? [error.message, error.detail].filter(Boolean).join('. ')
    : 'Something went wrong. Try again.';

type Quote =
  | { state: 'none' }
  | { state: 'ready'; quote: MileageQuote }
  | { state: 'refused'; message: string };

/**
 * A drive's date, destination, business purpose and miles (FR-CAP-03), with what it would pay
 * at the rate in force on its date, worked out by the API as the person types.
 */
export function MileageForm({
  initial,
  submitLabel,
  busyLabel,
  onSubmit,
  onCancel,
}: {
  initial: MileageDraft;
  submitLabel: string;
  busyLabel: string;
  /** Saves the drive; only the fields that changed when editing. */
  onSubmit: (draft: MileageDraft) => Promise<void>;
  onCancel?: () => void;
}) {
  const [draft, setDraft] = useState<MileageDraft>(initial);
  const [quote, setQuote] = useState<Quote>({ state: 'none' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // What it would pay, asked again a moment after the date or miles stop changing.
  useEffect(() => {
    const date = draft.date.trim();
    const miles = draft.miles.trim();
    if (!date || !miles) return;
    let live = true;
    const timer = setTimeout(() => {
      const query = new URLSearchParams({ date, miles });
      void api<MileageQuote>(`/v1/mileage/quote?${query.toString()}`).then(
        (q) => {
          if (live) setQuote({ state: 'ready', quote: q });
        },
        (e: unknown) => {
          if (live) setQuote({ state: 'refused', message: describeError(e) });
        },
      );
    }, 300);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [draft.date, draft.miles]);

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSubmit({
        date: draft.date.trim(),
        destination: draft.destination.trim(),
        purpose: draft.purpose.trim(),
        miles: draft.miles.trim(),
      });
    } catch (e) {
      setError(describeError(e));
      setBusy(false);
    }
  }

  const field =
    'w-full min-w-0 rounded-lg border border-rule bg-paper px-3 py-2 text-base text-ink';
  const label = 'flex min-w-0 flex-col gap-1 text-xs font-medium text-ink-2';
  const set = (key: keyof MileageDraft) => (value: string) => {
    setDraft({ ...draft, [key]: value });
    if (key === 'date' || key === 'miles') setQuote({ state: 'none' });
  };
  const filled = draft.date.trim() !== '' && draft.miles.trim() !== '';

  return (
    <form onSubmit={(e) => void save(e)} className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-3">
        <label className={label}>
          Date
          <input
            name="date"
            type="date"
            required
            value={draft.date}
            onChange={(e) => set('date')(e.target.value)}
            className={field}
          />
        </label>
        <label className={label}>
          Miles
          <input
            name="miles"
            required
            inputMode="decimal"
            autoComplete="off"
            pattern="\d{1,4}(\.\d{1,2})?"
            title="Miles such as 38.4"
            value={draft.miles}
            onChange={(e) => set('miles')(e.target.value)}
            className={field}
          />
        </label>
      </div>
      <label className={label}>
        Destination
        <input
          name="destination"
          required
          maxLength={200}
          autoComplete="off"
          placeholder="IAH airport"
          value={draft.destination}
          onChange={(e) => set('destination')(e.target.value)}
          className={field}
        />
      </label>
      <label className={label}>
        Business purpose
        <textarea
          name="purpose"
          required
          maxLength={PURPOSE_MAX}
          rows={2}
          placeholder="Drive to the airport for the Acme onsite"
          value={draft.purpose}
          onChange={(e) => set('purpose')(e.target.value)}
          className={field}
        />
      </label>
      <p role="status" aria-live="polite" className="text-sm">
        {!filled ? (
          <span className="text-ink-2">Enter the date and miles to see what the drive pays.</span>
        ) : quote.state === 'ready' ? (
          <>
            Pays{' '}
            <span className="font-semibold tabular-nums">{formatMoney(quote.quote.amount)}</span>{' '}
            <span className="text-ink-2">at {describeRate(quote.quote.rate)}.</span>
          </>
        ) : quote.state === 'refused' ? (
          <span className="text-warn">{quote.message}</span>
        ) : (
          <span className="text-ink-2">Working out what it pays…</span>
        )}
      </p>
      <div className="flex flex-wrap gap-3">
        <button
          type="submit"
          disabled={busy}
          className="rounded-lg bg-carbon px-4 py-2 text-sm font-semibold text-carbon-ink disabled:opacity-60"
        >
          {busy ? busyLabel : submitLabel}
        </button>
        {onCancel ? (
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg border border-rule px-4 py-2 text-sm font-semibold"
          >
            Cancel
          </button>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="text-sm text-warn">
          {error}
        </p>
      ) : null}
    </form>
  );
}
