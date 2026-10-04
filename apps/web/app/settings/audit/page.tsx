'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, ApiProblem } from '../../../lib/api';
import {
  actionLabel,
  actorLabel,
  detailText,
  recordName,
  RECORD_NAMES,
  shortId,
  trailHref,
  type AuditEvent,
  type AuditPage,
  type AuditVerification,
} from '../../../lib/audit';
import { formText } from '../../../lib/form';
import { supabase } from '../../../lib/supabase';
import { SettingsNav } from '../nav';

/** One record to show the history of, or none for the whole trail. */
type Target = { entityType: string; entityId: string };
const EVERYTHING: Target = { entityType: '', entityId: '' };

type Load =
  | { state: 'loading' }
  | { state: 'signed-out' }
  | { state: 'error'; message: string }
  | {
      state: 'ready';
      check: AuditVerification;
      events: AuditEvent[];
      nextCursor: string | null;
    };

/** The record a link asked for, such as a receipt's History link. */
function recordInLink(): Target {
  const params = new URLSearchParams(window.location.search);
  return { entityType: params.get('entityType') ?? '', entityId: params.get('entityId') ?? '' };
}

function describeError(error: unknown): string {
  if (error instanceof ApiProblem) {
    if (error.code === 'feature_off') {
      return 'The audit trail is switched off. Your organization’s owner can switch it on in Settings › Features.';
    }
    if (error.code === 'forbidden_role') {
      return 'Only owners, finance admins and auditors can read the audit trail.';
    }
    return [error.message, error.detail].filter(Boolean).join('. ');
  }
  return 'Something went wrong. Try again.';
}

const when = (at: string) =>
  new Date(at).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

const plural = (n: number, one: string) =>
  `${n.toLocaleString('en-US')} ${one}${n === 1 ? '' : 's'}`;

/** "receipt 0192f7a0…", "every receipt", or "record 0192f7a0…" when only the id is given. */
function targetLabel({ entityType, entityId }: Target): string {
  const kind = entityType ? recordName(entityType).toLowerCase() : '';
  if (!entityId) return `every ${kind}`;
  return `${kind || 'record'} ${shortId(entityId)}`;
}

function pageQuery(record: Target, cursor?: string): string {
  const query = new URLSearchParams();
  if (record.entityType) query.set('entityType', record.entityType);
  if (record.entityId.trim()) query.set('entityId', record.entityId.trim());
  if (cursor) query.set('cursor', cursor);
  return `/v1/audit/events?${query.toString()}`;
}

/**
 * Every record's history (FR-GOV-06): the hash chain recomputed at the top, then each change,
 * newest first, with who made it and what changed, as stored. Owners, finance admins and
 * auditors only; behind the audit trail flag.
 */
export default function AuditTrailPage() {
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [record, setRecord] = useState<Target>(EVERYTHING);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async (shown: Target) => {
    const session = (await supabase()?.auth.getSession())?.data.session;
    if (!session) {
      setLoad({ state: 'signed-out' });
      return;
    }
    try {
      await api('/v1/me/organization', { method: 'POST' });
      const [check, page] = await Promise.all([
        api<AuditVerification>('/v1/audit/verification'),
        api<AuditPage>(pageQuery(shown)),
      ]);
      setLoad({ state: 'ready', check, events: page.events, nextCursor: page.nextCursor });
    } catch (error) {
      setLoad({ state: 'error', message: describeError(error) });
    }
  }, []);

  useEffect(() => {
    // Loading reads the browser's session and the link, so it can only start after mounting.
    const linked = recordInLink();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRecord(linked);
    void refresh(linked);
  }, [refresh]);

  const show = (next: Target) => {
    setRecord(next);
    const href = next.entityType || next.entityId ? trailHref(next.entityType, next.entityId) : '';
    window.history.replaceState(null, '', href || '/settings/audit');
    setLoad({ state: 'loading' });
    void refresh(next);
  };

  async function older() {
    if (load.state !== 'ready' || !load.nextCursor) return;
    setBusy(true);
    try {
      const page = await api<AuditPage>(pageQuery(record, load.nextCursor));
      setLoad({ ...load, events: [...load.events, ...page.events], nextCursor: page.nextCursor });
    } catch (error) {
      setLoad({ state: 'error', message: describeError(error) });
    } finally {
      setBusy(false);
    }
  }

  const narrowed = record.entityType !== '' || record.entityId !== '';

  return (
    <div className="mx-auto flex w-full max-w-md flex-1 flex-col px-4 pt-[max(1rem,env(safe-area-inset-top))]">
      <header className="flex items-baseline justify-between py-3">
        <Link href="/" className="tap font-mono text-xs tracking-widest text-ink-2 uppercase">
          ExpenseWise
        </Link>
      </header>
      <main className="flex flex-1 flex-col gap-4 pb-8">
        <SettingsNav current="/settings/audit" />
        <h1 className="text-2xl font-bold">Audit trail</h1>
        <p className="text-sm text-ink-2">
          Every change to every record, newest first: when, who, and what changed. Each event is
          sealed with a hash of itself and the one before, so an edited, removed or reordered event
          shows below.
        </p>
        {load.state === 'loading' ? <p className="text-sm text-ink-2">Loading…</p> : null}
        {load.state === 'signed-out' ? (
          <p className="text-sm">
            <Link href="/sign-in" className="tap font-semibold text-carbon underline">
              Sign in
            </Link>{' '}
            to see the audit trail.
          </p>
        ) : null}
        {load.state === 'error' ? (
          <p role="alert" className="text-sm text-warn">
            {load.message}
          </p>
        ) : null}
        {load.state === 'ready' ? (
          <>
            <ChainCheck check={load.check} onCheck={() => void refresh(record)} />
            <FilterByRecord record={record} onShow={show} />
            <section aria-labelledby="events-title" className="flex flex-col gap-3">
              <h2 id="events-title" className="font-semibold [overflow-wrap:anywhere]">
                {narrowed ? `History of ${targetLabel(record)}` : 'Every change'}
              </h2>
              {load.events.length === 0 ? (
                <p className="text-sm text-ink-2">
                  {narrowed ? 'Nothing has changed here.' : 'Nothing has changed yet.'}
                </p>
              ) : (
                <ol className="flex flex-col divide-y divide-rule rounded-xl border border-rule bg-sheet">
                  {load.events.map((e) => (
                    <EventRow key={e.sequence} event={e} onTarget={show} />
                  ))}
                </ol>
              )}
              {load.nextCursor ? (
                <button
                  type="button"
                  onClick={() => void older()}
                  disabled={busy}
                  className="self-start rounded-lg border border-rule px-4 py-2 text-sm font-semibold disabled:opacity-60"
                >
                  {busy ? 'Loading…' : 'Show older changes'}
                </button>
              ) : null}
            </section>
          </>
        ) : null}
      </main>
    </div>
  );
}

/** The chain recomputed from every stored event: intact, or where it first breaks. */
function ChainCheck({ check, onCheck }: { check: AuditVerification; onCheck: () => void }) {
  const broken = check.brokenAt;
  return (
    <section
      aria-labelledby="chain-title"
      className="flex flex-col gap-2 rounded-xl border border-rule bg-sheet p-4"
    >
      <h2 id="chain-title" className="sr-only">
        Hash chain
      </h2>
      {broken ? (
        <>
          <p className="font-semibold text-bad">
            Chain broken at event #{broken.sequence}: {plural(check.checked, 'event')} checked
          </p>
          <p className="text-sm text-ink-2">
            {actionLabel(broken)} on {when(broken.occurredAt)} doesn’t match its hash, so it or an
            event before it was changed after it was written.{' '}
            {check.checked > 1
              ? `The ${plural(check.checked - 1, 'event')} before it verify.`
              : 'It is the first event.'}{' '}
            The trail holds {plural(check.total, 'event')}.
          </p>
        </>
      ) : (
        <p className="font-semibold text-ok">
          Chain intact: {plural(check.checked, 'event')} checked
        </p>
      )}
      <p className="flex flex-wrap items-baseline justify-between gap-2 text-xs text-ink-2">
        <span>Checked {when(check.checkedAt)}</span>
        <button type="button" onClick={onCheck} className="tap font-semibold text-carbon">
          Check again
        </button>
      </p>
    </section>
  );
}

function FilterByRecord({ record, onShow }: { record: Target; onShow: (r: Target) => void }) {
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    onShow({ entityType: formText(form, 'entityType'), entityId: formText(form, 'entityId') });
  };
  const field =
    'w-full min-w-0 rounded-lg border border-rule bg-paper px-3 py-2 text-base text-ink';
  const label = 'flex min-w-0 flex-col gap-1 text-xs font-medium text-ink-2';
  return (
    <form
      role="search"
      aria-label="Audit trail"
      onSubmit={submit}
      key={JSON.stringify(record)}
      className="flex flex-col gap-3 rounded-xl border border-rule bg-sheet p-4"
    >
      <div className="flex flex-col gap-3">
        <label className={label}>
          Record
          <select name="entityType" defaultValue={record.entityType} className={field}>
            <option value="">Any</option>
            {Object.entries(RECORD_NAMES).map(([type, name]) => (
              <option key={type} value={type}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label className={label}>
          Its id
          <input
            name="entityId"
            defaultValue={record.entityId}
            autoComplete="off"
            maxLength={200}
            className={field}
          />
        </label>
      </div>
      <div className="flex flex-wrap gap-3">
        <button
          type="submit"
          className="rounded-lg border border-rule px-4 py-2 text-sm font-semibold"
        >
          Show
        </button>
        {record.entityType || record.entityId ? (
          <button
            type="button"
            onClick={() => onShow(EVERYTHING)}
            className="rounded-lg px-4 py-2 text-sm font-semibold text-carbon"
          >
            Show every change
          </button>
        ) : null}
      </div>
    </form>
  );
}

function EventRow({ event, onTarget }: { event: AuditEvent; onTarget: (r: Target) => void }) {
  const details = Object.entries(event.payload);
  return (
    <li className="flex flex-col gap-1 px-4 py-3">
      <p className="flex items-baseline justify-between gap-3">
        <span className="min-w-0 text-sm font-medium [overflow-wrap:anywhere]">
          {actionLabel(event)}
        </span>
        <span className="shrink-0 font-mono text-xs text-ink-2">#{event.sequence}</span>
      </p>
      <p className="text-xs text-ink-2 [overflow-wrap:anywhere]">
        {when(event.occurredAt)} · {actorLabel(event.actor)}
      </p>
      <p className="text-xs">
        <button
          type="button"
          onClick={() => onTarget({ entityType: event.entityType, entityId: event.entityId })}
          aria-label={`${recordName(event.entityType)} ${shortId(event.entityId)}: show its history`}
          title={event.entityId}
          className="tap font-medium text-carbon [overflow-wrap:anywhere]"
        >
          {recordName(event.entityType)} {shortId(event.entityId)}
        </button>
      </p>
      {details.length > 0 ? (
        <dl className="grid grid-cols-[auto_1fr] gap-x-2 font-mono text-xs text-ink-2">
          {details.map(([key, value]) => (
            <div key={key} className="contents">
              <dt>{key}</dt>
              <dd className="min-w-0 text-ink [overflow-wrap:anywhere]">{detailText(value)}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </li>
  );
}
