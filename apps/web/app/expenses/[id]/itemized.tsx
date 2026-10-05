'use client';

import { fromDecimal, sum, toDecimal } from '@expensewise/domain';
import { useState, type FormEvent } from 'react';
import { api, ApiProblem } from '../../../lib/api';
import type { Catalog } from '../../../lib/categories';
import type { ExpenseDetail } from '../../../lib/expenses';
import {
  EXCLUSION_NOTE_MAX,
  EXCLUSION_REASONS,
  reasonLabel,
  type ExclusionReason,
  type ExpenseSplit,
  type Itemized,
  type ItemizedLine,
} from '../../../lib/itemized';
import { formatMoney } from '../../../lib/receipts';

const describeError = (error: unknown) =>
  error instanceof ApiProblem
    ? [error.message, error.detail].filter(Boolean).join('. ')
    : 'Something went wrong. Try again.';

const card = 'flex flex-col gap-3 rounded-xl border border-rule bg-sheet p-4 text-sm';
const primary =
  'rounded-lg bg-carbon px-4 py-2 text-sm font-semibold text-carbon-ink disabled:opacity-60';
const secondary =
  'rounded-lg border border-rule px-4 py-2 text-sm font-semibold disabled:opacity-60';
const field = 'rounded-lg border border-rule bg-paper px-3 py-2 text-base text-ink';

type Saved = (expense: ExpenseDetail) => void;

/** "Meals › Business meal" for each type a category allows, both in use. */
function choices(catalog: Catalog) {
  const types = new Map(catalog.types.filter((t) => t.active).map((t) => [t.id, t]));
  return catalog.categories
    .filter((c) => c.active)
    .flatMap((c) =>
      c.typeIds.flatMap((typeId) => {
        const type = types.get(typeId);
        return type ? [{ value: `${c.id}|${type.id}`, label: `${c.name} › ${type.name}` }] : [];
      }),
    );
}
const pairOf = (value: string) => {
  const [categoryId = '', typeId = ''] = value.split('|');
  return { categoryId, typeId };
};

/**
 * A receipt's itemized lines in a section under the expense's total (FR-INT-22): each as read,
 * with its share of the tax, tip and fees; whether they add up, said plainly when they don't;
 * and each item line excluded from the claim with a reason, or included again (FR-EXP-16).
 */
export function ItemizedLines({ expense, onSaved }: { expense: ExpenseDetail; onSaved: Saved }) {
  const lines = expense.itemized;
  const [open, setOpen] = useState(false);
  const [excluding, setExcluding] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!lines) return null;
  const canChange = expense.editable && lines.byLine.usable;

  async function include(line: ItemizedLine) {
    setBusy(true);
    setError(null);
    try {
      onSaved(
        await api<ExpenseDetail>(`/v1/expenses/${expense.id}/lines/${line.position}/exclusion`, {
          method: 'DELETE',
        }),
      );
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="lines-title" className={card}>
      <h2 id="lines-title" className="text-base font-semibold">
        What its total is made of
      </h2>
      <ClaimSummary lines={lines} />
      <div>
        <button
          type="button"
          aria-expanded={open}
          aria-controls="receipt-lines"
          onClick={() => setOpen(!open)}
          className={secondary}
        >
          {open ? 'Hide the receipt’s lines' : 'Show the receipt’s lines'}
        </button>
      </div>
      {open ? (
        <div id="receipt-lines" className="flex flex-col gap-3">
          {lines.problem ? (
            <p role="status" className="text-warn">
              {lines.problem.message} Its lines can’t be excluded
              {expense.split === undefined
                ? '.'
                : ' or split by line; it can still be split by amount.'}
            </p>
          ) : lines.byLine.message ? (
            <p role="status" className="text-ink-2">
              {lines.byLine.message}
            </p>
          ) : null}
          <ul className="flex flex-col divide-y divide-rule">
            {lines.lines.map((line) => (
              <li key={line.position} className="flex flex-col gap-1 py-2">
                <div className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3">
                  <span className={`break-words ${line.excluded ? 'text-ink-2 line-through' : ''}`}>
                    {line.description}
                    {line.quantity ? (
                      <span className="text-ink-2"> (qty {line.quantity})</span>
                    ) : null}
                    {line.kind === 'tax' || line.kind === 'fee' ? (
                      <span className="text-ink-2"> ({line.kind})</span>
                    ) : null}
                  </span>
                  <span className="text-right tabular-nums">{formatMoney(line.amount)}</span>
                </div>
                {line.share && line.claimed ? (
                  <p className="text-xs text-ink-2">
                    With {formatMoney(line.share)} of the tax, tip and fees:{' '}
                    {formatMoney(line.claimed)}
                  </p>
                ) : null}
                {line.excluded ? (
                  <p className="text-xs text-warn">
                    Left out: {reasonLabel(line.excluded.reason)}
                    {line.excluded.note ? ` (${line.excluded.note})` : ''}
                  </p>
                ) : null}
                <PartOf line={line} split={expense.split} />
                {canChange &&
                line.kind === 'item' &&
                (line.excluded || line.amount.amountMinor >= 0) &&
                excluding !== line.position ? (
                  <div>
                    {line.excluded ? (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void include(line)}
                        className={secondary}
                      >
                        Include {line.description} again
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => setExcluding(line.position)}
                        className={secondary}
                      >
                        Exclude {line.description}
                      </button>
                    )}
                  </div>
                ) : null}
                {excluding === line.position ? (
                  <ExcludeForm
                    expense={expense}
                    line={line}
                    onCancel={() => setExcluding(null)}
                    onSaved={(next) => {
                      setExcluding(null);
                      onSaved(next);
                    }}
                  />
                ) : null}
              </li>
            ))}
          </ul>
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

/** The receipt's total, what is left out of it, and what is claimed (FR-EXP-16). */
function ClaimSummary({ lines }: { lines: Itemized }) {
  if (!lines.claim) {
    return (
      <p className="text-ink-2">
        {lines.lines.length} lines as read
        {lines.total ? `, a total of ${formatMoney(lines.total)}` : ''}.
      </p>
    );
  }
  const { receipt, excluded, claimed } = lines.claim;
  const left = lines.lines.filter((l) => l.excluded);
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
      <dt className="text-xs font-medium text-ink-2">Receipt</dt>
      <dd className="tabular-nums">{formatMoney(receipt)}</dd>
      {left.length > 0 ? (
        <>
          <dt className="text-xs font-medium text-ink-2">Left out</dt>
          <dd className="flex flex-col">
            <span className="tabular-nums">{formatMoney(excluded)}</span>
            {left.map((l) => (
              <span key={l.position} className="text-xs text-ink-2">
                {l.description}: {l.claimed ? formatMoney(l.claimed) : ''},{' '}
                {reasonLabel(l.excluded!.reason).toLowerCase()}
                {l.excluded!.note ? ` (${l.excluded!.note})` : ''}
              </span>
            ))}
          </dd>
        </>
      ) : null}
      <dt className="text-xs font-medium text-ink-2">Claimed</dt>
      <dd className="font-semibold tabular-nums">{formatMoney(claimed)}</dd>
    </dl>
  );
}

/** Which part of a split a line is in, when it was given a category and type of its own. */
function PartOf({ line, split }: { line: ItemizedLine; split: ExpenseSplit | null | undefined }) {
  const part = split?.parts.find((p) => !p.own && p.lines.includes(line.position));
  if (!part?.category || !part.type) return null;
  return (
    <p className="text-xs text-ink-2">
      A part of its own: {part.category.name} › {part.type.name}
    </p>
  );
}

/** Why a line is left out: a reason from the list, and a note that only other needs (Q38). */
function ExcludeForm({
  expense,
  line,
  onCancel,
  onSaved,
}: {
  expense: ExpenseDetail;
  line: ItemizedLine;
  onCancel: () => void;
  onSaved: Saved;
}) {
  const [reason, setReason] = useState<ExclusionReason | ''>('');
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
        await api<ExpenseDetail>(`/v1/expenses/${expense.id}/lines/${line.position}/exclusion`, {
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
        <legend className="mb-1 text-xs font-semibold text-ink">
          Why leave {line.description} out?
          {line.claimed ? ` It takes ${formatMoney(line.claimed)} off the claim.` : ''}
        </legend>
        {EXCLUSION_REASONS.map((r) => (
          <label key={r.value} className="flex min-h-11 items-center gap-2">
            <input
              type="radio"
              name="reason"
              value={r.value}
              checked={reason === r.value}
              onChange={() => setReason(r.value)}
              className="size-5"
            />
            {r.label}
          </label>
        ))}
      </fieldset>
      <label className="flex flex-col gap-1 text-xs font-medium text-ink-2">
        {reason === 'other' ? 'Note (needed for other)' : 'Note (optional)'}
        <textarea
          name="note"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={EXCLUSION_NOTE_MAX}
          rows={2}
          className={field}
        />
      </label>
      <div className="flex flex-wrap gap-3">
        <button type="submit" disabled={busy || !reason || needsNote} className={primary}>
          {busy ? 'Saving…' : 'Leave it out'}
        </button>
        <button type="button" onClick={onCancel} className={secondary}>
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

/**
 * The parts an expense is split into, each with its own category and type (FR-EXP-15): by
 * line where its lines add up, or by amount, the parts adding up to the claim exactly.
 */
export function SplitParts({ expense, onSaved }: { expense: ExpenseDetail; onSaved: Saved }) {
  const [form, setForm] = useState<'lines' | 'amounts' | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A drive is paid at miles × its rate, and isn't split (ADR-0038).
  if (expense.split === undefined || expense.source === 'mileage') return null;
  const split = expense.split;
  const byLine = expense.itemized?.byLine.usable === true;
  const own =
    expense.category?.category && expense.category.type
      ? `${expense.category.category.name} › ${expense.category.type.name}`
      : 'no category yet';

  async function start(kind: 'lines' | 'amounts') {
    setBusy(true);
    setError(null);
    try {
      setCatalog(await api<Catalog>('/v1/categories'));
      setForm(kind);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  async function send(method: 'PUT' | 'DELETE', body?: unknown) {
    setBusy(true);
    setError(null);
    try {
      onSaved(
        await api<ExpenseDetail>(`/v1/expenses/${expense.id}/split`, {
          method,
          ...(body ? { body: JSON.stringify(body) } : {}),
        }),
      );
      setForm(null);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="split-title" className={card}>
      <h2 id="split-title" className="text-base font-semibold">
        Parts
      </h2>
      {split ? (
        <ul className="flex flex-col gap-1">
          {split.parts.map((p) => (
            <li
              key={p.position}
              className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3"
            >
              <span className="break-words">
                {p.own
                  ? `The rest, as this expense: ${own}`
                  : `${p.category?.name ?? '–'} › ${p.type?.name ?? '–'}`}
              </span>
              <span className="text-right tabular-nums">{formatMoney(p.amount)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-ink-2">
          One part, as this expense: {own}. Split it to report part of it under another category and
          type.
        </p>
      )}
      {form && catalog ? (
        form === 'lines' ? (
          <SplitByLine
            expense={expense}
            catalog={catalog}
            busy={busy}
            onCancel={() => setForm(null)}
            onSave={(lines) => void send('PUT', { basis: 'lines', lines })}
          />
        ) : (
          <SplitByAmount
            expense={expense}
            catalog={catalog}
            busy={busy}
            onCancel={() => setForm(null)}
            onSave={(parts) => void send('PUT', { basis: 'amounts', parts })}
          />
        )
      ) : expense.editable ? (
        <div className="flex flex-wrap gap-3">
          {byLine ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void start('lines')}
              className={secondary}
            >
              Split by line
            </button>
          ) : null}
          {expense.amount ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void start('amounts')}
              className={secondary}
            >
              Split by amount
            </button>
          ) : null}
          {split ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void send('DELETE')}
              className={secondary}
            >
              Take the split away
            </button>
          ) : null}
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

/** Each item line given a category and type of its own, or left with the expense's (Q36). */
function SplitByLine({
  expense,
  catalog,
  busy,
  onCancel,
  onSave,
}: {
  expense: ExpenseDetail;
  catalog: Catalog;
  busy: boolean;
  onCancel: () => void;
  onSave: (lines: { position: number; categoryId: string; typeId: string }[]) => void;
}) {
  const items = (expense.itemized?.lines ?? []).filter((l) => l.kind === 'item' && !l.excluded);
  const [chosen, setChosen] = useState<Record<number, string>>(() =>
    Object.fromEntries(
      items.map((l) => [l.position, l.part ? `${l.part.categoryId}|${l.part.typeId}` : '']),
    ),
  );
  const options = choices(catalog);
  const given = items.filter((l) => chosen[l.position]);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSave(given.map((l) => ({ position: l.position, ...pairOf(chosen[l.position] ?? '') })));
      }}
      className="flex flex-col gap-3"
    >
      <p className="text-xs text-ink-2">
        Give a line a category and type to make it a part of its own, with its share of the tax, tip
        and fees. The lines you leave stay with this expense’s own.
      </p>
      {items.map((l) => (
        <label key={l.position} className="flex flex-col gap-1 text-xs font-medium text-ink-2">
          {l.description} ({l.claimed ? formatMoney(l.claimed) : formatMoney(l.amount)})
          <select
            name={`line-${l.position}`}
            value={chosen[l.position] ?? ''}
            onChange={(e) => setChosen({ ...chosen, [l.position]: e.target.value })}
            className={field}
          >
            <option value="">As this expense</option>
            {options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      ))}
      <div className="flex flex-wrap gap-3">
        <button type="submit" disabled={busy || given.length === 0} className={primary}>
          {busy ? 'Saving…' : 'Save the split'}
        </button>
        <button type="button" onClick={onCancel} className={secondary}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** What typed amounts come to, exactly; null while one isn't a plain amount in the currency. */
function partsTotal(amounts: string[], currency: string): string | null {
  try {
    return toDecimal(
      sum(
        currency,
        amounts.map((a) => fromDecimal(a.trim() || '0', currency)),
      ),
    );
  } catch {
    return null;
  }
}

/** Parts typed by amount, each with its category and type, adding up to the claim (Q36). */
function SplitByAmount({
  expense,
  catalog,
  busy,
  onCancel,
  onSave,
}: {
  expense: ExpenseDetail;
  catalog: Catalog;
  busy: boolean;
  onCancel: () => void;
  onSave: (parts: { categoryId: string; typeId: string; amount: string }[]) => void;
}) {
  const options = choices(catalog);
  const typed =
    expense.split?.basis === 'amounts'
      ? expense.split.parts.map((p) => ({
          pair: p.category && p.type ? `${p.category.id}|${p.type.id}` : '',
          amount: p.amount.decimal,
        }))
      : [
          { pair: '', amount: '' },
          { pair: '', amount: '' },
        ];
  const [parts, setParts] = useState(typed);
  const claim = expense.amount;
  const total = claim
    ? partsTotal(
        parts.map((p) => p.amount),
        claim.currency,
      )
    : null;
  const addsUp = claim !== null && total === claim.decimal;
  const set = (i: number, change: Partial<(typeof parts)[number]>) =>
    setParts(parts.map((p, j) => (j === i ? { ...p, ...change } : p)));
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSave(parts.map((p) => ({ ...pairOf(p.pair), amount: p.amount.trim() })));
      }}
      className="flex flex-col gap-3"
    >
      {parts.map((p, i) => (
        <fieldset key={i} className="flex flex-col gap-2">
          <legend className="mb-1 text-xs font-semibold text-ink">Part {i + 1}</legend>
          <label className="flex flex-col gap-1 text-xs font-medium text-ink-2">
            Category and type of part {i + 1}
            <select
              value={p.pair}
              onChange={(e) => set(i, { pair: e.target.value })}
              required
              className={field}
            >
              <option value="">Choose one</option>
              {options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-ink-2">
            Amount of part {i + 1}
            <input
              value={p.amount}
              onChange={(e) => set(i, { amount: e.target.value })}
              inputMode="decimal"
              autoComplete="off"
              required
              className={field}
            />
          </label>
          {parts.length > 2 ? (
            <div>
              <button
                type="button"
                onClick={() => setParts(parts.filter((_, j) => j !== i))}
                className={secondary}
              >
                Remove part {i + 1}
              </button>
            </div>
          ) : null}
        </fieldset>
      ))}
      <p role="status" className={addsUp ? 'text-ok' : 'text-ink-2'}>
        {claim
          ? `The parts come to ${total !== null ? formatMoney({ decimal: total, currency: claim.currency }) : '–'} of ${formatMoney(claim)}${addsUp ? ', exactly.' : '. They must add up to it exactly.'}`
          : null}
      </p>
      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          onClick={() => setParts([...parts, { pair: '', amount: '' }])}
          className={secondary}
        >
          Add a part
        </button>
        <button type="submit" disabled={busy || !addsUp} className={primary}>
          {busy ? 'Saving…' : 'Save the split'}
        </button>
        <button type="button" onClick={onCancel} className={secondary}>
          Cancel
        </button>
      </div>
    </form>
  );
}
