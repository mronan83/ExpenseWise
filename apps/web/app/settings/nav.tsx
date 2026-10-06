'use client';

import Link from 'next/link';
import { useFeatures } from '../../lib/features';

/**
 * Settings pages. One with a flag shows only while that feature is on (Q5); one with several,
 * while any of them is.
 */
const PAGES: readonly { href: string; label: string; flag?: string | readonly string[] }[] = [
  {
    href: '/settings/organization',
    label: 'Organization',
    flag: ['settings.organization', 'settings.duplicate-window', 'expenses.company-paid'],
  },
  { href: '/settings/ai', label: 'AI providers' },
  { href: '/settings/ai-models', label: 'AI models', flag: 'receipts.model-settings' },
  { href: '/settings/sign-ins', label: 'Sign-ins' },
  { href: '/settings/currency', label: 'Currency', flag: 'reports.currency-conversion' },
  {
    href: '/settings/mileage',
    label: 'Mileage',
    flag: ['expenses.mileage', 'expenses.route-mileage'],
  },
  { href: '/settings/features', label: 'Features' },
  { href: '/settings/audit', label: 'Audit trail', flag: 'governance.audit-trail' },
  { href: '/settings/categories', label: 'Categories', flag: 'expenses.categories' },
  { href: '/settings/people', label: 'People', flag: 'team.invites' },
];

/** Moves between the settings pages. */
export function SettingsNav({ current }: { current: string }) {
  const on = useFeatures();
  const pages = PAGES.filter((p) => !p.flag || [p.flag].flat().some(on) || p.href === current);
  return (
    <nav
      aria-label="Settings"
      className="flex flex-wrap gap-x-4 gap-y-2 border-b border-rule text-sm"
    >
      {pages.map((p) => (
        <Link
          key={p.href}
          href={p.href}
          aria-current={p.href === current ? 'page' : undefined}
          className={
            p.href === current
              ? 'tap -mb-px border-b-2 border-carbon pb-2 font-semibold'
              : 'tap pb-2 text-ink-2'
          }
        >
          {p.label}
        </Link>
      ))}
    </nav>
  );
}
