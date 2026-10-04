'use client';

import { isIsoDate, showDate, showDateTime } from '@expensewise/domain';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { api, ApiProblem } from '../../../lib/api';
import { useFeatures } from '../../../lib/features';
import {
  describeChecks,
  describeReadingError,
  FIELD_LABELS,
  providerOf,
  formatCost,
  formatMoney,
  formatSeconds,
  isLocked,
  MERGE_FIELDS,
  RECEIPT_STATUS,
  underSettings,
  type CorrectableField,
  type DuplicateSide,
  type FieldSources,
  type MergeField,
  type MoneyField,
  type PossibleDuplicate,
  type Reading,
  type ReceiptDetail,
  type TextField,
} from '../../../lib/receipts';
import { placeOf } from '../../../lib/expenses';
import { supabase } from '../../../lib/supabase';
import { HistoryLink } from '../../history-link';

type Load =
  | { state: 'loading' }
  | { state: 'signed-out' }
  | { state: 'error'; message: string }
  | { state: 'ready'; receipt: ReceiptDetail };

const describeError = (error: unknown) =>
  error instanceof ApiProblem
    ? [error.message, error.detail].filter(Boolean).join('. ')
    : 'Something went wrong. Try again.';

type Fields = NonNullable<Reading['fields']>;
const ROWS: { key: keyof Fields; label: string; filing?: string }[] = [
  { key: 'merchant', label: 'Merchant', filing: 'merchant' },
  { key: 'date', label: 'Date', filing: 'date' },
  { key: 'time', label: 'Time' },
  { key: 'address', label: 'Address' },
  { key: 'total', label: 'Total', filing: 'total' },
  { key: 'currency', label: 'Currency', filing: 'currency' },
  { key: 'subtotal', label: 'Subtotal' },
  { key: 'taxTotal', label: 'Tax' },
  { key: 'tip', label: 'Tip' },
  { key: 'fees', label: 'Fees' },
  { key: 'cardLastFour', label: 'Card' },
  { key: 'documentType', label: 'Type' },
];

/**
 * Where a ride, flight or train went and a folio's stay, as each model read them, while
 * Journeys and stays is on (FR-INT-20, FR-INT-21). A row shows once any model read it.
 */
const JOURNEY_ROWS: typeof ROWS = [
  { key: 'from', label: 'From' },
  { key: 'to', label: 'To' },
  { key: 'checkIn', label: 'Check-in' },
  { key: 'checkOut', label: 'Check-out' },
];

/** Gives up refreshing after this long; the page offers to read it again instead. */
const POLL_LIMIT_MS = 3 * 60 * 1000;

/** One receipt, read by each compared model, side by side (ADR-0017). */
export default function ReceiptPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const isOn = useFeatures();
  // Where each field was read, and one tap to correct a Ready receipt (GAP-14).
  const sources = isOn('receipts.field-sources');
  const journeys = isOn('receipts.journeys');
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [stale, setStale] = useState(false);

  const refresh = useCallback(async () => {
    const session = (await supabase()?.auth.getSession())?.data.session;
    if (!session) {
      setLoad({ state: 'signed-out' });
      return;
    }
    try {
      setLoad({ state: 'ready', receipt: await api<ReceiptDetail>(`/v1/receipts/${id}`) });
    } catch (error) {
      setLoad({ state: 'error', message: describeError(error) });
    }
  }, [id]);

  useEffect(() => {
    // Loading reads the browser's session, so it can only start after mounting.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  const reading = load.state === 'ready' && load.receipt.status === 'processing';
  useEffect(() => {
    if (!reading) return;
    const started = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - started < POLL_LIMIT_MS) {
        void refresh();
        return;
      }
      setStale(true);
      clearInterval(timer);
    }, 2500);
    return () => clearInterval(timer);
  }, [reading, refresh]);

  async function readAgain() {
    if (
      receipt?.confirmation &&
      !window.confirm('Reading it again replaces the confirmed values. Read it again?')
    ) {
      return;
    }
    setBusy(true);
    setMessage(null);
    setStale(false);
    try {
      await api(`/v1/receipts/${id}/read`, { method: 'POST' });
      await refresh();
    } catch (error) {
      setMessage(describeError(error));
    } finally {
      setBusy(false);
    }
  }

  const receipt = load.state === 'ready' ? load.receipt : null;
  const held = receipt?.duplicates.some((d) => d.held) ?? false;

  /** After a decision: this page if this receipt was kept, else the one that was. */
  async function decided(result: Resolution, note?: string) {
    setMessage(note ?? RESOLVED[result.outcome]);
    if (result.kept === id) await refresh();
    else router.replace(`/receipts/${result.kept}`);
  }

  return (
    <div className="mx-auto flex w-full max-w-md flex-1 flex-col px-4 pt-[max(1rem,env(safe-area-inset-top))]">
      <header className="flex items-baseline justify-between py-3">
        <Link href="/receipts" className="tap text-sm font-semibold text-carbon">
          ← Receipts
        </Link>
        <HistoryLink entityType="receipt" entityId={id} />
      </header>
      <main className="flex flex-1 flex-col gap-4 pb-8">
        <h1 className="text-2xl font-bold">{receipt?.merchant ?? 'Receipt'}</h1>
        {load.state === 'loading' ? <p className="text-sm text-ink-2">Loading…</p> : null}
        {load.state === 'signed-out' ? (
          <p className="text-sm">
            <Link href="/sign-in" className="font-semibold text-carbon underline">
              Sign in
            </Link>{' '}
            to see this receipt.
          </p>
        ) : null}
        {load.state === 'error' ? (
          <p role="alert" className="text-sm text-warn">
            {load.message}
          </p>
        ) : null}

        {receipt ? (
          <>
            <Verdict receipt={receipt} stale={reading && stale} />
            {receipt.duplicates.map((pair) => (
              <Duplicate
                key={pair.other.receiptId}
                pair={pair}
                onDecided={(result) => void decided(result)}
              />
            ))}
            {!held && (receipt.status === 'needs_review' || receipt.status === 'failed') ? (
              <Review
                key={receipt.readings.map((r) => r.model + r.state).join()}
                receipt={receipt}
                onConfirmed={(next) => setLoad({ state: 'ready', receipt: next })}
              />
            ) : null}
            {sources && receipt.status === 'extracted' ? (
              <Correct
                key={receipt.readings.map((r) => r.model + r.state).join()}
                receipt={receipt}
                onCorrected={(next) => setLoad({ state: 'ready', receipt: next })}
              />
            ) : receipt.confirmation ? (
              <Filed confirmation={receipt.confirmation} />
            ) : null}
            {receipt.readings.length > 0 ? (
              <Comparison receipt={receipt} sources={sources} journeys={journeys} />
            ) : null}
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => void readAgain()}
                disabled={busy || (reading && !stale)}
                className="rounded-lg border border-rule px-4 py-2 text-sm font-semibold disabled:opacity-60"
              >
                {busy ? 'Working…' : 'Read again'}
              </button>
              {receipt.expenseId ? (
                <Link
                  href={`/expenses/${receipt.expenseId}`}
                  className="tap text-sm font-semibold text-carbon underline"
                >
                  Its expense
                </Link>
              ) : null}
              <span className="text-xs text-ink-2">
                Added by {receipt.uploadedBy}, {showDateTime(receipt.createdAt)}
              </span>
            </div>
            {message ? (
              <p role="alert" className="text-sm text-warn">
                {message}
              </p>
            ) : null}
            <Original receipt={receipt} />
          </>
        ) : null}
      </main>
    </div>
  );
}

function Verdict({ receipt, stale }: { receipt: ReceiptDetail; stale: boolean }) {
  const status = RECEIPT_STATUS[receipt.status];
  const fallback = receipt.readings.find((r) => r.role === 'fallback');
  const checks = describeChecks(receipt.readings);
  // Under the organization's AI model settings: one model reads, a back-up only if it can't.
  const settings = underSettings(receipt.readings);
  const reader = receipt.readings.find((r) => r.fields);
  const primary = receipt.readings.find((r) => r.role === 'primary');
  let text: string;
  if (receipt.status === 'processing') {
    text = stale
      ? 'This is taking longer than it should. Try reading it again.'
      : settings && primary
        ? `${primary.label} is reading it. This takes a few seconds.`
        : 'Both models are reading it. This takes a few seconds.';
  } else if (receipt.status === 'extracted' && receipt.confirmation?.model === 'none') {
    text = `${receipt.confirmation.by} filled it in by hand.`;
  } else if (receipt.status === 'extracted' && receipt.confirmation) {
    const { by, label, corrections } = receipt.confirmation;
    const fixes = corrections.map((c) => FIELD_LABELS[c.field].toLowerCase());
    text = `${by} confirmed ${label}'s reading${
      fixes.length > 0
        ? `, correcting the ${new Intl.ListFormat('en', { type: 'conjunction' }).format(fixes)}`
        : ''
    }.`;
  } else if (receipt.status === 'extracted' && settings && reader) {
    text = `${reader.label} read it with confidence.`;
  } else if (receipt.status === 'extracted') {
    text = 'Both models read it with confidence and agree.';
  } else if (receipt.status === 'needs_review' && receipt.readings.length === 0) {
    text = 'Every AI model is switched off, so nothing read it. Fill it in below.';
  } else if (receipt.status === 'failed') {
    text = 'No model could read it. See why below.';
  } else if (receipt.duplicates.some((d) => d.held)) {
    text = receipt.duplicates.some((d) => d.held && d.kind === 'exact')
      ? 'It is a copy of another receipt. Decide below before it counts.'
      : 'It looks like the same purchase as another receipt. Decide below before it counts.';
  } else if (fallback?.fields) {
    text = [
      `Claude couldn't read it, so ${fallback.label} did. One reading, so check it before you rely on it.`,
      ...checks,
    ].join(' ');
  } else if (settings && reader?.role === 'backup' && primary) {
    text = [
      `${primary.label} couldn't read it, so ${reader.label} did, as a back-up.`,
      ...(checks.length > 0 ? checks : [`${reader.label} wasn't sure of it.`]),
    ].join(' ');
  } else if (settings && reader && checks.length === 0) {
    text = `${reader.label} wasn't sure of it.`;
  } else if (receipt.differences.length > 0) {
    text = [`The models disagree on ${receipt.differences.join(', ')}.`, ...checks].join(' ');
  } else if (checks.length > 0) {
    text = checks.join(' ');
  } else {
    text = 'At least one model was unsure or could not read it.';
  }
  return (
    <p role="status" className="rounded-xl border border-rule bg-sheet px-4 py-3 text-sm">
      {/* "Reading…" already ends the sentence. */}
      <span className={`font-semibold ${status.tone}`}>
        {status.label.endsWith('…') ? status.label : `${status.label}.`}
      </span>{' '}
      {text}
    </p>
  );
}

interface Resolution {
  outcome: 'kept_both' | 'deleted' | 'merged';
  kept: string;
  deleted: string | null;
  taken: MergeField[];
}

const RESOLVED: Record<Resolution['outcome'], string> = {
  kept_both: 'Kept both: they won’t be flagged as duplicates again.',
  deleted: 'Deleted the duplicate, its file and its expense.',
  merged: 'Merged, and deleted the receipt merged in.',
};

const MERGE_LABELS: Record<MergeField, string> = {
  merchant: 'Merchant',
  date: 'Date',
  amount: 'Amount',
  notes: 'Notes',
  trip: 'Trip',
};

/** A date as it reads everywhere (Sep 30, 2026); text that is not a date stays as it is. */
const dateText = (value: string) => (isIsoDate(value) ? showDate(value) : value);

/** A field of a duplicate's expense as text; null when it has none. */
function shown(side: DuplicateSide, field: MergeField): string | null {
  switch (field) {
    case 'merchant':
      return side.merchant;
    case 'date':
      return side.date && dateText(side.date);
    case 'amount':
      return side.amount ? formatMoney(side.amount) : null;
    case 'notes':
      return side.notes;
    case 'trip':
      return side.trip?.name ?? null;
  }
}

const added = (side: DuplicateSide) => `${showDateTime(side.createdAt)}, by ${side.source}`;

type Which = 'self' | 'other';

/**
 * Another receipt that is the same purchase (FR-INT-18, ADR-0028, ADR-0031), side by side
 * with this one, and what the person decides. An exact copy is deleted with one tap; a
 * possible one can replace the earlier receipt; either can be kept, deleted or merged.
 * Deleting one of the person's choosing goes with its file and expense, so it asks first.
 */
function Duplicate({
  pair,
  onDecided,
}: {
  pair: PossibleDuplicate;
  onDecided: (result: Resolution, note?: string) => void;
}) {
  const { self, other, held, kind } = pair;
  const sides: Record<Which, DuplicateSide> = { self, other };
  // The later copy is the one held; the earlier is the one to keep, unless it is locked.
  const copy: Which = held ? 'self' : 'other';
  const original: Which = held ? 'other' : 'self';
  const [mode, setMode] = useState<'choose' | 'delete' | 'merge'>('choose');
  const [allChoices, setAllChoices] = useState(kind === 'possible');
  const [doomed, setDoomed] = useState<Which>(copy);
  const [primary, setPrimary] = useState<Which>(isLocked(sides[copy]) ? copy : original);
  const [fields, setFields] = useState<MergeField[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const name: Record<Which, string> = { self: 'This receipt', other: 'The other receipt' };
  const kept = sides[primary];
  const mergedIn = sides[primary === 'self' ? 'other' : 'self'];
  const fills = MERGE_FIELDS.filter((f) => shown(kept, f) === null && shown(mergedIn, f) !== null);
  const choices = MERGE_FIELDS.filter((f) => {
    const mine = shown(kept, f);
    const theirs = shown(mergedIn, f);
    return mine !== null && theirs !== null && mine !== theirs;
  });
  const mergeable = (which: Which) =>
    sides[which].expenseStatus === 'needs_review' || sides[which].expenseStatus === 'ready';

  async function decide(body: Record<string, unknown>, note?: string) {
    setBusy(true);
    setError(null);
    try {
      onDecided(
        await api<Resolution>(`/v1/receipts/${self.receiptId}/duplicates/${other.receiptId}`, {
          method: 'POST',
          body: JSON.stringify(body),
        }),
        note,
      );
    } catch (e) {
      setError(describeError(e));
      setBusy(false);
    }
  }

  const keep = (which: Which) => sides[which === 'self' ? 'other' : 'self'].receiptId;
  // One tap, keeping the earlier receipt; it takes any note or trip only the copy has.
  const deleteCopy = () =>
    void decide(
      mergeable(original)
        ? { action: 'merge', primary: sides[original].receiptId, fields: [] }
        : { action: 'delete', keep: sides[original].receiptId },
      'Deleted the copy, its file and its expense.',
    );
  // The later receipt stays, as for an amended one, taking any note or trip it lacks.
  const replaceEarlier = () =>
    void decide(
      { action: 'merge', primary: sides[copy].receiptId, fields: [] },
      'Replaced the earlier receipt with this one.',
    );
  const totalsDiffer = shown(self, 'amount') !== shown(other, 'amount');
  const intro =
    kind === 'exact'
      ? held
        ? 'This is a copy of an earlier receipt: the same merchant, day, time and total.'
        : 'A later receipt is a copy of this one: the same merchant, day, time and total.'
      : `${held ? 'This looks like the same purchase as an earlier receipt' : 'A later receipt looks like the same purchase as this one'}${totalsDiffer ? ', with another total, as when a tip is added or a receipt amended' : ''}.`;
  const choice = (
    group: string,
    value: Which,
    current: Which,
    set: (w: Which) => void,
    disabled: boolean,
    note?: string,
  ) => (
    <label key={value} className="flex min-h-11 items-center gap-2">
      <input
        type="radio"
        name={`${group}-${other.receiptId}`}
        value={value}
        checked={current === value}
        disabled={disabled}
        onChange={() => set(value)}
      />
      <span>
        {name[value]}
        {note ? <span className="block text-xs text-ink-2">{note}</span> : null}
      </span>
    </label>
  );

  return (
    <section
      aria-labelledby={`duplicate-${other.receiptId}`}
      className="flex flex-col gap-3 rounded-xl border border-rule bg-sheet p-4 text-sm"
    >
      <h2 id={`duplicate-${other.receiptId}`} className="text-base font-semibold">
        {kind === 'exact' ? 'Duplicate' : 'Possible duplicate'}
      </h2>
      <p>{intro} It stays out of your totals until you decide.</p>
      <table className="w-full table-fixed">
        <caption className="sr-only">This receipt and the other, side by side</caption>
        <thead>
          <tr className="text-left">
            <th scope="col" className="w-1/4 pb-2 text-xs font-medium text-ink-2">
              <span className="sr-only">Field</span>
            </th>
            <th scope="col" className="pb-2 font-semibold">
              This receipt
            </th>
            <th scope="col" className="pb-2 font-semibold">
              <Link href={`/receipts/${other.receiptId}`} className="tap text-carbon underline">
                The other
              </Link>
            </th>
          </tr>
        </thead>
        <tbody>
          {MERGE_FIELDS.map((field) => {
            const mine = shown(self, field);
            const theirs = shown(other, field);
            const differs = mine !== theirs;
            return (
              <tr
                key={field}
                className={`border-t border-rule align-top ${differs ? 'bg-carbon-wash' : ''}`}
              >
                <th scope="row" className="py-2 text-left text-xs font-medium text-ink-2">
                  {MERGE_LABELS[field]}
                  {differs ? <span className="block text-warn">differs</span> : null}
                </th>
                {[mine, theirs].map((value, i) => (
                  <td key={i} className="py-2 pr-2 break-words">
                    {value === null ? (
                      <span className="text-ink-3">–</span>
                    ) : (
                      <span
                        className={
                          field === 'amount' || field === 'date'
                            ? 'whitespace-nowrap tabular-nums'
                            : ''
                        }
                      >
                        {value}
                      </span>
                    )}
                  </td>
                ))}
              </tr>
            );
          })}
          {(['Time', 'Place'] as const).map((label) => {
            const [mine, theirs] = [self, other].map((side) =>
              label === 'Time' ? side.time : placeOf(side),
            );
            const differs = mine !== theirs;
            return (
              <tr
                key={label}
                className={`border-t border-rule align-top ${differs ? 'bg-carbon-wash' : ''}`}
              >
                <th scope="row" className="py-2 text-left text-xs font-medium text-ink-2">
                  {label}
                  {differs ? <span className="block text-warn">differs</span> : null}
                </th>
                {[mine, theirs].map((value, i) => (
                  <td key={i} className="py-2 pr-2 break-words tabular-nums">
                    {value ?? <span className="text-ink-3">–</span>}
                  </td>
                ))}
              </tr>
            );
          })}
          <tr className="border-t border-rule align-top">
            <th scope="row" className="py-2 text-left text-xs font-medium text-ink-2">
              Added
            </th>
            {[self, other].map((side) => (
              <td key={side.receiptId} className="py-2 pr-2 text-xs text-ink-2">
                {added(side)}
              </td>
            ))}
          </tr>
        </tbody>
      </table>

      {mode === 'choose' && kind === 'exact' && !isLocked(sides[copy]) ? (
        <p className="text-xs text-ink-2">
          Delete the copy keeps the earlier receipt, which takes any note or trip only the copy has.
        </p>
      ) : null}
      {mode === 'choose' && kind === 'possible' && mergeable(copy) && !isLocked(sides[original]) ? (
        <p className="text-xs text-ink-2">
          Replace keeps the later receipt, as for an amended one, and deletes the earlier; any note
          or trip only the earlier has moves across.
        </p>
      ) : null}
      {mode === 'choose' ? (
        <div className="flex flex-wrap gap-2">
          {kind === 'exact' && !isLocked(sides[copy]) ? (
            <button
              type="button"
              onClick={deleteCopy}
              disabled={busy}
              className="rounded-lg bg-bad px-3 py-2 text-sm font-semibold text-paper disabled:opacity-60"
            >
              {busy ? 'Deleting…' : 'Delete the copy'}
            </button>
          ) : null}
          {kind === 'possible' && mergeable(copy) && !isLocked(sides[original]) ? (
            <button
              type="button"
              onClick={replaceEarlier}
              disabled={busy}
              className="rounded-lg bg-carbon px-3 py-2 text-sm font-semibold text-carbon-ink disabled:opacity-60"
            >
              {busy ? 'Replacing…' : 'Replace the earlier one'}
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => void decide({ action: 'keep_both' })}
            disabled={busy}
            className="rounded-lg border border-rule px-3 py-2 text-sm font-semibold disabled:opacity-60"
          >
            Keep both
          </button>
          {allChoices ? (
            <>
              <button
                type="button"
                onClick={() => setMode('delete')}
                disabled={busy}
                className="rounded-lg border border-rule px-3 py-2 text-sm font-semibold text-bad disabled:opacity-60"
              >
                Delete one
              </button>
              <button
                type="button"
                onClick={() => setMode('merge')}
                disabled={busy}
                className="rounded-lg border border-rule px-3 py-2 text-sm font-semibold disabled:opacity-60"
              >
                Merge
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setAllChoices(true)}
              disabled={busy}
              className="rounded-lg border border-rule px-3 py-2 text-sm font-semibold disabled:opacity-60"
            >
              Other choices
            </button>
          )}
        </div>
      ) : null}

      {mode === 'delete' ? (
        <div className="flex flex-col gap-3">
          <fieldset className="flex flex-col">
            <legend className="mb-1 text-xs font-medium text-ink-2">Delete</legend>
            {(['self', 'other'] as const).map((which) =>
              choice(
                'delete',
                which,
                doomed,
                setDoomed,
                isLocked(sides[which]),
                isLocked(sides[which]) ? 'Its expense is submitted, so it stays.' : undefined,
              ),
            )}
          </fieldset>
          <p>
            Delete {name[doomed].toLowerCase()}? Its file, readings and expense go too, and this
            can’t be undone. The audit trail keeps a note of what it was.
          </p>
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              onClick={() => void decide({ action: 'delete', keep: keep(doomed) })}
              disabled={busy || isLocked(sides[doomed])}
              className="rounded-lg bg-bad px-4 py-2 text-sm font-semibold text-paper disabled:opacity-60"
            >
              {busy ? 'Deleting…' : `Delete ${name[doomed].toLowerCase()}`}
            </button>
            <button
              type="button"
              onClick={() => setMode('choose')}
              disabled={busy}
              className="rounded-lg border border-rule px-4 py-2 text-sm font-semibold"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {mode === 'merge' ? (
        <div className="flex flex-col gap-3">
          <fieldset className="flex flex-col">
            <legend className="mb-1 text-xs font-medium text-ink-2">Keep</legend>
            {(['self', 'other'] as const).map((which) =>
              choice(
                'primary',
                which,
                primary,
                (w) => {
                  setPrimary(w);
                  setFields([]);
                },
                !mergeable(which),
                mergeable(which) ? undefined : 'Its expense can’t be changed now.',
              ),
            )}
          </fieldset>
          <p>
            {name[primary]} stays, and takes what it lacks from the other
            {fills.length > 0
              ? ` (${fills.map((f) => MERGE_LABELS[f].toLowerCase()).join(', ')})`
              : ''}
            . The other is then deleted with its file, and this can’t be undone.
          </p>
          {choices.length > 0 ? (
            <fieldset className="flex flex-col">
              <legend className="mb-1 text-xs font-medium text-ink-2">
                Also take from the other
              </legend>
              {choices.map((field) => (
                <label key={field} className="flex min-h-11 items-center gap-2">
                  <input
                    type="checkbox"
                    checked={fields.includes(field)}
                    onChange={(e) =>
                      setFields(
                        e.target.checked ? [...fields, field] : fields.filter((f) => f !== field),
                      )
                    }
                  />
                  <span className="break-words">
                    {MERGE_LABELS[field]}: {shown(mergedIn, field)}
                  </span>
                </label>
              ))}
            </fieldset>
          ) : null}
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              onClick={() => void decide({ action: 'merge', primary: kept.receiptId, fields })}
              disabled={busy || !mergeable(primary)}
              className="rounded-lg bg-carbon px-4 py-2 text-sm font-semibold text-carbon-ink disabled:opacity-60"
            >
              {busy ? 'Merging…' : 'Merge and delete the other'}
            </button>
            <button
              type="button"
              onClick={() => setMode('choose')}
              disabled={busy}
              className="rounded-lg border border-rule px-4 py-2 text-sm font-semibold"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-warn">
          {error}
        </p>
      ) : null}
    </section>
  );
}

const MONEY_FIELDS: CorrectableField[] = ['total', 'taxTotal', 'tip'];

/** What a confirmed receipt is filed with; a corrected field shows what was read. */
function Filed({ confirmation }: { confirmation: NonNullable<ReceiptDetail['confirmation']> }) {
  const { values, corrections } = confirmation;
  const shown: [CorrectableField, string | null][] = [
    ['merchant', values.merchant],
    ['date', values.date && dateText(values.date)],
    ['total', values.total ? formatMoney(values.total) : null],
    ['taxTotal', values.taxTotal ? formatMoney(values.taxTotal) : null],
    ['tip', values.tip ? formatMoney(values.tip) : null],
  ];
  return (
    <section
      aria-labelledby="filed-title"
      className="rounded-xl border border-rule bg-sheet p-4 text-sm"
    >
      <h2 id="filed-title" className="mb-2 text-base font-semibold">
        Filed as
      </h2>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
        {shown.map(([field, value]) => {
          const fix = corrections.find((c) => c.field === field);
          return (
            <div key={field} className="contents">
              <dt className="text-xs font-medium text-ink-2">{FIELD_LABELS[field]}</dt>
              <dd className="flex flex-col">
                <span className="tabular-nums">{value ?? '–'}</span>
                {fix ? (
                  <span className="text-xs text-ink-2">
                    {fix.read === null
                      ? 'entered by hand'
                      : `corrected; read as ${
                          MONEY_FIELDS.includes(field)
                            ? formatMoney({ decimal: fix.read, currency: values.currency })
                            : field === 'date'
                              ? dateText(fix.read)
                              : fix.read
                        }`}
                  </span>
                ) : null}
              </dd>
            </div>
          );
        })}
      </dl>
    </section>
  );
}

/** The values a person can confirm or correct, as text, from one reading. */
function draftOf(reading: Reading | undefined): Record<CorrectableField, string> {
  const f = reading?.fields;
  return {
    merchant: f?.merchant?.value ?? '',
    date: f?.date?.value ?? '',
    currency: f?.currency?.value ?? f?.total?.currency ?? '',
    total: f?.total?.decimal ?? '',
    taxTotal: f?.taxTotal?.decimal ?? '',
    tip: f?.tip?.decimal ?? '',
  };
}

const FILED_FIELDS: CorrectableField[] = [
  'merchant',
  'date',
  'currency',
  'total',
  'taxTotal',
  'tip',
];

/** How to type each field when correcting it. */
const FIELD_INPUT: Record<CorrectableField, Record<string, string | number>> = {
  merchant: { autoComplete: 'off', maxLength: 200 },
  date: { type: 'date' },
  currency: { maxLength: 3, autoCapitalize: 'characters', autoComplete: 'off' },
  total: { inputMode: 'decimal', autoComplete: 'off' },
  taxTotal: { inputMode: 'decimal', autoComplete: 'off' },
  tip: { inputMode: 'decimal', autoComplete: 'off' },
};

/**
 * What a Ready receipt is filed with, each field beside the line of the receipt it was read
 * from, and one tap to correct it (GAP-14). The correction changes its expense too, so it waits
 * for the expense: once that is submitted it is locked, and correcting an approved one is a
 * reversal, which isn't built yet.
 */
function Correct({
  receipt,
  onCorrected,
}: {
  receipt: ReceiptDetail;
  onCorrected: (receipt: ReceiptDetail) => void;
}) {
  const { confirmation } = receipt;
  // The reading it is filed with: the one confirmed, else the most capable that read it.
  const reading = confirmation
    ? receipt.readings.find((r) => r.model === confirmation.model)
    : ([...receipt.readings].reverse().find((r) => r.role === 'compared' && r.fields) ??
      receipt.readings.find((r) => r.fields));
  const filed: Record<CorrectableField, string> = confirmation
    ? {
        merchant: confirmation.values.merchant,
        date: confirmation.values.date,
        currency: confirmation.values.currency,
        total: confirmation.values.total?.decimal ?? '',
        taxTotal: confirmation.values.taxTotal?.decimal ?? '',
        tip: confirmation.values.tip?.decimal ?? '',
      }
    : draftOf(reading);
  const [editable, setEditable] = useState<boolean | null>(null);
  const [editing, setEditing] = useState<CorrectableField | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!receipt.expenseId) return;
    let live = true;
    void api<{ editable: boolean }>(`/v1/expenses/${receipt.expenseId}`)
      .then((expense) => live && setEditable(expense.editable))
      .catch(() => live && setEditable(null));
    return () => {
      live = false;
    };
  }, [receipt.expenseId]);

  const shown = (field: CorrectableField) => {
    const value = filed[field];
    if (value === '') return null;
    if (field === 'date') return dateText(value);
    return MONEY_FIELDS.includes(field)
      ? formatMoney({ decimal: value, currency: filed.currency })
      : value;
  };

  function start(field: CorrectableField) {
    setEditing(field);
    setDraft(filed[field]);
    setError(null);
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!editing) return;
    setBusy(true);
    setError(null);
    try {
      onCorrected(
        await api<ReceiptDetail>(`/v1/receipts/${receipt.id}/corrections`, {
          method: 'POST',
          body: JSON.stringify({ corrections: { [editing]: draft.trim() } }),
        }),
      );
      setEditing(null);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      aria-labelledby="filed-title"
      className="flex flex-col gap-3 rounded-xl border border-rule bg-sheet p-4 text-sm"
    >
      <h2 id="filed-title" className="text-base font-semibold">
        Filed as
      </h2>
      {editable === false ? (
        <p className="text-xs text-ink-2">
          Its expense is submitted, so these are locked. Correcting an approved expense is a
          reversal, which isn’t built yet.
        </p>
      ) : (
        <p className="text-xs text-ink-2">
          Something read wrong? Correct it with a tap; its expense changes too, and what the model
          read is kept.
        </p>
      )}
      <dl className="flex flex-col divide-y divide-rule">
        {FILED_FIELDS.map((field) => {
          const fix = confirmation?.corrections.find((c) => c.field === field);
          const source = reading?.sources?.[field] ?? null;
          const label = FIELD_LABELS[field];
          return (
            <div key={field} className="flex flex-col gap-1 py-2">
              <dt className="text-xs font-medium text-ink-2">{label}</dt>
              <dd className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 flex-1 flex-col">
                  {editing === field ? (
                    <form onSubmit={(e) => void save(e)} className="flex flex-col gap-2">
                      <label className="flex flex-col gap-1 text-xs font-medium text-ink-2">
                        {`${label}, corrected`}
                        <input
                          name={field}
                          value={draft}
                          onChange={(e) => setDraft(e.target.value)}
                          required={field !== 'taxTotal' && field !== 'tip'}
                          className="rounded-lg border border-rule bg-paper px-3 py-2 text-base text-ink"
                          {...FIELD_INPUT[field]}
                        />
                      </label>
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="submit"
                          disabled={busy}
                          className="rounded-lg bg-carbon px-4 py-2 text-sm font-semibold text-carbon-ink disabled:opacity-60"
                        >
                          {busy ? 'Saving…' : 'Save'}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setEditing(null);
                            setError(null);
                          }}
                          disabled={busy}
                          className="rounded-lg border border-rule px-4 py-2 text-sm font-semibold"
                        >
                          Cancel
                        </button>
                      </div>
                    </form>
                  ) : (
                    <span className="tabular-nums break-words">{shown(field) ?? '–'}</span>
                  )}
                  {source ? <SourceLine line={source} /> : null}
                  {fix ? (
                    <span className="text-xs text-ink-2">
                      {fix.read === null
                        ? 'entered by hand'
                        : `corrected; read as ${
                            MONEY_FIELDS.includes(field)
                              ? formatMoney({ decimal: fix.read, currency: filed.currency })
                              : fix.read
                          }`}
                    </span>
                  ) : null}
                </div>
                {editable && editing !== field ? (
                  <button
                    type="button"
                    onClick={() => start(field)}
                    disabled={busy}
                    aria-label={`Correct the ${label.toLowerCase()}`}
                    className="min-h-11 shrink-0 rounded-lg border border-rule px-3 text-xs font-semibold"
                  >
                    Correct
                  </button>
                ) : null}
              </dd>
            </div>
          );
        })}
      </dl>
      {error ? (
        <p role="alert" className="text-sm text-warn">
          {error}
        </p>
      ) : null}
    </section>
  );
}

const REQUIRED: CorrectableField[] = ['merchant', 'date', 'currency', 'total'];

/**
 * Looks right / Edit a field (FR-INT-15): the next step for a receipt that needs a look.
 * Either files it as Ready with the chosen reading, corrected where the person changed it.
 */
function Review({
  receipt,
  onConfirmed,
}: {
  receipt: ReceiptDetail;
  onConfirmed: (receipt: ReceiptDetail) => void;
}) {
  const choices = receipt.readings.filter((r) => r.fields);
  // Start from the reading the headline shows: the most capable compared model, else fallback.
  const preferred =
    [...choices].reverse().find((r) => r.role === 'compared') ?? choices[0] ?? undefined;
  // With no reading to start from, any model's failed reading stands in: every field is typed.
  const [model, setModel] = useState(preferred?.model ?? receipt.readings[0]?.model ?? '');
  const chosen = choices.find((r) => r.model === model);
  const [editing, setEditing] = useState(choices.length === 0);
  const [draft, setDraft] = useState(() => draftOf(chosen));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const read = draftOf(chosen);
  const missing = REQUIRED.filter((f) => read[f] === '');

  function choose(next: string) {
    setModel(next);
    setDraft(draftOf(choices.find((r) => r.model === next)));
    setError(null);
  }

  async function confirm(corrections: Partial<Record<CorrectableField, string>>) {
    setBusy(true);
    setError(null);
    try {
      onConfirmed(
        await api<ReceiptDetail>(`/v1/receipts/${receipt.id}/confirm`, {
          method: 'POST',
          // With nothing read (every AI model off), no model is named: every field is typed.
          body: JSON.stringify({ model: chosen?.model ?? (model || undefined), corrections }),
        }),
      );
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  function save(event: FormEvent) {
    event.preventDefault();
    const changed = Object.fromEntries(
      (Object.keys(draft) as CorrectableField[])
        .filter((f) => draft[f].trim() !== read[f])
        .map((f) => [f, draft[f].trim()]),
    );
    void confirm(changed);
  }

  const input = (field: CorrectableField, extra: Record<string, string | number> = {}) => (
    <label key={field} className="flex flex-col gap-1 text-xs font-medium text-ink-2">
      {FIELD_LABELS[field]}
      <input
        name={field}
        value={draft[field]}
        onChange={(e) => setDraft({ ...draft, [field]: e.target.value })}
        required={REQUIRED.includes(field)}
        className="rounded-lg border border-rule bg-paper px-3 py-2 text-base text-ink"
        {...extra}
      />
    </label>
  );

  return (
    <section
      aria-labelledby="review-title"
      className="flex flex-col gap-3 rounded-xl border border-rule bg-sheet p-4"
    >
      <h2 id="review-title" className="text-base font-semibold">
        Is this right?
      </h2>
      {choices.length > 1 ? (
        <fieldset className="flex flex-wrap gap-x-4 gap-y-2 text-sm">
          <legend className="mb-1 text-xs font-medium text-ink-2">Use the reading from</legend>
          {choices.map((r) => (
            <label key={r.model} className="flex min-h-11 items-center gap-2">
              <input
                type="radio"
                name="reading"
                value={r.model}
                checked={r.model === model}
                onChange={() => choose(r.model)}
              />
              {r.label}
            </label>
          ))}
        </fieldset>
      ) : chosen ? (
        <p className="text-xs text-ink-2">From {chosen.label}&apos;s reading, shown below.</p>
      ) : (
        <p className="text-xs text-ink-2">No model read it, so enter the details yourself.</p>
      )}

      {editing ? (
        <form onSubmit={save} className="flex flex-col gap-3">
          {input('merchant', { autoComplete: 'off', maxLength: 200 })}
          <div className="grid grid-cols-2 gap-3">
            {input('date', { type: 'date' })}
            {input('currency', { maxLength: 3, autoCapitalize: 'characters', autoComplete: 'off' })}
          </div>
          <div className="grid grid-cols-3 gap-3">
            {input('total', { inputMode: 'decimal', autoComplete: 'off' })}
            {input('taxTotal', { inputMode: 'decimal', autoComplete: 'off' })}
            {input('tip', { inputMode: 'decimal', autoComplete: 'off' })}
          </div>
          <div className="flex flex-wrap gap-3">
            <button
              type="submit"
              disabled={busy}
              className="rounded-lg bg-carbon px-4 py-2 text-sm font-semibold text-carbon-ink disabled:opacity-60"
            >
              {busy ? 'Saving…' : 'Save and file'}
            </button>
            {choices.length > 0 ? (
              <button
                type="button"
                onClick={() => {
                  setEditing(false);
                  setDraft(draftOf(chosen));
                  setError(null);
                }}
                className="rounded-lg border border-rule px-4 py-2 text-sm font-semibold"
              >
                Cancel
              </button>
            ) : null}
          </div>
        </form>
      ) : (
        <>
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              onClick={() => void confirm({})}
              disabled={busy || missing.length > 0}
              className="rounded-lg bg-carbon px-4 py-2 text-sm font-semibold text-carbon-ink disabled:opacity-60"
            >
              {busy ? 'Saving…' : 'Looks right'}
            </button>
            <button
              type="button"
              onClick={() => setEditing(true)}
              disabled={busy}
              className="rounded-lg border border-rule px-4 py-2 text-sm font-semibold"
            >
              Edit a field
            </button>
          </div>
          {missing.length > 0 ? (
            <p className="text-xs text-warn">
              {chosen?.label ?? 'The reading'} has no{' '}
              {missing.map((f) => FIELD_LABELS[f].toLowerCase()).join(', ')}. Enter it with Edit a
              field.
            </p>
          ) : null}
        </>
      )}
      {error ? (
        <p role="alert" className="text-sm text-warn">
          {error}
        </p>
      ) : null}
    </section>
  );
}

/** The line a field was read from; the document type, journey and stay have none. */
const sourceOf = (sources: FieldSources | null | undefined, key: keyof Fields) =>
  sources && key in sources ? sources[key as keyof FieldSources] : null;

const isMoney = (v: unknown): v is MoneyField =>
  typeof v === 'object' && v !== null && 'decimal' in v;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function Value({
  value,
  source,
}: {
  value: TextField | MoneyField | string | null | undefined;
  /** The line of the receipt it was read from, where that was asked for (GAP-14). */
  source?: string | null;
}) {
  if (value === null || value === undefined) return <span className="text-ink-3">–</span>;
  if (typeof value === 'string') return <span>{value.replaceAll('_', ' ')}</span>;
  const text = isMoney(value) ? formatMoney(value) : value.value;
  return (
    <span className="flex flex-col">
      {/* Dates and amounts stay on one line; a date split at a hyphen reads as two values. */}
      <span
        className={`tabular-nums ${isMoney(value) || ISO_DATE.test(text) ? 'whitespace-nowrap' : ''}`}
      >
        {text}
      </span>
      {isMoney(value) && value.assumed ? (
        <span className="text-xs text-ink-2">not on receipt</span>
      ) : value.confidence === 'high' ? null : (
        <span className="text-xs text-warn">{value.confidence} confidence</span>
      )}
      {source ? <SourceLine line={source} /> : null}
    </span>
  );
}

/**
 * The line of the receipt a value was read from, as the model copied it. Text, not a mark on
 * the image: the models say what the line says, not where it is (GAP-14).
 */
function SourceLine({ line }: { line: string }) {
  return (
    <span className="font-mono text-xs break-words text-ink-2">
      <span className="sr-only">Read from the line </span>“{line}”
    </span>
  );
}

function Comparison({
  receipt,
  sources,
  journeys,
}: {
  receipt: ReceiptDetail;
  sources: boolean;
  journeys: boolean;
}) {
  const { readings } = receipt;
  const rows = journeys
    ? [...ROWS, ...JOURNEY_ROWS.filter((row) => readings.some((r) => r.fields?.[row.key]))]
    : ROWS;
  const cell = (r: Reading, content: ReactNode) =>
    r.state === 'pending' ? <span className="text-ink-3">…</span> : content;
  return (
    <section
      aria-labelledby="readings-title"
      className="rounded-xl border border-rule bg-sheet p-4"
    >
      <h2 id="readings-title" className="sr-only">
        What each model read
      </h2>
      {/* Dates stay exactly as each model read them, so a difference shows (NFR-UX-06). */}
      <table data-as-read className="w-full table-fixed text-sm">
        <caption className="sr-only">Each model&apos;s reading, side by side</caption>
        <thead>
          <tr className="text-left">
            {/* With a third reading, the labels give up room so a date fits on one line. */}
            <th
              scope="col"
              className={`${readings.length > 2 ? 'w-1/5' : 'w-1/4'} pb-2 text-xs font-medium text-ink-2`}
            >
              <span className="sr-only">Field</span>
            </th>
            {readings.map((r) => (
              <th key={r.model} scope="col" className="pb-2 font-semibold">
                {r.label}
                {r.role === 'fallback' || r.role === 'backup' ? (
                  <span className="block text-xs font-normal text-ink-2">
                    {r.role === 'backup' ? 'back-up' : 'fallback'}
                  </span>
                ) : null}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {readings.some((r) => r.state === 'failed' || r.state === 'missing') ? (
            <tr className="border-t border-rule align-top">
              <th scope="row" className="py-2 text-left text-xs font-medium text-ink-2">
                Problem
              </th>
              {readings.map((r) => (
                <td key={r.model} className="py-2 pr-2 text-xs text-warn">
                  {r.state === 'failed' || r.state === 'missing'
                    ? describeReadingError(r.error, providerOf(r))
                    : ''}
                </td>
              ))}
            </tr>
          ) : null}
          {rows.map((row) => {
            const differs = row.filing !== undefined && receipt.differences.includes(row.filing);
            return (
              <tr
                key={row.key}
                className={`border-t border-rule align-top ${differs ? 'bg-carbon-wash' : ''}`}
              >
                <th scope="row" className="py-2 text-left text-xs font-medium text-ink-2">
                  {row.label}
                  {differs ? <span className="block text-warn">differs</span> : null}
                </th>
                {readings.map((r) => (
                  <td key={r.model} className="py-2 pr-2 break-words">
                    {cell(
                      r,
                      <Value
                        value={r.fields?.[row.key]}
                        source={sources ? sourceOf(r.sources, row.key) : null}
                      />,
                    )}
                  </td>
                ))}
              </tr>
            );
          })}
          <tr className="border-t border-rule">
            <th scope="row" className="py-2 text-left text-xs font-medium text-ink-2">
              Read in
            </th>
            {readings.map((r) => (
              <td key={r.model} className="py-2 tabular-nums">
                {cell(r, formatSeconds(r.latencyMs))}
              </td>
            ))}
          </tr>
          <tr className="border-t border-rule">
            <th scope="row" className="py-2 text-left text-xs font-medium text-ink-2">
              Cost
            </th>
            {readings.map((r) => (
              <td key={r.model} className="py-2 tabular-nums">
                {cell(r, formatCost(r.costMicroUsd))}
              </td>
            ))}
          </tr>
        </tbody>
      </table>
    </section>
  );
}

function Original({ receipt }: { receipt: ReceiptDetail }) {
  if (!receipt.imageUrl) return null;
  if (receipt.contentType === 'application/pdf') {
    return (
      <a
        href={receipt.imageUrl}
        target="_blank"
        rel="noreferrer"
        className="text-sm text-carbon underline"
      >
        Open the original PDF
      </a>
    );
  }
  return (
    <figure className="flex flex-col gap-1">
      {/* A short-lived signed link to a private file; next/image can't cache it usefully. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={receipt.imageUrl}
        alt={`The original receipt${receipt.merchant ? ` from ${receipt.merchant}` : ''}`}
        className="w-full rounded-xl border border-rule"
      />
      <figcaption className="text-xs text-ink-2">The original, as uploaded.</figcaption>
    </figure>
  );
}
