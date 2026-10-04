'use client';

import { journeyLine, showDate, stayLine } from '@expensewise/domain';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { api, ApiProblem } from '../../../lib/api';
import {
  categoryText,
  indented,
  type Catalog,
  type ExpenseCategory,
} from '../../../lib/categories';
import {
  DETAIL_LABELS,
  EXPENSE_FIELD_LABELS,
  EXPENSE_STATUS,
  placeOf,
  timeOf,
  timeZones,
  TRAVEL_LABELS,
  travelOf,
  type DetailField,
  type ExpenseDetail,
  type ExpenseField,
  type Journey,
  type Stay,
  type TravelField,
} from '../../../lib/expenses';
import { useFeatures } from '../../../lib/features';
import { describeRate, distanceOf, MILEAGE_FLAG, type MileageEntry } from '../../../lib/mileage';
import { ROUTE_MILEAGE_FLAG } from '../../../lib/route-mileage';
import { formatMoney, RECEIPT_STATUS } from '../../../lib/receipts';
import { supabase } from '../../../lib/supabase';
import { tripDates, type TripSummary } from '../../../lib/trips';
import { HistoryLink } from '../../history-link';
import { MileageForm } from '../../mileage/mileage-form';
import { RouteDriveDetails } from '../../mileage/route-drive';

type Load =
  | { state: 'loading' }
  | { state: 'signed-out' }
  | { state: 'error'; message: string }
  | { state: 'ready'; expense: ExpenseDetail };

const describeError = (error: unknown) =>
  error instanceof ApiProblem
    ? [error.message, error.detail].filter(Boolean).join('. ')
    : 'Something went wrong. Try again.';

/** One expense: the claim, editable, beside its receipt, the proof (ADR-0022). */
export default function ExpensePage() {
  const { id } = useParams<{ id: string }>();
  const [load, setLoad] = useState<Load>({ state: 'loading' });

  const refresh = useCallback(async () => {
    const session = (await supabase()?.auth.getSession())?.data.session;
    if (!session) {
      setLoad({ state: 'signed-out' });
      return;
    }
    try {
      setLoad({ state: 'ready', expense: await api<ExpenseDetail>(`/v1/expenses/${id}`) });
    } catch (error) {
      setLoad({ state: 'error', message: describeError(error) });
    }
  }, [id]);

  useEffect(() => {
    // Loading reads the browser's session, so it can only start after mounting.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  const expense = load.state === 'ready' ? load.expense : null;
  const featureOn = useFeatures();
  // A drive is changed as mileage, which shows its purpose too (ADR-0038).
  const mileageShown = expense?.source === 'mileage' && featureOn(MILEAGE_FLAG);

  return (
    <div className="mx-auto flex w-full max-w-md flex-1 flex-col px-4 pt-[max(1rem,env(safe-area-inset-top))]">
      <header className="flex items-baseline justify-between py-3">
        <Link href="/expenses" className="tap text-sm font-semibold text-carbon">
          ← Expenses
        </Link>
        <HistoryLink entityType="expense" entityId={id} />
      </header>
      <main className="flex flex-1 flex-col gap-4 pb-8">
        <h1 className="text-2xl font-bold">{expense?.merchant ?? 'Expense'}</h1>
        {expense ? <Travel journey={expense.journey} stay={expense.stay} /> : null}
        {load.state === 'loading' ? <p className="text-sm text-ink-2">Loading…</p> : null}
        {load.state === 'signed-out' ? (
          <p className="text-sm">
            <Link href="/sign-in" className="font-semibold text-carbon underline">
              Sign in
            </Link>{' '}
            to see this expense.
          </p>
        ) : null}
        {load.state === 'error' ? (
          <p role="alert" className="text-sm text-warn">
            {load.message}
          </p>
        ) : null}
        {expense ? (
          <>
            <Verdict expense={expense} />
            {mileageShown ? (
              <Drive
                key={expense.updatedAt}
                expense={expense}
                onSaved={(next) => setLoad({ state: 'ready', expense: next })}
              />
            ) : (
              <Claim
                key={expense.updatedAt}
                expense={expense}
                onSaved={(next) => setLoad({ state: 'ready', expense: next })}
              />
            )}
            {/* Sent only while categories are switched on for the organization. */}
            {expense.category ? (
              <CategoryChoice
                key={`category-${expense.updatedAt}`}
                expense={expense}
                shown={expense.category}
                onSaved={(next) => setLoad({ state: 'ready', expense: next })}
              />
            ) : null}
            <TripChoice
              expense={expense}
              onSaved={(next) => setLoad({ state: 'ready', expense: next })}
            />
            {expense.local && !mileageShown ? (
              <Justification
                key={`${expense.id}-${expense.justification ?? ''}`}
                expense={expense}
                onSaved={(next) => setLoad({ state: 'ready', expense: next })}
              />
            ) : null}
            <Proof expense={expense} />
          </>
        ) : null}
      </main>
    </div>
  );
}

function Verdict({ expense }: { expense: ExpenseDetail }) {
  const status = EXPENSE_STATUS[expense.status];
  const proof = expense.proof;
  let text: string;
  let label = status.label;
  if (expense.source === 'mileage' && expense.status === 'processing') {
    // A drive by its route, being measured (ADR-0039).
    label = 'Measuring…';
    text = 'Its route is being measured. This takes a few seconds.';
  } else if (expense.source === 'mileage' && expense.status === 'needs_review') {
    text = 'Its route couldn’t be measured. Fix a stop and measure it again, or enter its miles.';
  } else if (expense.status === 'processing') {
    text = 'Its receipt is being read. This takes a few seconds.';
  } else if (expense.status === 'needs_review' && proof?.status === 'failed') {
    text = 'No model could read its receipt. Enter the details there, then this expense is Ready.';
  } else if (expense.status === 'needs_review' && proof && proof.status !== 'extracted') {
    text = 'Its receipt still needs a look. Confirm it there, then this expense is Ready.';
  } else if (expense.status === 'needs_review') {
    text = 'Fill in the merchant, date, currency and amount to make it Ready.';
  } else if (expense.status === 'ready') {
    text = proof
      ? 'Its receipt is Ready, and everything is filled in.'
      : 'Everything is filled in.';
  } else {
    text = 'It is on a report, so it can’t be edited here.';
  }
  return (
    <p role="status" className="rounded-xl border border-rule bg-sheet px-4 py-3 text-sm">
      {/* "Reading…" already ends the sentence. */}
      <span className={`font-semibold ${status.tone}`}>
        {label.endsWith('…') ? label : `${label}.`}
      </span>{' '}
      {text}
    </p>
  );
}

/**
 * Where a ride, flight or train went, and a hotel stay with its nights, in a line each under
 * the merchant: "SFO → ORD", "2 nights, Sep 29 – Oct 1, 2026" (FR-INT-20, FR-INT-21). Sent only
 * while Journeys and stays is on.
 */
function Travel({ journey, stay }: { journey?: Journey | null; stay?: Stay | null }) {
  const travel = travelOf(journey, stay);
  const went = journeyLine(travel);
  const stayed = stayLine(travel);
  if (!went && !stayed) return null;
  return (
    <div className="-mt-3 flex flex-col gap-0.5 text-sm text-ink-2">
      {went ? <p>{went}</p> : null}
      {stayed ? <p className={stay?.doubt ? 'text-warn' : undefined}>{stayed}</p> : null}
    </div>
  );
}

type Draft = Record<ExpenseField | DetailField | TravelField, string>;
const LABELS = { ...EXPENSE_FIELD_LABELS, ...DETAIL_LABELS, ...TRAVEL_LABELS };
const draftOf = (e: ExpenseDetail): Draft => ({
  merchant: e.merchant ?? '',
  date: e.date ?? '',
  currency: e.amount?.currency ?? '',
  amount: e.amount?.decimal ?? '',
  time: e.time ?? '',
  timeZone: e.timeZone ?? '',
  address: e.address ?? '',
  city: e.city ?? '',
  region: e.region ?? '',
  country: e.country ?? '',
  // Blank while Journeys and stays is off, so never sent.
  journeyFrom: e.journey?.from ?? '',
  journeyTo: e.journey?.to ?? '',
  checkIn: e.stay?.checkIn ?? '',
  checkOut: e.stay?.checkOut ?? '',
});

/** What the expense claims. Editable while it needs a look or is Ready (FR-EXP-09). */
function Claim({
  expense,
  onSaved,
}: {
  expense: ExpenseDetail;
  onSaved: (expense: ExpenseDetail) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Draft>(() => draftOf(expense));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shown = draftOf(expense);
  const differs = new Set(expense.proof?.differences ?? []);
  const detailDiffers = new Set(expense.proof?.detailDifferences ?? []);

  async function save(event: FormEvent) {
    event.preventDefault();
    const changed = Object.fromEntries(
      (Object.keys(draft) as (keyof Draft)[])
        .filter((f) => draft[f].trim() !== shown[f])
        .map((f) => [f, draft[f].trim()]),
    );
    if (Object.keys(changed).length === 0) {
      setEditing(false);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      onSaved(
        await api<ExpenseDetail>(`/v1/expenses/${expense.id}`, {
          method: 'PATCH',
          body: JSON.stringify(changed),
        }),
      );
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  const input = (field: keyof Draft, extra: Record<string, string | number> = {}) => (
    <label className="flex flex-col gap-1 text-xs font-medium text-ink-2">
      {LABELS[field]}
      <input
        name={field}
        value={draft[field]}
        onChange={(e) => setDraft({ ...draft, [field]: e.target.value })}
        className="rounded-lg border border-rule bg-paper px-3 py-2 text-base text-ink"
        {...extra}
      />
    </label>
  );

  return (
    <section
      aria-labelledby="claim-title"
      className="flex flex-col gap-3 rounded-xl border border-rule bg-sheet p-4 text-sm"
    >
      <h2 id="claim-title" className="text-base font-semibold">
        This expense
      </h2>
      {editing ? (
        <form onSubmit={(e) => void save(e)} className="flex flex-col gap-3">
          {input('merchant', { autoComplete: 'off', maxLength: 200 })}
          {input('date', { type: 'date' })}
          <div className="grid grid-cols-2 gap-3">
            {input('amount', { inputMode: 'decimal', autoComplete: 'off' })}
            {input('currency', { maxLength: 3, autoCapitalize: 'characters', autoComplete: 'off' })}
          </div>
          <fieldset className="flex flex-col gap-3 pt-1">
            <legend className="mb-2 text-xs font-semibold text-ink">When and where</legend>
            <div className="grid grid-cols-2 gap-3">
              {input('time', { type: 'time' })}
              {input('country', {
                maxLength: 2,
                autoCapitalize: 'characters',
                autoComplete: 'off',
              })}
            </div>
            {input('address', { maxLength: 300, autoComplete: 'off' })}
            <div className="grid grid-cols-2 gap-3">
              {input('city', { maxLength: 100, autoComplete: 'off' })}
              {input('region', { maxLength: 100, autoComplete: 'off' })}
            </div>
            <label className="flex flex-col gap-1 text-xs font-medium text-ink-2">
              {LABELS.timeZone}
              <select
                name="timeZone"
                value={draft.timeZone}
                onChange={(e) => setDraft({ ...draft, timeZone: e.target.value })}
                className="rounded-lg border border-rule bg-paper px-3 py-2 text-base text-ink"
              >
                <option value="">Work it out from the place</option>
                {timeZones(expense.timeZone).map((zone) => (
                  <option key={zone} value={zone}>
                    {zone.replaceAll('_', ' ')}
                  </option>
                ))}
              </select>
            </label>
          </fieldset>
          {/* Only while Journeys and stays is on: the expense then carries both. */}
          {expense.journey && expense.stay ? (
            <fieldset className="flex flex-col gap-3 pt-1">
              <legend className="mb-2 text-xs font-semibold text-ink">Journey and stay</legend>
              <div className="grid grid-cols-2 gap-3">
                {input('journeyFrom', { maxLength: 200, autoComplete: 'off' })}
                {input('journeyTo', { maxLength: 200, autoComplete: 'off' })}
              </div>
              <div className="grid grid-cols-2 gap-3">
                {input('checkIn', { type: 'date' })}
                {input('checkOut', { type: 'date' })}
              </div>
            </fieldset>
          ) : null}
          <div className="flex flex-wrap gap-3">
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
                setEditing(false);
                setDraft(draftOf(expense));
                setError(null);
              }}
              className="rounded-lg border border-rule px-4 py-2 text-sm font-semibold"
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
            <Row label="Merchant" value={expense.merchant} differs={differs.has('merchant')} />
            <Row
              label="Date"
              value={expense.date && showDate(expense.date)}
              differs={differs.has('date')}
            />
            <Row
              label="Amount"
              value={expense.amount ? formatMoney(expense.amount) : null}
              differs={differs.has('amount') || differs.has('currency')}
            />
            <Row
              label="Time"
              value={timeOf(expense.time, expense.timeZone)}
              differs={detailDiffers.has('time')}
            />
            <Row
              label="Place"
              value={placeOf(expense)}
              differs={
                detailDiffers.has('address') ||
                detailDiffers.has('city') ||
                detailDiffers.has('country')
              }
            />
          </dl>
          {expense.editable && expense.source !== 'mileage' ? (
            <div>
              <button
                type="button"
                onClick={() => setEditing(true)}
                className="rounded-lg border border-rule px-4 py-2 text-sm font-semibold"
              >
                Edit
              </button>
            </div>
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

/**
 * A drive logged by hand (FR-CAP-03): where, why, how far, and the rate copied onto it.
 * Changeable before it is submitted; new miles or a new date price it again (ADR-0038).
 */
function Drive({
  expense,
  onSaved,
}: {
  expense: ExpenseDetail;
  onSaved: (expense: ExpenseDetail) => void;
}) {
  const [entry, setEntry] = useState<MileageEntry | null>(null);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void api<MileageEntry>(`/v1/mileage/${expense.id}`).then(
      (found) => {
        if (live) setEntry(found);
      },
      (e: unknown) => {
        if (live) setError(describeError(e));
      },
    );
    return () => {
      live = false;
    };
  }, [expense.id]);

  const drive = entry?.mileage;
  const featureOn = useFeatures();
  // A drive by its route shows its stops and how it was measured (FR-CAP-04).
  if (drive?.method === 'route' && featureOn(ROUTE_MILEAGE_FLAG)) {
    return <RouteDriveDetails expense={expense} onSaved={onSaved} />;
  }
  return (
    <section
      aria-labelledby="drive-title"
      className="flex flex-col gap-3 rounded-xl border border-rule bg-sheet p-4 text-sm"
    >
      <h2 id="drive-title" className="text-base font-semibold">
        This drive
      </h2>
      {!drive && !error ? <p className="text-ink-2">Loading…</p> : null}
      {drive && editing ? (
        <MileageForm
          initial={drive}
          submitLabel="Save"
          busyLabel="Saving…"
          onCancel={() => setEditing(false)}
          onSubmit={async (draft) => {
            const changed = Object.fromEntries(
              (Object.keys(draft) as (keyof typeof draft)[])
                .filter((f) => draft[f] !== drive[f])
                .map((f) => [f, draft[f]]),
            );
            if (Object.keys(changed).length === 0) {
              setEditing(false);
              return;
            }
            const saved = await api<MileageEntry>(`/v1/mileage/${expense.id}`, {
              method: 'PATCH',
              body: JSON.stringify(changed),
            });
            setEntry(saved);
            setEditing(false);
            onSaved(saved);
          }}
        />
      ) : null}
      {drive && !editing ? (
        <>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
            <Row label="Date" value={showDate(drive.date)} differs={false} />
            <Row label="Destination" value={drive.destination} differs={false} />
            <Row label="Purpose" value={drive.purpose} differs={false} />
            <Row label="Distance" value={distanceOf(drive)} differs={false} />
            <Row label="Rate" value={describeRate(drive.rate)} differs={false} />
            <Row
              label="Amount"
              value={expense.amount ? formatMoney(expense.amount) : null}
              differs={false}
            />
          </dl>
          {expense.editable ? (
            <div>
              <button
                type="button"
                onClick={() => setEditing(true)}
                className="rounded-lg border border-rule px-4 py-2 text-sm font-semibold"
              >
                Change the drive
              </button>
            </div>
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

function Row({ label, value, differs }: { label: string; value: string | null; differs: boolean }) {
  return (
    <div className="contents">
      <dt className="text-xs font-medium text-ink-2">{label}</dt>
      <dd className="flex flex-col">
        <span className="tabular-nums">{value ?? '–'}</span>
        {differs ? <span className="text-xs text-warn">differs from its receipt</span> : null}
      </dd>
    </div>
  );
}

/** What its receipt shows: the proof, never changed by editing the expense (FR-EXP-08). */
function Proof({ expense }: { expense: ExpenseDetail }) {
  const proof = expense.proof;
  // With route mileage on, a drive may be measured rather than logged by hand (ADR-0039).
  const routes = useFeatures()(ROUTE_MILEAGE_FLAG);
  if (!proof) {
    return (
      <p className="rounded-xl border border-rule bg-sheet px-4 py-3 text-sm text-ink-2">
        {expense.source === 'mileage'
          ? routes
            ? 'A drive: it needs no receipt.'
            : 'A drive, logged by hand: it needs no receipt.'
          : 'Typed in by hand, with no receipt.'}
      </p>
    );
  }
  const status = RECEIPT_STATUS[proof.status];
  const fields = proof.differences.map((f) => EXPENSE_FIELD_LABELS[f].toLowerCase());
  // Its journey and stay as the receipt reads them, while Journeys and stays is on.
  const read = travelOf(proof.journey, proof.stay);
  const went = journeyLine(read);
  const stayed = stayLine(read);
  const differs = new Set(proof.travelDifferences ?? []);
  const travelDiffers = [
    ...(differs.has('journeyFrom') || differs.has('journeyTo') ? ['journey'] : []),
    ...(differs.has('checkIn') || differs.has('checkOut') ? ['stay'] : []),
  ];
  return (
    <section
      aria-labelledby="proof-title"
      className="flex flex-col gap-3 rounded-xl border border-rule bg-sheet p-4 text-sm"
    >
      <h2 id="proof-title" className="text-base font-semibold">
        Its receipt
      </h2>
      <p className="text-xs text-ink-2">
        <span className={`font-semibold ${status.tone}`}>{status.label}</span>
        {proof.confirmedBy
          ? ` · confirmed by ${proof.confirmedBy}`
          : proof.status === 'needs_review'
            ? ' · as read, not yet confirmed'
            : ''}
      </p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
        <Row label="Merchant" value={proof.merchant} differs={false} />
        <Row label="Date" value={proof.date && showDate(proof.date)} differs={false} />
        <Row
          label="Amount"
          value={proof.amount ? formatMoney(proof.amount) : null}
          differs={false}
        />
        <Row label="Time" value={proof.time} differs={false} />
        <Row label="Place" value={placeOf(proof)} differs={false} />
        {went ? <Row label="Journey" value={went} differs={false} /> : null}
        {stayed ? <Row label="Stay" value={stayed} differs={false} /> : null}
      </dl>
      {travelDiffers.length > 0 ? (
        <p className="text-sm text-ink-2">
          This expense’s {travelDiffers.join(' and ')}{' '}
          {travelDiffers.length === 1 ? 'differs' : 'differ'} from its receipt’s. That is shown,
          never a reason to reject it.
        </p>
      ) : null}
      {fields.length > 0 ? (
        <p className="text-sm text-warn">
          This expense differs from its receipt in the{' '}
          {new Intl.ListFormat('en', { type: 'conjunction' }).format(fields)}. At review, an expense
          that doesn&apos;t match its receipt is rejected.
        </p>
      ) : null}
      <Link
        href={`/receipts/${proof.receiptId}`}
        className="tap font-semibold text-carbon underline"
      >
        Open the receipt
      </Link>
    </section>
  );
}

const SUGGESTED_FROM = {
  history: 'what you chose last time for this merchant',
  keywords: 'its merchant and what its receipt shows',
} as const;

/**
 * Its category and type (FR-EXP-11): chosen, or suggested until the person confirms it
 * (FR-INT-10), or missing, which it says. The type is chosen from those the category allows.
 */
function CategoryChoice({
  expense,
  shown,
  onSaved,
}: {
  expense: ExpenseDetail;
  shown: ExpenseCategory;
  onSaved: (expense: ExpenseDetail) => void;
}) {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [categoryId, setCategoryId] = useState('');
  const [typeId, setTypeId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const changeable = expense.status === 'processing' || expense.editable;

  async function save(choice: { categoryId: string; typeId: string }) {
    setBusy(true);
    setError(null);
    try {
      onSaved(
        await api<ExpenseDetail>(`/v1/expenses/${expense.id}/category`, {
          method: 'PUT',
          body: JSON.stringify(choice),
        }),
      );
    } catch (e) {
      setError(describeError(e));
      setBusy(false);
    }
  }

  async function open() {
    setBusy(true);
    setError(null);
    try {
      const list = await api<Catalog>('/v1/categories');
      setCatalog(list);
      const current = list.categories.find((c) => c.id === shown.category?.id && c.active);
      setCategoryId(current?.id ?? '');
      setTypeId(
        current && shown.type && current.typeIds.includes(shown.type.id) ? shown.type.id : '',
      );
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  const category = catalog?.categories.find((c) => c.id === categoryId);
  const offered = catalog?.types.filter((t) => t.active && category?.typeIds.includes(t.id)) ?? [];
  const pickCategory = (id: string) => {
    setCategoryId(id);
    const allowed = catalog?.categories.find((c) => c.id === id)?.typeIds ?? [];
    const active = catalog?.types.filter((t) => t.active && allowed.includes(t.id)) ?? [];
    setTypeId(
      active.some((t) => t.id === typeId) ? typeId : active.length === 1 ? active[0]!.id : '',
    );
  };

  let summary: ReactNode;
  if (shown.state === 'confirmed') {
    summary = <p>{categoryText(shown)}</p>;
  } else if (shown.state === 'suggested' && shown.basis) {
    summary = (
      <p>
        <span className="font-semibold">Suggested:</span> {categoryText(shown)}.{' '}
        <span className="text-ink-2">
          From {SUGGESTED_FROM[shown.basis]}, until you confirm it.
        </span>
      </p>
    );
  } else {
    summary = <p>No category or type yet. Every expense needs one of each.</p>;
  }

  return (
    <section
      aria-labelledby="category-title"
      className={`flex flex-col gap-3 rounded-xl border bg-sheet p-4 text-sm ${shown.state === 'confirmed' ? 'border-rule' : 'border-warn'}`}
    >
      <h2 id="category-title" className="text-base font-semibold">
        Category and type
      </h2>
      {summary}
      {catalog ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save({ categoryId, typeId });
          }}
          className="flex flex-col gap-3"
        >
          <label className="flex flex-col gap-1 text-xs font-medium text-ink-2">
            Category
            <select
              name="categoryId"
              value={categoryId}
              onChange={(e) => pickCategory(e.target.value)}
              required
              className="rounded-lg border border-rule bg-paper px-3 py-2 text-base text-ink"
            >
              <option value="">Choose a category</option>
              {catalog.categories
                .filter((c) => c.active)
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {indented(c)}
                  </option>
                ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-ink-2">
            Type
            <select
              name="typeId"
              value={typeId}
              onChange={(e) => setTypeId(e.target.value)}
              required
              disabled={!category}
              className="rounded-lg border border-rule bg-paper px-3 py-2 text-base text-ink disabled:opacity-60"
            >
              <option value="">{category ? 'Choose a type' : 'Choose a category first'}</option>
              {offered.map((t) => (
                <option key={t.id} value={t.id}>
                  {indented(t)}
                </option>
              ))}
            </select>
          </label>
          {category && offered.length === 0 ? (
            <p className="text-xs text-warn">This category allows no type in use yet.</p>
          ) : null}
          <div className="flex flex-wrap gap-3">
            <button
              type="submit"
              disabled={busy || !categoryId || !typeId}
              className="rounded-lg bg-carbon px-4 py-2 text-sm font-semibold text-carbon-ink disabled:opacity-60"
            >
              {busy ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              onClick={() => {
                setCatalog(null);
                setError(null);
              }}
              className="rounded-lg border border-rule px-4 py-2 text-sm font-semibold"
            >
              Cancel
            </button>
          </div>
        </form>
      ) : changeable ? (
        <div className="flex flex-wrap gap-3">
          {shown.state === 'suggested' && shown.category && shown.type ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void save({ categoryId: shown.category!.id, typeId: shown.type!.id })}
              className="rounded-lg bg-carbon px-4 py-2 text-sm font-semibold text-carbon-ink disabled:opacity-60"
            >
              Use this
            </button>
          ) : null}
          <button
            type="button"
            disabled={busy}
            onClick={() => void open()}
            className="rounded-lg border border-rule px-4 py-2 text-sm font-semibold disabled:opacity-60"
          >
            {shown.state === 'confirmed'
              ? 'Change'
              : shown.state === 'suggested'
                ? 'Choose another'
                : 'Choose'}
          </button>
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

const daysApart = (a: string, b: string) =>
  Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;

/** How far a trip is from a date: zero inside it. */
const distance = (trip: TripSummary, date: string) =>
  date < trip.startDate
    ? daysApart(date, trip.startDate)
    : date > trip.endDate
      ? daysApart(trip.endDate, date)
      : 0;

/**
 * The trip it is filed to. It files by its date on its own; a person can put it on another
 * trip, such as a flight booked weeks ahead, or on none, and dates never move it again
 * (ADR-0023).
 */
function TripChoice({
  expense,
  onSaved,
}: {
  expense: ExpenseDetail;
  onSaved: (expense: ExpenseDetail) => void;
}) {
  const [trips, setTrips] = useState<TripSummary[] | null>(null);
  const [choice, setChoice] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const movable = expense.status === 'processing' || expense.editable;
  const current = expense.tripFiledBy === 'date' ? 'date' : expense.trip ? expense.trip.id : 'none';

  async function open() {
    setBusy(true);
    setError(null);
    try {
      const { trips: all } = await api<{ trips: TripSummary[] }>('/v1/trips');
      const date = expense.date;
      const mine = all.filter((t) => t.owner === expense.owner);
      setTrips(date ? mine.sort((a, b) => distance(a, date) - distance(b, date)) : mine);
      setChoice(current);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (choice === current) {
      setTrips(null);
      return;
    }
    setBusy(true);
    setError(null);
    const body =
      choice === 'date' ? { byDate: true } : { tripId: choice === 'none' ? null : choice };
    try {
      onSaved(
        await api<ExpenseDetail>(`/v1/expenses/${expense.id}/trip`, {
          method: 'PUT',
          body: JSON.stringify(body),
        }),
      );
      setTrips(null);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  let where: ReactNode;
  if (expense.trip) {
    where = (
      <>
        On{' '}
        <Link href={`/trips/${expense.trip.id}`} className="font-semibold text-carbon underline">
          {expense.trip.name}
        </Link>
        {expense.tripFiledBy === 'date' ? ', by its date.' : ', put there by hand.'}
      </>
    );
  } else if (expense.tripFiledBy === 'person') {
    where = 'Not on a trip, by choice. Dates won’t file it to one.';
  } else if (expense.date) {
    where = 'Not on a trip. No trip of yours covers its date.';
  } else {
    where = 'Not on a trip yet. It files to one once its date is known.';
  }

  return (
    <section
      aria-labelledby="trip-title"
      className="flex flex-col gap-3 rounded-xl border border-rule bg-sheet p-4 text-sm"
    >
      <h2 id="trip-title" className="text-base font-semibold">
        Trip
      </h2>
      <p>{where}</p>
      {expense.reportId ? (
        <p>
          <Link
            href={`/reports/${expense.reportId}`}
            className="font-semibold text-carbon underline"
          >
            Its report
          </Link>
          {expense.trip ? ', with its trip.' : ', as a local expense.'}
        </p>
      ) : expense.local ? (
        <p className="text-ink-2">It goes on a report 24 hours after its date.</p>
      ) : null}
      {trips ? (
        <form onSubmit={(e) => void save(e)} className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-xs font-medium text-ink-2">
            Put it on
            <select
              name="trip"
              value={choice}
              onChange={(e) => setChoice(e.target.value)}
              className="rounded-lg border border-rule bg-paper px-3 py-2 text-base text-ink"
            >
              <option value="date">The trip its date falls in</option>
              <option value="none">No trip</option>
              {trips.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} ({tripDates(t)})
                </option>
              ))}
            </select>
          </label>
          <div className="flex flex-wrap gap-3">
            <button
              type="submit"
              disabled={busy}
              className="rounded-lg bg-carbon px-4 py-2 text-sm font-semibold text-carbon-ink disabled:opacity-60"
            >
              {busy ? 'Moving…' : 'Move it'}
            </button>
            <button
              type="button"
              onClick={() => {
                setTrips(null);
                setError(null);
              }}
              className="rounded-lg border border-rule px-4 py-2 text-sm font-semibold"
            >
              Cancel
            </button>
          </div>
        </form>
      ) : movable ? (
        <div>
          <button
            type="button"
            disabled={busy}
            onClick={() => void open()}
            className="rounded-lg border border-rule px-4 py-2 text-sm font-semibold disabled:opacity-60"
          >
            Change trip
          </button>
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

const JUSTIFICATION_MAX = 500;

/**
 * Why a local expense, one on no trip, was for business (FR-EXP-14). Its report can't close
 * without it.
 */
function Justification({
  expense,
  onSaved,
}: {
  expense: ExpenseDetail;
  onSaved: (expense: ExpenseDetail) => void;
}) {
  const [editing, setEditing] = useState(expense.justification === null && expense.editable);
  const [text, setText] = useState(expense.justification ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`/v1/expenses/${expense.id}/justification`, {
        method: 'PUT',
        body: JSON.stringify({ justification: text }),
      });
      onSaved(await api<ExpenseDetail>(`/v1/expenses/${expense.id}`));
    } catch (e) {
      setError(describeError(e));
      setBusy(false);
    }
  }

  return (
    <section
      aria-labelledby="why-title"
      className={`flex flex-col gap-3 rounded-xl border bg-sheet p-4 text-sm ${expense.justification ? 'border-rule' : 'border-warn'}`}
    >
      <h2 id="why-title" className="text-base font-semibold">
        Why it was for business
      </h2>
      {editing ? (
        <form onSubmit={(e) => void save(e)} className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-xs font-medium text-ink-2">
            It’s a local expense, on no trip, so its report needs a reason
            <textarea
              name="justification"
              value={text}
              onChange={(e) => setText(e.target.value)}
              maxLength={JUSTIFICATION_MAX}
              rows={3}
              required
              className="rounded-lg border border-rule bg-paper px-3 py-2 text-base text-ink"
            />
          </label>
          <div className="flex flex-wrap gap-3">
            <button
              type="submit"
              disabled={busy || text.trim() === ''}
              className="rounded-lg bg-carbon px-4 py-2 text-sm font-semibold text-carbon-ink disabled:opacity-60"
            >
              {busy ? 'Saving…' : 'Save the reason'}
            </button>
            {expense.justification ? (
              <button
                type="button"
                onClick={() => {
                  setEditing(false);
                  setText(expense.justification ?? '');
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
          <p className="break-words">
            {expense.justification ?? 'No reason given. Its report can’t close without one.'}
          </p>
          {expense.editable ? (
            <div>
              <button
                type="button"
                onClick={() => setEditing(true)}
                className="rounded-lg border border-rule px-4 py-2 text-sm font-semibold"
              >
                {expense.justification ? 'Change the reason' : 'Add a reason'}
              </button>
            </div>
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
