'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { api, ApiProblem } from '../lib/api';
import { formatMoney, needsYou, RECEIPT_STATUS, type InboxItem } from '../lib/receipts';
import { supabase } from '../lib/supabase';

type Load =
  | { state: 'loading' }
  | { state: 'signed-out' }
  | { state: 'error'; message: string }
  | { state: 'ready'; items: InboxItem[] };

/**
 * The Needs you inbox (FR-EXP-02): only what needs the person, each with why and the one
 * thing to do. Receipts that need a look or couldn't be read, for now; missing receipts
 * and returned reports join it as they are built.
 */
export function NeedsYou() {
  const [load, setLoad] = useState<Load>({ state: 'loading' });

  const refresh = useCallback(async () => {
    const session = (await supabase()?.auth.getSession())?.data.session;
    if (!session) {
      setLoad({ state: 'signed-out' });
      return;
    }
    try {
      await api('/v1/me/organization', { method: 'POST' });
      setLoad({ state: 'ready', items: (await api<{ items: InboxItem[] }>('/v1/inbox')).items });
    } catch (error) {
      setLoad({
        state: 'error',
        message:
          error instanceof ApiProblem
            ? [error.message, error.detail].filter(Boolean).join('. ')
            : 'Something went wrong. Try again.',
      });
    }
  }, []);

  useEffect(() => {
    // Loading reads the browser's session, so it can only start after mounting.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  if (load.state === 'loading') return <p className="text-sm text-ink-2">Loading…</p>;
  if (load.state === 'signed-out') {
    return (
      <p className="text-sm">
        <Link href="/sign-in" className="font-semibold text-carbon underline">
          Sign in
        </Link>{' '}
        to see what needs you.
      </p>
    );
  }
  if (load.state === 'error') {
    return (
      <p role="alert" className="text-sm text-warn">
        {load.message}
      </p>
    );
  }
  if (load.items.length === 0) {
    return (
      <section aria-labelledby="inbox-empty" className="rounded-xl border border-rule bg-sheet p-5">
        <h2 id="inbox-empty" className="font-semibold">
          Nothing needs you right now
        </h2>
        <p className="mt-1 text-sm text-ink-2">
          Receipts you capture are read automatically. Only the ones ExpenseWise isn&apos;t sure
          about will show up here.
        </p>
      </section>
    );
  }

  const count = load.items.length;
  return (
    <section aria-labelledby="inbox-receipts" className="flex flex-col gap-3">
      <h2 id="inbox-receipts" className="text-sm text-ink-2">
        {count === 1 ? '1 receipt needs you' : `${count} receipts need you`}
      </h2>
      <ul className="flex flex-col gap-3">
        {load.items.map((item) => {
          const { receipt } = item;
          const { text, action, href } = needsYou(item);
          const status = RECEIPT_STATUS[receipt.status];
          const name = receipt.merchant ?? 'A receipt';
          return (
            <li key={receipt.id} className="rounded-xl border border-rule bg-sheet p-4">
              <div className="flex items-baseline justify-between gap-3">
                <p className="min-w-0 truncate font-semibold">{name}</p>
                {receipt.total ? (
                  <p className="font-mono text-sm whitespace-nowrap">
                    {formatMoney(receipt.total)}
                  </p>
                ) : null}
              </div>
              <p className="text-xs text-ink-2">
                <span className="whitespace-nowrap">
                  {receipt.date ?? new Date(receipt.createdAt).toLocaleDateString()}
                </span>{' '}
                · <span className={`font-semibold ${status.tone}`}>{status.label}</span>
              </p>
              <p className="mt-2 text-sm">{text}</p>
              <Link
                href={href}
                className="mt-3 inline-flex min-h-11 items-center rounded-lg bg-carbon px-4 text-sm font-semibold text-carbon-ink"
              >
                {action}
                <span className="sr-only">: {name}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
