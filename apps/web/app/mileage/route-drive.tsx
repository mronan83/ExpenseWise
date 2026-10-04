'use client';

import { showDate } from '@expensewise/domain';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { api, ApiProblem } from '../../lib/api';
import type { ExpenseDetail } from '../../lib/expenses';
import { describeRate } from '../../lib/mileage';
import { formatMoney } from '../../lib/receipts';
import { legMiles, measuredBy, stopLabel, type RouteDrive } from '../../lib/route-mileage';
import { RouteForm } from './route-form';

const describeError = (error: unknown) =>
  error instanceof ApiProblem
    ? [error.message, error.detail].filter(Boolean).join('. ')
    : 'Something went wrong. Try again.';

/** How long to wait between looks while a drive is measured, and how many looks. */
const POLL_MS = 2500;
const POLLS = 24;

/**
 * A drive logged by its route (FR-CAP-04, ADR-0039): its stops as typed and where each was
 * found, the miles measured and the miles claimed with the reason when they differ (Q33), and
 * OpenRouteService's attribution wherever the measured route shows. Until it is measured it
 * says Measuring…; one that couldn't be measured says why, and its stops can be fixed and
 * measured again, or its miles entered by hand with a reason.
 */
export function RouteDriveDetails({
  expense,
  onSaved,
}: {
  expense: ExpenseDetail;
  onSaved: (expense: ExpenseDetail) => void;
}) {
  const [drive, setDrive] = useState<RouteDrive | null>(null);
  const [editing, setEditing] = useState<'stops' | 'miles' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [looks, setLooks] = useState(0);
  const told = useRef(onSaved);
  useEffect(() => {
    told.current = onSaved;
  }, [onSaved]);

  const load = useCallback(async () => {
    const found = await api<RouteDrive>(`/v1/mileage/${expense.id}/route`);
    setDrive(found);
    return found;
  }, [expense.id]);

  useEffect(() => {
    let live = true;
    // Loading reads the browser's session, so it can only start after mounting.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load().catch((e: unknown) => {
      if (live) setError(describeError(e));
    });
    return () => {
      live = false;
    };
  }, [load]);

  // While it is measured, look again every few seconds, then say it is taking longer.
  const measuring = drive?.route.status === 'measuring';
  useEffect(() => {
    if (!measuring || looks >= POLLS) return;
    const timer = setTimeout(() => {
      void load().then(
        (found) => {
          setLooks((n) => n + 1);
          if (found.route.status !== 'measuring') told.current(found);
        },
        (e: unknown) => setError(describeError(e)),
      );
    }, POLL_MS);
    return () => clearTimeout(timer);
  }, [measuring, looks, load]);

  const saved = (next: RouteDrive) => {
    setDrive(next);
    setEditing(null);
    setLooks(0);
    told.current(next);
  };

  const route = drive?.route;
  const changeable = expense.editable || expense.status === 'processing';
  const count = route?.stops.length ?? 0;
  return (
    <section
      aria-labelledby="drive-title"
      className="flex flex-col gap-3 rounded-xl border border-rule bg-sheet p-4 text-sm"
    >
      <h2 id="drive-title" className="text-base font-semibold">
        This drive
      </h2>
      {!drive && !error ? <p className="text-ink-2">Loading…</p> : null}
      {drive && route ? (
        <>
          {route.status === 'measuring' ? (
            <p role="status" className="text-ink-2">
              <span className="font-semibold text-ink">Measuring…</span>{' '}
              {looks >= POLLS
                ? 'This is taking longer than usual. Look again in a minute.'
                : 'Its route is being measured. This takes a few seconds.'}
            </p>
          ) : null}
          {route.status === 'failed' ? (
            <p className="text-warn">
              <span className="font-semibold">Not measured.</span> {route.problem}
            </p>
          ) : null}
          {editing === 'stops' ? (
            <RouteForm
              initial={{
                date: drive.mileage.date,
                purpose: drive.mileage.purpose,
                stops: route.stops.map((s) => s.address),
                roundTrip: route.roundTrip,
              }}
              submitLabel="Save"
              busyLabel="Saving…"
              onCancel={() => setEditing(null)}
              onSubmit={async (draft) => {
                // Only what changed: the same stops sent again would measure it again.
                const before = route.stops.map((s) => s.address);
                const stopsChanged =
                  draft.stops.length !== before.length ||
                  draft.stops.some((s, i) => s !== before[i]);
                const changed = {
                  ...(draft.date !== drive.mileage.date ? { date: draft.date } : {}),
                  ...(draft.purpose !== drive.mileage.purpose ? { purpose: draft.purpose } : {}),
                  ...(stopsChanged ? { stops: draft.stops } : {}),
                  ...(draft.roundTrip !== route.roundTrip ? { roundTrip: draft.roundTrip } : {}),
                };
                if (Object.keys(changed).length === 0) {
                  setEditing(null);
                  return;
                }
                saved(
                  await api<RouteDrive>(`/v1/mileage/${expense.id}/route`, {
                    method: 'PATCH',
                    body: JSON.stringify(changed),
                  }),
                );
              }}
            />
          ) : null}
          {editing === 'miles' ? (
            <MilesForm drive={drive} onCancel={() => setEditing(null)} onSaved={saved} />
          ) : null}
          {editing === null ? (
            <>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
                <Row label="Date" value={showDate(drive.mileage.date)} />
                <Row label="Purpose" value={drive.mileage.purpose} />
              </dl>
              <ol className="flex flex-col gap-2" aria-label="Its stops, in order">
                {route.stops.map((stop, i) => (
                  <li key={i} className="flex min-w-0 flex-col">
                    <span className="text-xs font-medium text-ink-2">
                      {stopLabel(i, count)}
                      {stop.legMetres !== null ? ` · ${legMiles(stop.legMetres)}` : ''}
                    </span>
                    <span className="break-words">{stop.address}</span>
                    {stop.place && stop.place.label !== stop.address ? (
                      <span className="text-xs break-words text-ink-2">
                        Found as {stop.place.label}
                      </span>
                    ) : null}
                  </li>
                ))}
                {route.roundTrip ? (
                  <li className="flex flex-col">
                    <span className="text-xs font-medium text-ink-2">
                      Back to the start
                      {route.returnMetres !== null ? ` · ${legMiles(route.returnMetres)}` : ''}
                    </span>
                  </li>
                ) : null}
              </ol>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
                <Row
                  label="Measured"
                  value={route.measured ? `${route.measured.miles} mi` : null}
                />
                <Row
                  label="Claimed"
                  value={route.claimedMiles === null ? null : `${route.claimedMiles} mi`}
                />
                {route.reason ? <Row label="Why" value={route.reason} /> : null}
                <Row label="Rate" value={describeRate(drive.mileage.rate)} />
                <Row label="Amount" value={drive.amount ? formatMoney(drive.amount) : null} />
              </dl>
              {route.measured ? (
                <p className="text-xs text-ink-2">
                  {measuredBy(route.measured)}. {route.attribution}
                </p>
              ) : null}
              {changeable ? (
                <div className="flex flex-wrap gap-2">
                  {route.status !== 'measuring' ? (
                    <button
                      type="button"
                      onClick={() => setEditing('miles')}
                      className="rounded-lg border border-rule px-4 py-2 text-sm font-semibold"
                    >
                      {route.status === 'measured' ? 'Change the miles' : 'Enter the miles by hand'}
                    </button>
                  ) : null}
                  {route.status === 'failed' ? (
                    <button
                      type="button"
                      onClick={() =>
                        void api<RouteDrive>(`/v1/mileage/${expense.id}/route`, {
                          method: 'PATCH',
                          body: JSON.stringify({ stops: route.stops.map((s) => s.address) }),
                        }).then(saved, (e: unknown) => setError(describeError(e)))
                      }
                      className="rounded-lg border border-rule px-4 py-2 text-sm font-semibold"
                    >
                      Measure again
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => setEditing('stops')}
                    className="rounded-lg border border-rule px-4 py-2 text-sm font-semibold"
                  >
                    Change the drive
                  </button>
                </div>
              ) : null}
            </>
          ) : null}
        </>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-warn">
          {error}
        </p>
      ) : null}
    </section>
  );
}

/** The miles claimed: those measured, or others with a reason (Q33). */
function MilesForm({
  drive,
  onCancel,
  onSaved,
}: {
  drive: RouteDrive;
  onCancel: () => void;
  onSaved: (drive: RouteDrive) => void;
}) {
  const { route } = drive;
  const [miles, setMiles] = useState(route.claimedMiles ?? route.measured?.miles ?? '');
  const [reason, setReason] = useState(route.reason ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const asMeasured = route.measured !== null && miles.trim() === route.measured.miles;

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onSaved(
        await api<RouteDrive>(`/v1/mileage/${drive.id}/route/miles`, {
          method: 'PUT',
          body: JSON.stringify({ miles: miles.trim(), reason: asMeasured ? null : reason.trim() }),
        }),
      );
    } catch (e) {
      setError(describeError(e));
      setBusy(false);
    }
  }

  const field =
    'w-full min-w-0 rounded-lg border border-rule bg-paper px-3 py-2 text-base text-ink';
  const label = 'flex min-w-0 flex-col gap-1 text-xs font-medium text-ink-2';
  return (
    <form onSubmit={(e) => void save(e)} className="flex flex-col gap-3">
      <p className="text-ink-2">
        {route.measured
          ? `Measured: ${route.measured.miles} mi. Claim the miles you actually drove, and say why they differ.`
          : 'It couldn’t be measured. Enter the miles you drove, and say how you know them.'}
      </p>
      <label className={label}>
        Miles
        <input
          name="miles"
          required
          inputMode="decimal"
          autoComplete="off"
          pattern="\d{1,4}(\.\d{1,2})?"
          title="Miles such as 38.4"
          value={miles}
          onChange={(e) => setMiles(e.target.value)}
          className={field}
        />
      </label>
      {asMeasured ? null : (
        <label className={label}>
          Why
          <textarea
            name="reason"
            required
            maxLength={500}
            rows={2}
            placeholder="Road closed at the bridge, so I took the detour"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className={field}
          />
        </label>
      )}
      <div className="flex flex-wrap gap-3">
        <button
          type="submit"
          disabled={busy}
          className="rounded-lg bg-carbon px-4 py-2 text-sm font-semibold text-carbon-ink disabled:opacity-60"
        >
          {busy ? 'Saving…' : 'Save the miles'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg border border-rule px-4 py-2 text-sm font-semibold"
        >
          Cancel
        </button>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-warn">
          {error}
        </p>
      ) : null}
    </form>
  );
}

function Row({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="contents">
      <dt className="text-xs font-medium text-ink-2">{label}</dt>
      <dd className="tabular-nums break-words">{value ?? '–'}</dd>
    </div>
  );
}
