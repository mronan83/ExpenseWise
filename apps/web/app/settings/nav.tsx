'use client';

import Link from 'next/link';
import { useFeatures } from '../../lib/features';

/** Settings pages. One with a flag shows only while that feature is on (Q5). */
const PAGES: readonly { href: string; label: string; flag?: string }[] = [
  { href: '/settings/ai', label: 'AI providers' },
  { href: '/settings/sign-ins', label: 'Sign-ins' },
  { href: '/settings/features', label: 'Features' },
  { href: '/settings/categories', label: 'Categories', flag: 'expenses.categories' },
];

/** Moves between the settings pages. */
export function SettingsNav({ current }: { current: string }) {
  const on = useFeatures();
  const pages = PAGES.filter((p) => !p.flag || on(p.flag) || p.href === current);
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
