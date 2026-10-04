'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, ApiProblem } from '../../lib/api';
import { PURPOSE_MAX } from '../../lib/mileage';
import {
  ROUTE_ADDRESS_MAX,
  ROUTE_MAX_STOPS,
  stopLabel,
  WHAT_IS_SENT,
  type SavedPlace,
} from '../../lib/route-mileage';

/** A drive by its stops, as the form holds it. */
export interface RouteDraft {
  date: string;
  purpose: string;
  stops: string[];
  roundTrip: boolean;
}

const describeError = (error: unknown) =>
  error instanceof ApiProblem
    ? [error.message, error.detail].filter(Boolean).join('. ')
    : 'Something went wrong. Try again.';

/**
 * A drive by its route (FR-CAP-04): its date, why it was for business, a start, stops in
 * order and an end, and whether it comes back to the start. Each stop can be filled from one
 * of the person's saved places, whose address is copied in; only addresses are ever sent to
 * be measured (Q32).
 */
export function RouteForm({
  initial,
  submitLabel,
  busyLabel,
  onSubmit,
  onCancel,
  dateAndPurpose = true,
}: {
  initial: RouteDraft;
  submitLabel: string;
  busyLabel: string;
  onSubmit: (draft: RouteDraft) => Promise<void>;
  onCancel?: () => void;
  /** Off where only the stops are changed. */
  dateAndPurpose?: boolean;
}) {
  const [draft, setDraft] = useState<RouteDraft>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [places, setPlaces] = useState<SavedPlace[]>([]);
  // A key per stop, so a moved stop keeps its own input.
  const next = useRef(initial.stops.length);
  const [keys, setKeys] = useState(() => initial.stops.map((_, i) => i));

  useEffect(() => {
    let live = true;
    void api<{ places: SavedPlace[] }>('/v1/me/places').then(
      (found) => {
        if (live) setPlaces(found.places);
      },
      // Without places the stops are typed: nothing to say.
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, []);

  const setStop = (i: number, address: string) =>
    setDraft({ ...draft, stops: draft.stops.map((s, j) => (j === i ? address : s)) });
  const move = (i: number, by: -1 | 1) => {
    const order = draft.stops.map((_, j) => j);
    [order[i], order[i + by]] = [order[i + by]!, order[i]!];
    setDraft({ ...draft, stops: order.map((j) => draft.stops[j]!) });
    setKeys(order.map((j) => keys[j]!));
  };
  const remove = (i: number) => {
    setDraft({ ...draft, stops: draft.stops.filter((_, j) => j !== i) });
    setKeys(keys.filter((_, j) => j !== i));
  };
  /** A new stop goes before the end. */
  const add = () => {
    const at = draft.stops.length - 1;
    setDraft({ ...draft, stops: [...draft.stops.slice(0, at), '', ...draft.stops.slice(at)] });
    setKeys([...keys.slice(0, at), next.current++, ...keys.slice(at)]);
  };

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSubmit({
        date: draft.date.trim(),
        purpose: draft.purpose.trim(),
        stops: draft.stops.map((s) => s.trim()),
        roundTrip: draft.roundTrip,
      });
    } catch (e) {
      setError(describeError(e));
      setBusy(false);
    }
  }

  const field =
    'w-full min-w-0 rounded-lg border border-rule bg-paper px-3 py-2 text-base text-ink';
  const label = 'flex min-w-0 flex-col gap-1 text-xs font-medium text-ink-2';
  const small =
    'tap rounded-lg border border-rule px-3 py-1.5 text-xs font-semibold disabled:opacity-40';
  const count = draft.stops.length;

  return (
    <form onSubmit={(e) => void save(e)} className="flex flex-col gap-3">
      {dateAndPurpose ? (
        <>
          <label className={label}>
            Date
            <input
              name="date"
              type="date"
              required
              value={draft.date}
              onChange={(e) => setDraft({ ...draft, date: e.target.value })}
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
              placeholder="Client visit at Acme"
              value={draft.purpose}
              onChange={(e) => setDraft({ ...draft, purpose: e.target.value })}
              className={field}
            />
          </label>
        </>
      ) : null}
      <fieldset className="flex min-w-0 flex-col gap-3">
        <legend className="mb-1 text-xs font-medium text-ink-2">
          Where the drive went, in order
        </legend>
        {draft.stops.map((stop, i) => {
          const name = stopLabel(i, count);
          return (
            <div key={keys[i]} className="flex min-w-0 flex-col gap-1.5">
              <label className={label}>
                {name}
                <input
                  name={`stop-${i}`}
                  required
                  maxLength={ROUTE_ADDRESS_MAX}
                  autoComplete="off"
                  placeholder={i === 0 ? '12 Elm St, Omaha, NE' : 'An address'}
                  value={stop}
                  onChange={(e) => setStop(i, e.target.value)}
                  className={field}
                />
              </label>
              <div className="flex flex-wrap items-center gap-2">
                {places.length > 0 ? (
                  <select
                    aria-label={`Use a saved place for ${name.toLowerCase()}`}
                    value=""
                    onChange={(e) => {
                      const place = places.find((p) => p.id === e.target.value);
                      if (place) setStop(i, place.address);
                    }}
                    className="tap min-w-0 rounded-lg border border-rule bg-paper px-2 py-1.5 text-xs"
                  >
                    <option value="">Saved place…</option>
                    {places.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                ) : null}
                <button
                  type="button"
                  className={small}
                  disabled={i === 0}
                  onClick={() => move(i, -1)}
                  aria-label={`Move ${name.toLowerCase()} earlier`}
                >
                  Earlier
                </button>
                <button
                  type="button"
                  className={small}
                  disabled={i === count - 1}
                  onClick={() => move(i, 1)}
                  aria-label={`Move ${name.toLowerCase()} later`}
                >
                  Later
                </button>
                <button
                  type="button"
                  className={small}
                  disabled={count <= 2}
                  onClick={() => remove(i)}
                  aria-label={`Remove ${name.toLowerCase()}`}
                >
                  Remove
                </button>
              </div>
            </div>
          );
        })}
        <div>
          <button type="button" className={small} disabled={count >= ROUTE_MAX_STOPS} onClick={add}>
            Add a stop
          </button>
        </div>
      </fieldset>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          name="roundTrip"
          checked={draft.roundTrip}
          onChange={(e) => setDraft({ ...draft, roundTrip: e.target.checked })}
          className="size-5"
        />
        Round trip: back to the start after the end
      </label>
      <p className="text-xs text-ink-2">{WHAT_IS_SENT}</p>
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
