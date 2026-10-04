'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/** The five destinations of the tab bar, with capture in the middle (docs/04-app-design.md). */
const TABS = [
  { label: 'Home', href: '/', section: (p: string) => p === '/' },
  { label: 'Expenses', href: '/expenses', section: (p: string) => p.startsWith('/expenses') },
  {
    label: 'Capture',
    href: '/receipts',
    primary: true,
    section: (p: string) => p.startsWith('/receipts'),
  },
  { label: 'Trips', href: '/trips', section: (p: string) => p.startsWith('/trips') },
  { label: 'Reports', href: '/reports', section: (p: string) => p.startsWith('/reports') },
] as const;

/** Screens that stand alone, without the tab bar. */
const WITHOUT_TABS = ['/sign-in'];

/**
 * The tab bar on every screen, held at the bottom while the page scrolls. Each destination is
 * a 44-point target, as iOS asks of anything a thumb taps.
 */
export function TabBar() {
  const path = usePathname();
  // An invite link stands alone too: its person may not be in any organization yet.
  if (WITHOUT_TABS.includes(path) || path.startsWith('/invite/')) return null;
  return (
    <div className="sticky bottom-0 mt-6 border-t border-rule bg-paper">
      <nav
        aria-label="Main"
        className="mx-auto grid max-w-md grid-cols-5 items-center px-4 pt-1 pb-[max(0.25rem,env(safe-area-inset-bottom))] text-center text-xs"
      >
        {TABS.map((tab) => {
          const current = tab.section(path);
          if ('primary' in tab) {
            return (
              <span key={tab.label} className="flex justify-center">
                <Link
                  href={tab.href}
                  aria-current={current ? 'page' : undefined}
                  className="grid size-11 place-items-center rounded-full bg-carbon text-xl text-carbon-ink"
                >
                  <span aria-hidden="true">+</span>
                  <span className="sr-only">{tab.label}</span>
                </Link>
              </span>
            );
          }
          return (
            <Link
              key={tab.label}
              href={tab.href}
              aria-current={current ? 'page' : undefined}
              className={`flex min-h-11 items-center justify-center font-semibold ${current ? 'text-carbon' : 'text-ink-2'}`}
            >
              {tab.label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
