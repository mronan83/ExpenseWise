'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, ApiProblem } from '../../../lib/api';
import {
  EXPENSE_FIELD_LABELS,
  EXPENSE_STATUS,
  type ExpenseDetail,
  type ExpenseField,
} from '../../../lib/expenses';
import { formatMoney, RECEIPT_STATUS } from '../../../lib/receipts';
import { supabase } from '../../../lib/supabase';

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

  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col px-4 pt-[max(1rem,env(safe-area-inset-top))]">
      <header className="flex items-baseline justify-between py-3">
        <Link href="/expenses" className="text-sm font-semibold text-carbon">
          ← Expenses
        </Link>
      </header>
      <main className="flex flex-1 flex-col gap-4 pb-8">
        <h1 className="text-2xl font-bold">{expense?.merchant ?? 'Expense'}</h1>
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
            <Claim
              key={expense.updatedAt}
              expense={expense}
              onSaved={(next) => setLoad({ state: 'ready', expense: next })}
            />
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
  if (expense.status === 'processing') {
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
      <span className={`font-semibold ${status.tone}`}>{status.label}.</span> {text}
    </p>
  );
}

type Draft = Record<ExpenseField, string>;
const draftOf = (e: ExpenseDetail): Draft => ({
  merchant: e.merchant ?? '',
  date: e.date ?? '',
  currency: e.amount?.currency ?? '',
  amount: e.amount?.decimal ?? '',
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

  async function save(event: FormEvent) {
    event.preventDefault();
    const changed = Object.fromEntries(
      (Object.keys(draft) as ExpenseField[])
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

  const input = (field: ExpenseField, extra: Record<string, string | number> = {}) => (
    <label className="flex flex-col gap-1 text-xs font-medium text-ink-2">
      {EXPENSE_FIELD_LABELS[field]}
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
            <Row label="Date" value={expense.date} differs={differs.has('date')} />
            <Row
              label="Amount"
              value={expense.amount ? formatMoney(expense.amount) : null}
              differs={differs.has('amount') || differs.has('currency')}
            />
          </dl>
          {expense.editable ? (
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
  if (!proof) {
    return (
      <p className="rounded-xl border border-rule bg-sheet px-4 py-3 text-sm text-ink-2">
        Typed in by hand, with no receipt.
      </p>
    );
  }
  const status = RECEIPT_STATUS[proof.status];
  const fields = proof.differences.map((f) => EXPENSE_FIELD_LABELS[f].toLowerCase());
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
        <Row label="Date" value={proof.date} differs={false} />
        <Row
          label="Amount"
          value={proof.amount ? formatMoney(proof.amount) : null}
          differs={false}
        />
      </dl>
      {fields.length > 0 ? (
        <p className="text-sm text-warn">
          This expense differs from its receipt in the{' '}
          {new Intl.ListFormat('en', { type: 'conjunction' }).format(fields)}. At review, an expense
          that doesn&apos;t match its receipt is rejected.
        </p>
      ) : null}
      <Link href={`/receipts/${proof.receiptId}`} className="font-semibold text-carbon underline">
        Open the receipt
      </Link>
    </section>
  );
}
