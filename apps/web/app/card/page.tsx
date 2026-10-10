'use client';

import { SET_ASIDE_NOTE_MAX, showDate, type SetAsideReason } from '@expensewise/domain';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState, type ChangeEvent, type FormEvent } from 'react';
import { api, ApiProblem } from '../../lib/api';
import {
  bringInList,
  bringInStatement,
  CARD_STATEMENTS_FLAG,
  cardText,
  listOutcome,
  SET_ASIDE_CHOICES,
  openStatementFile,
  SOURCE_LABEL,
  STATEMENT_STATUS,
  statementPeriod,
  type CardStatement,
  type CardStatements,
  type CardTransaction,
  type MatchableExpense,
  type MatchedExpense,
} from '../../lib/card-statements';
import { COMPANY_PAID_FLAG } from '../../lib/company-paid';
import { loadFeatures } from '../../lib/features';
import { ReceiptFileError } from '../../lib/receipt-file';
import { captureReceipt, formatMoney } from '../../lib/receipts';
import { supabase } from '../../lib/supabase';

type Load =
  | { state: 'loading' }
  | { state: 'signed-out' }
  | { state: 'off' }
  | { state: 'error'; message: string }
  | { state: 'ready'; data: CardStatements };

const describeError = (error: unknown) =>
  error instanceof ReceiptFileError
    ? error.message
    : error instanceof ApiProblem
      ? [error.message, error.detail].filter(Boolean).join('. ')
      : error instanceof Error
        ? error.message
        : 'Something went wrong. Try again.';

const card = 'flex flex-col gap-3 rounded-xl border border-rule bg-sheet p-4 text-sm';
const primary =
  'rounded-lg bg-carbon px-4 py-2 text-sm font-semibold text-carbon-ink disabled:opacity-60';
const secondary =
  'rounded-lg border border-rule px-4 py-2 text-sm font-semibold disabled:opacity-60';
const field = 'rounded-lg border border-rule bg-paper px-3 py-2 text-base text-ink';

type Saved = (data: CardStatements) => void;

/**
 * The person's corporate card (FR-CAP-10, FR-INT-24): bring in its statement, as a PDF or a
 * downloaded list, see each charge matched to an expense, and sort out the charges that have
 * none. Behind its flag: off, the page says so.
 */
export default function CardPage() {
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [progress, setProgress] = useState<string | null>(null);
  const [said, setSaid] = useState<{ text: string; problem: boolean } | null>(null);
  // Whether Paid by the company is on, which keeps what the card paid for out of every claim.
  const [paidOn, setPaidOn] = useState(true);

  const refresh = useCallback(async () => {
    const session = (await supabase()?.auth.getSession())?.data.session;
    if (!session) {
      setLoad({ state: 'signed-out' });
      return;
    }
    try {
      const { features } = await loadFeatures();
      const on = (key: string) => features.some((f) => f.key === key && f.enabled);
      if (!on(CARD_STATEMENTS_FLAG)) {
        setLoad({ state: 'off' });
        return;
      }
      setPaidOn(on(COMPANY_PAID_FLAG));
      setLoad({ state: 'ready', data: await api<CardStatements>('/v1/card-statements') });
    } catch (error) {
      setLoad({ state: 'error', message: describeError(error) });
    }
  }, []);

  useEffect(() => {
    // Loading reads the browser's session, so it can only start after mounting.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  // While a statement is being read, check again every few seconds.
  const reading =
    load.state === 'ready' && load.data.statements.some((s) => s.status === 'reading');
  useEffect(() => {
    if (!reading) return;
    const timer = setInterval(() => void refresh(), 3000);
    return () => clearInterval(timer);
  }, [reading, refresh]);

  const saved: Saved = (data) => setLoad({ state: 'ready', data });

  const bringIn = (kind: 'pdf' | 'list') => (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file) return;
    setSaid(null);
    void (async () => {
      try {
        if (kind === 'pdf') {
          saved(await bringInStatement(file, setProgress));
          setSaid({
            text: 'Brought in. It is being read, which takes up to a minute.',
            problem: false,
          });
        } else {
          setProgress('Reading the list…');
          const outcome = await bringInList(file);
          await refresh();
          setSaid({ text: listOutcome(outcome), problem: false });
        }
      } catch (error) {
        setSaid({ text: describeError(error), problem: true });
      }
      setProgress(null);
    })();
  };

  const data = load.state === 'ready' ? load.data : null;
  const missing = data?.transactions.filter((t) => t.state === 'missing') ?? [];
  const others = data?.transactions.filter((t) => t.state !== 'missing') ?? [];

  return (
    <div className="mx-auto flex w-full max-w-md flex-1 flex-col px-4 pt-[max(1rem,env(safe-area-inset-top))]">
      <header className="flex items-baseline justify-between py-3">
        <Link href="/expenses" className="tap text-sm font-semibold text-carbon">
          ← Expenses
        </Link>
      </header>
      <main className="flex flex-1 flex-col gap-4 pb-8">
        <h1 className="text-2xl font-bold">Card</h1>
        {load.state === 'loading' ? <p className="text-sm text-ink-2">Loading…</p> : null}
        {load.state === 'signed-out' ? (
          <p className="text-sm">
            <Link href="/sign-in" className="font-semibold text-carbon underline">
              Sign in
            </Link>{' '}
            to bring in your card statement.
          </p>
        ) : null}
        {load.state === 'off' ? (
          <p className="text-sm">
            Card statements are switched off for your organization. Its owner can switch them on in{' '}
            <Link href="/settings/features" className="font-semibold text-carbon underline">
              Settings › Features
            </Link>
            .
          </p>
        ) : null}
        {load.state === 'error' ? (
          <p role="alert" className="text-sm text-warn">
            {load.message}
          </p>
        ) : null}

        {data ? (
          <>
            <section aria-labelledby="bring-title" className={card}>
              <h2 id="bring-title" className="text-base font-semibold">
                Bring in a statement
              </h2>
              <p className="text-ink-2">
                Upload your card’s monthly statement as a PDF, or forward it to your receipts
                address with “statement” in the subject. Your primary AI model reads it, for a few
                cents on its key (Settings › AI models). Or upload the transaction list you download
                as CSV, which is read here at no cost.
              </p>
              <div className="flex flex-wrap gap-2">
                <label
                  className={`cursor-pointer ${primary} ${progress ? 'pointer-events-none opacity-60' : ''}`}
                >
                  Upload a PDF statement
                  <input
                    type="file"
                    accept="application/pdf,.pdf"
                    className="sr-only"
                    disabled={progress !== null}
                    onChange={bringIn('pdf')}
                  />
                </label>
                <label
                  className={`cursor-pointer ${secondary} ${progress ? 'pointer-events-none opacity-60' : ''}`}
                >
                  Upload a downloaded list
                  <input
                    type="file"
                    accept=".csv,.tsv,.txt,text/csv,text/plain,text/tab-separated-values"
                    className="sr-only"
                    disabled={progress !== null}
                    onChange={bringIn('list')}
                  />
                </label>
              </div>
              <p role="status" className="min-h-5 text-ink-2">
                {progress}
              </p>
              {said ? (
                <p
                  role={said.problem ? 'alert' : 'status'}
                  className={said.problem ? 'text-warn' : ''}
                >
                  {said.text}
                </p>
              ) : null}
            </section>

            {!paidOn ? (
              <p role="note" className="rounded-xl border border-warn p-4 text-sm">
                Your card is billed to your employer, so what it paid for is never claimed. Switch
                on Paid by the company in{' '}
                <Link href="/settings/features" className="font-semibold text-carbon underline">
                  Settings › Features
                </Link>{' '}
                so your reports leave those expenses out of what you claim.
              </p>
            ) : null}
            <Missing missing={missing} statements={data.statements} onSaved={saved} />

            {data.statements.length > 0 ? (
              <section aria-labelledby="statements-title" className={card}>
                <h2 id="statements-title" className="text-base font-semibold">
                  Statements
                </h2>
                <ul className="flex flex-col divide-y divide-rule">
                  {data.statements.map((s) => (
                    <StatementRow key={s.id} statement={s} onSaved={saved} />
                  ))}
                </ul>
              </section>
            ) : null}

            {others.length > 0 ? (
              <section aria-labelledby="others-title" className={card}>
                <h2 id="others-title" className="text-base font-semibold">
                  Other charges and credits
                </h2>
                <ul className="flex flex-col divide-y divide-rule">
                  {others.map((t) => (
                    <ChargeRow
                      key={t.id}
                      charge={t}
                      statement={data.statements.find((s) => s.id === t.statementId)}
                      onSaved={saved}
                    />
                  ))}
                </ul>
              </section>
            ) : null}
          </>
        ) : null}
      </main>
    </div>
  );
}

/** The charges with no expense: each a missing receipt (US-CAP-07 AC3). */
function Missing({
  missing,
  statements,
  onSaved,
}: {
  missing: CardTransaction[];
  statements: CardStatement[];
  onSaved: Saved;
}) {
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  if (statements.length === 0) return null;

  async function matchAgain() {
    setBusy(true);
    setSaid(null);
    try {
      const { matched } = await api<{ matched: number }>('/v1/card-statements/match', {
        method: 'POST',
      });
      onSaved(await api<CardStatements>('/v1/card-statements'));
      setSaid(
        matched === 0
          ? 'Nothing more matched on its own.'
          : `Matched ${matched} ${matched === 1 ? 'charge' : 'charges'}.`,
      );
    } catch (e) {
      setSaid(describeError(e));
    }
    setBusy(false);
  }

  return (
    <section aria-labelledby="missing-title" className={card}>
      <h2 id="missing-title" className="text-base font-semibold">
        {missing.length === 0
          ? 'Every charge has an expense'
          : `${missing.length} ${missing.length === 1 ? 'charge has' : 'charges have'} no receipt`}
      </h2>
      <p className="text-ink-2">
        A charge matches an expense of the same amount within three days, the closest merchant
        first, and a ride and its tip charged apart match their receipt together. Add the receipt
        for one that has none, match it to an expense yourself, or say why there isn’t one.
      </p>
      {missing.length > 0 ? (
        <ul className="flex flex-col divide-y divide-rule">
          {missing.map((t) => (
            <ChargeRow
              key={t.id}
              charge={t}
              statement={statements.find((s) => s.id === t.statementId)}
              onSaved={onSaved}
            />
          ))}
        </ul>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={busy}
          onClick={() => void matchAgain()}
          className={secondary}
        >
          {busy ? 'Matching…' : 'Match again'}
        </button>
        <p role="status" className="text-ink-2">
          {said}
        </p>
      </div>
    </section>
  );
}

const STATE_TEXT: Record<CardTransaction['state'], string> = {
  missing: 'No receipt',
  matched: 'Matched',
  set_aside: 'Set aside',
  credit: 'Credit',
  waiting: 'Waiting',
};

/**
 * One charge, the statement it came from, and what can be done about it where it stands
 * (US-CAP-07 AC16).
 */
function ChargeRow({
  charge,
  statement,
  onSaved,
}: {
  charge: CardTransaction;
  statement: CardStatement | undefined;
  onSaved: Saved;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<'idle' | 'match' | 'aside'>('idle');
  const [progress, setProgress] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const path = `/v1/card-transactions/${charge.id}`;

  async function undo(what: 'expense' | 'set-aside') {
    setBusy(true);
    setError(null);
    try {
      onSaved(await api<CardStatements>(`${path}/${what}`, { method: 'DELETE' }));
    } catch (e) {
      setError(describeError(e));
    }
    setBusy(false);
  }

  /** Its receipt, uploaded here, goes on with the charge, to be matched to it once read (AC17). */
  function addReceipt(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file) return;
    setError(null);
    void (async () => {
      try {
        const { id } = await captureReceipt(file, 'upload', setProgress);
        router.push(`/receipts/${id}?charge=${charge.id}`);
      } catch (e) {
        setError(describeError(e));
        setProgress(null);
      }
    })();
  }

  const onCard = cardText(charge.cardLastFour);
  return (
    <li id={`charge-${charge.id}`} className="flex scroll-mt-4 flex-col gap-2 py-3">
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-semibold break-words">{charge.merchant}</span>
        <span className="shrink-0 font-semibold tabular-nums">{formatMoney(charge.amount)}</span>
      </div>
      <p className="text-xs text-ink-2">
        {[showDate(charge.transactionDate), onCard].filter(Boolean).join(' · ')} ·{' '}
        <span
          className={`font-semibold ${charge.state === 'missing' ? 'text-warn' : charge.state === 'matched' ? 'text-ok' : ''}`}
        >
          {STATE_TEXT[charge.state]}
        </span>
      </p>
      {statement ? (
        <p className="text-xs text-ink-2">
          From{' '}
          <a href={`#statement-${statement.id}`} className="font-semibold text-carbon underline">
            {statement.source === 'list' ? 'the downloaded list' : 'the statement'}{' '}
            {statementPeriod(statement)}
          </a>
        </p>
      ) : null}
      {charge.state === 'matched' && charge.expense ? (
        <>
          <p>
            Pays for{' '}
            <Link
              href={`/expenses/${charge.expense.id}`}
              className="font-semibold text-carbon underline"
            >
              {expenseText(charge.expense)}
            </Link>
            {charge.matchedBy === 'auto' ? ', matched on its own.' : ', matched by you.'}
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => void undo('expense')}
              className={secondary}
            >
              Let it go
            </button>
          </div>
        </>
      ) : null}
      {charge.state === 'set_aside' && charge.setAside ? (
        <>
          <p>
            {SET_ASIDE_CHOICES.find(([r]) => r === charge.setAside?.reason)?.[1]}
            {charge.setAside.note ? `: ${charge.setAside.note}` : '.'}
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => void undo('set-aside')}
              className={secondary}
            >
              Bring it back
            </button>
          </div>
        </>
      ) : null}
      {charge.state === 'credit' ? (
        <p className="text-ink-2">A credit or refund: it needs no receipt.</p>
      ) : null}
      {charge.state === 'waiting' ? (
        <p className="text-ink-2">Its statement needs a look before anything is matched.</p>
      ) : null}
      {charge.state === 'missing' && mode === 'idle' ? (
        <div className="flex flex-wrap gap-2">
          <label
            className={`cursor-pointer ${primary} ${progress ? 'pointer-events-none opacity-60' : ''}`}
          >
            Add its receipt
            <input
              type="file"
              accept="image/*,application/pdf"
              className="sr-only"
              disabled={progress !== null}
              onChange={addReceipt}
            />
          </label>
          <button type="button" onClick={() => setMode('match')} className={secondary}>
            Match to an expense
          </button>
          <button type="button" onClick={() => setMode('aside')} className={secondary}>
            Set it aside
          </button>
        </div>
      ) : null}
      {progress ? (
        <p role="status" className="text-ink-2">
          {progress}
        </p>
      ) : null}
      {mode === 'match' ? (
        <MatchForm charge={charge} onCancel={() => setMode('idle')} onSaved={onSaved} />
      ) : null}
      {mode === 'aside' ? (
        <SetAsideForm charge={charge} onCancel={() => setMode('idle')} onSaved={onSaved} />
      ) : null}
      {error ? (
        <p role="alert" className="text-warn">
          {error}
        </p>
      ) : null}
    </li>
  );
}

const expenseText = (e: MatchedExpense) =>
  [e.merchant ?? 'An expense', e.amount ? formatMoney(e.amount) : null, e.date && showDate(e.date)]
    .filter(Boolean)
    .join(', ');

/** Match a charge to one of the person's expenses near its day, whatever its amount. */
function MatchForm({
  charge,
  onCancel,
  onSaved,
}: {
  charge: CardTransaction;
  onCancel: () => void;
  onSaved: Saved;
}) {
  const [offered, setOffered] = useState<MatchableExpense[] | null>(null);
  const [chosen, setChosen] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api<{ expenses: MatchableExpense[] }>(`/v1/card-transactions/${charge.id}/expenses`)
      .then(({ expenses }) => {
        if (live) setOffered(expenses);
      })
      .catch((e: unknown) => {
        if (live) setError(describeError(e));
      });
    return () => {
      live = false;
    };
  }, [charge.id]);

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onSaved(
        await api<CardStatements>(`/v1/card-transactions/${charge.id}/expense`, {
          method: 'PUT',
          body: JSON.stringify({ expenseId: chosen }),
        }),
      );
    } catch (e) {
      setError(describeError(e));
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => void save(e)} className="flex flex-col gap-3 pt-1">
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-xs font-semibold text-ink">
          Which expense did it pay for?
        </legend>
        {offered === null && !error ? <p className="text-ink-2">Loading…</p> : null}
        {offered?.length === 0 ? (
          <p className="text-ink-2">
            None of your expenses with a receipt is within a week of it. Add its receipt instead.
          </p>
        ) : null}
        {offered?.map((e) => (
          <label key={e.id} className="flex min-h-11 items-center gap-2">
            <input
              type="radio"
              name="expense"
              value={e.id}
              checked={chosen === e.id}
              onChange={() => setChosen(e.id)}
              className="size-5"
            />
            <span>
              {expenseText(e)}
              {e.charged ? (
                <span className="text-ink-2"> · {formatMoney(e.charged)} already on its card</span>
              ) : null}
            </span>
          </label>
        ))}
      </fieldset>
      <div className="flex flex-wrap gap-3">
        <button type="submit" disabled={busy || !chosen} className={primary}>
          {busy ? 'Matching…' : 'Match it'}
        </button>
        <button type="button" onClick={onCancel} className={secondary}>
          Cancel
        </button>
      </div>
      {error ? (
        <p role="alert" className="text-warn">
          {error}
        </p>
      ) : null}
    </form>
  );
}

/** Say why a charge has no expense, such as a personal charge. */
function SetAsideForm({
  charge,
  onCancel,
  onSaved,
}: {
  charge: CardTransaction;
  onCancel: () => void;
  onSaved: Saved;
}) {
  const [reason, setReason] = useState<SetAsideReason | ''>('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const needsNote = reason === 'other' && note.trim() === '';

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onSaved(
        await api<CardStatements>(`/v1/card-transactions/${charge.id}/set-aside`, {
          method: 'PUT',
          body: JSON.stringify({ reason, note: note.trim() || null }),
        }),
      );
    } catch (e) {
      setError(describeError(e));
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => void save(e)} className="flex flex-col gap-3 pt-1">
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-xs font-semibold text-ink">Why is there no expense?</legend>
        {SET_ASIDE_CHOICES.map(([value, label]) => (
          <label key={value} className="flex min-h-11 items-center gap-2">
            <input
              type="radio"
              name="reason"
              value={value}
              checked={reason === value}
              onChange={() => setReason(value)}
              className="size-5"
            />
            {label}
          </label>
        ))}
      </fieldset>
      <label className="flex flex-col gap-1 text-xs font-medium text-ink-2">
        {reason === 'other' ? 'Note (needed for other)' : 'Note (optional)'}
        <textarea
          name="note"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={SET_ASIDE_NOTE_MAX}
          rows={2}
          className={field}
        />
      </label>
      <div className="flex flex-wrap gap-3">
        <button type="submit" disabled={busy || !reason || needsNote} className={primary}>
          {busy ? 'Saving…' : 'Set it aside'}
        </button>
        <button type="button" onClick={onCancel} className={secondary}>
          Cancel
        </button>
      </div>
      {error ? (
        <p role="alert" className="text-warn">
          {error}
        </p>
      ) : null}
    </form>
  );
}

/** A statement brought in: what it is, how its reading went, and what to do next. */
function StatementRow({ statement, onSaved }: { statement: CardStatement; onSaved: Saved }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const status = STATEMENT_STATUS[statement.status];
  const period =
    statement.periodStart && statement.periodEnd
      ? `${showDate(statement.periodStart)} to ${showDate(statement.periodEnd)}`
      : `Brought in ${showDate(statement.createdAt.slice(0, 10))}`;

  async function act(method: 'POST' | 'DELETE', path: string) {
    setBusy(true);
    setError(null);
    try {
      onSaved(await api<CardStatements>(path, { method }));
    } catch (e) {
      setError(describeError(e));
      setBusy(false);
    }
  }

  return (
    <li id={`statement-${statement.id}`} className="flex scroll-mt-4 flex-col gap-2 py-3">
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-semibold">{SOURCE_LABEL[statement.source]}</span>
        <span className={`shrink-0 text-xs font-semibold ${status.tone}`}>{status.label}</span>
      </div>
      <p className="text-xs text-ink-2">
        {[period, cardText(statement.cardLastFour), `${statement.added} new`]
          .filter(Boolean)
          .join(' · ')}
      </p>
      {statement.problem ? (
        <p className={statement.status === 'failed' ? 'text-bad' : 'text-warn'}>
          {statement.problem}
        </p>
      ) : null}
      {statement.status === 'needs_look' ? (
        // What to check, and what each choice does (US-CAP-07 AC14, GAP-52).
        <p className="text-ink-2">
          Nothing on it is matched until you look. Check its charges below against{' '}
          {statement.source === 'list' ? 'your list' : 'the statement'}. If they’re right, as when
          the statement prints its purchases after a credit, tap It’s right: its charges are then
          matched to your expenses, and each match can be undone. If one was read wrong, delete it
          and bring it in again, or bring in the downloaded list instead.
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {statement.status === 'needs_look' ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => void act('POST', `/v1/card-statements/${statement.id}/confirm`)}
            className={primary}
          >
            It’s right: match it
          </button>
        ) : null}
        {statement.source !== 'list' ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setError(null);
              openStatementFile(statement.id).catch((e: unknown) => setError(describeError(e)));
            }}
            className={secondary}
          >
            Open the statement
          </button>
        ) : null}
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            if (window.confirm('Delete this statement and the transactions it brought in?')) {
              void act('DELETE', `/v1/card-statements/${statement.id}`);
            }
          }}
          className={secondary}
        >
          Delete
        </button>
      </div>
      {error ? (
        <p role="alert" className="text-warn">
          {error}
        </p>
      ) : null}
    </li>
  );
}
