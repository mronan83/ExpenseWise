'use client';

import Link from 'next/link';
import { useState } from 'react';
import { api } from '../lib/api';
import { inboxCard } from '../lib/needs-you';
import type { InboxItem } from '../lib/receipts';

/**
 * The Needs you inbox (FR-EXP-02): only what needs the person, each with why and the one
 * thing to do. Home shows the newest few; the rest open in place.
 */
export function NeedsYouList({ items, count }: { items: InboxItem[]; count: number }) {
  const [all, setAll] = useState<InboxItem[] | null>(null);
  const [opening, setOpening] = useState(false);
  const shown = all ?? items;

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
      </section>
    );
  }

  const showAll = () => {
    setOpening(true);
    void api<{ items: InboxItem[] }>('/v1/inbox')
      .then(({ items: every }) => setAll(every))
      .finally(() => setOpening(false));
  };

  return (
    <section aria-label="Needs you" className="flex flex-col gap-3">
      <ul className="flex flex-col gap-3">
        {shown.map((item) => {
          const card = inboxCard(item);
          const edge =
            card.edge === 'bad'
              ? 'border-l-bad'
              : card.edge === 'ok'
                ? 'border-l-ok'
                : 'border-l-warn';
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
              <Link
                href={card.href}
                className="mt-3 inline-flex min-h-11 items-center rounded-lg bg-carbon px-4 text-sm font-semibold text-carbon-ink"
              >
                {card.action}
                <span className="sr-only">: {card.title}</span>
              </Link>
            </li>
          );
        })}
      </ul>
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
