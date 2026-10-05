'use client';

import Link from 'next/link';
import { useState } from 'react';
import { api, ApiProblem } from '../lib/api';
import { inboxCard } from '../lib/needs-you';
import type { InboxItem } from '../lib/receipts';

/** What dismissing something said: that it went, or why it couldn't. */
type Said = { text: string; failed: boolean } | null;

function Saying({ said }: { said: Said }) {
  if (!said) return null;
  return said.failed ? (
    <p role="alert" className="text-sm text-warn">
      {said.text}
    </p>
  ) : (
    <p role="status" className="sr-only">
      {said.text}
    </p>
  );
}

/**
 * The Needs you inbox (FR-EXP-02): only what needs the person, each with why and the one
 * thing to do. Home shows the newest few; the rest open in place. Something the person can
 * dismiss (#59) leaves at once, and `onChanged` brings the count up to date.
 */
export function NeedsYouList({
  items,
  count,
  onChanged,
}: {
  items: InboxItem[];
  count: number;
  onChanged?: () => void;
}) {
  const [all, setAll] = useState<InboxItem[] | null>(null);
  const [opening, setOpening] = useState(false);
  const [gone, setGone] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [said, setSaid] = useState<Said>(null);
  const shown = (all ?? items).filter((item) => !gone.has(inboxCard(item).key));

  if (count === 0) {
    return (
      <section aria-labelledby="inbox-empty" className="rounded-xl border border-rule bg-sheet p-5">
        <h2 id="inbox-empty" className="font-semibold">
          Nothing needs you right now
        </h2>
        <p className="mt-1 text-sm text-ink-2">
          Receipts you capture are read automatically. Only the ones ExpenseWise isn&apos;t sure
          about, local expenses needing a reason, and reports to close will show up here.
        </p>
        <Saying said={said} />
      </section>
    );
  }

  const showAll = () => {
    setOpening(true);
    void api<{ items: InboxItem[] }>('/v1/inbox')
      .then(({ items: every }) => setAll(every))
      .finally(() => setOpening(false));
  };

  const dismiss = (key: string, path: string, title: string) => {
    setBusy(key);
    setSaid(null);
    void api(path, { method: 'POST' })
      .then(() => {
        setGone((before) => new Set(before).add(key));
        setSaid({ text: `Dismissed: ${title}.`, failed: false });
        onChanged?.();
      })
      .catch((error: unknown) =>
        setSaid({
          text:
            error instanceof ApiProblem
              ? [error.message, error.detail].filter(Boolean).join('. ')
              : 'Something went wrong. Try again.',
          failed: true,
        }),
      )
      .finally(() => setBusy(null));
  };

  return (
    <section aria-label="Needs you" className="flex flex-col gap-3">
      <ul className="flex flex-col gap-3">
        {shown.map((item) => {
          const card = inboxCard(item);
          const { dismiss: dismissPath } = card;
          const edge =
            card.edge === 'bad'
              ? 'border-l-bad'
              : card.edge === 'ok'
                ? 'border-l-ok'
                : 'border-l-warn';
          const action = (
            <Link
              href={card.href}
              aria-label={`${card.action}: ${card.title}`}
              className="mt-3 inline-flex min-h-11 items-center rounded-lg bg-carbon px-4 text-sm font-semibold text-carbon-ink"
            >
              {card.action}
            </Link>
          );
          return (
            <li
              key={card.key}
              className={`rounded-xl border border-l-4 border-rule bg-sheet p-4 ${edge}`}
            >
              <div className="flex items-baseline justify-between gap-3">
                <p className="min-w-0 truncate font-semibold">{card.title}</p>
                {card.amount ? (
                  <p className="font-mono text-sm whitespace-nowrap">{card.amount}</p>
                ) : null}
              </div>
              <p className="text-xs text-ink-2">
                <span className="whitespace-nowrap">{card.when}</span>
                {card.status ? (
                  <>
                    {' '}
                    ·{' '}
                    <span className={`font-semibold ${card.status.tone}`}>{card.status.label}</span>
                  </>
                ) : null}
              </p>
              <p className="mt-2 text-sm">{card.text}</p>
              {dismissPath ? (
                <div className="flex flex-wrap items-center gap-x-2">
                  {action}
                  <button
                    type="button"
                    onClick={() => dismiss(card.key, dismissPath, card.title)}
                    disabled={busy !== null}
                    aria-label={`${busy === card.key ? 'Dismissing…' : 'Dismiss'}: ${card.title}`}
                    className="mt-3 min-h-11 rounded-lg px-4 text-sm font-semibold text-carbon"
                  >
                    {busy === card.key ? 'Dismissing…' : 'Dismiss'}
                  </button>
                </div>
              ) : (
                action
              )}
            </li>
          );
        })}
      </ul>
      <Saying said={said} />
      {all === null && count > items.length ? (
        <button
          type="button"
          onClick={showAll}
          disabled={opening}
          className="min-h-11 self-end rounded-lg px-4 text-sm font-semibold text-carbon"
        >
          {opening ? 'Opening…' : `Show all ${count}`}
        </button>
      ) : null}
    </section>
  );
}
