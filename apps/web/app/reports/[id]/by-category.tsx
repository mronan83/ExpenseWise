'use client';

import { useEffect, useState } from 'react';
import { api } from '../../../lib/api';
import type { ReportCategories } from '../../../lib/itemized';
import { formatMoney } from '../../../lib/receipts';

/**
 * What a report comes to by category and type (FR-EXP-15): each part of a split expense under
 * its own, every other expense under its own, as spent, and in the report's currency while
 * currency conversion is on. Shown while splits and categories are switched on.
 */
export function ByCategory({ reportId }: { reportId: string }) {
  const [shown, setShown] = useState<ReportCategories | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    void api<ReportCategories>(`/v1/reports/${reportId}/categories`).then(
      (found) => {
        if (live) setShown(found);
      },
      () => {
        if (live) setFailed(true);
      },
    );
    return () => {
      live = false;
    };
  }, [reportId]);

  if (failed || !shown || shown.rows.length === 0) return null;
  return (
    <section aria-labelledby="categories-title" className="flex flex-col gap-2">
      <h2
        id="categories-title"
        className="text-xs font-semibold tracking-wider text-ink-2 uppercase"
      >
        By category and type
      </h2>
      <ul className="flex flex-col divide-y divide-rule rounded-xl border border-rule bg-sheet">
        {shown.rows.map((row) => (
          <li
            key={`${row.category?.id ?? 'none'}-${row.type?.id ?? 'none'}`}
            className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 px-4 py-3 text-sm"
          >
            <span className="break-words">
              {row.category && row.type
                ? `${row.category.name} › ${row.type.name}`
                : 'No category or type yet'}
            </span>
            <span className="text-right font-mono whitespace-nowrap">
              {row.reimbursed
                ? formatMoney(row.reimbursed)
                : row.totals.map(formatMoney).join(' + ')}
            </span>
            {row.reimbursed ? (
              <span className="col-span-2 text-right text-xs break-words text-ink-2">
                spent {row.totals.map(formatMoney).join(' + ')}
                {row.converting ? ` · ${row.converting} still converting` : ''}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
