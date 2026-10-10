'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { CaptureMenu } from './capture-menu';
import { CaptureIcon, ExpensesIcon, HomeIcon, ReportsIcon, TripsIcon } from './icons';

/** The five destinations of the tab bar, with capture in the middle (docs/04-app-design.md). */
const TABS = [
  { label: 'Home', href: '/', icon: HomeIcon, section: (p: string) => p === '/' },
  {
    label: 'Expenses',
    href: '/expenses',
    icon: ExpensesIcon,
    section: (p: string) => p.startsWith('/expenses'),
  },
  {
    label: 'Capture',
    href: '/receipts',
    icon: CaptureIcon,
    primary: true,
    section: (p: string) => p.startsWith('/receipts'),
  },
  {
    label: 'Trips',
    href: '/trips',
    icon: TripsIcon,
    section: (p: string) => p.startsWith('/trips'),
  },
  {
    label: 'Reports',
    href: '/reports',
    icon: ReportsIcon,
    section: (p: string) => p.startsWith('/reports'),
  },
] as const;

/** Screens that stand alone, without the tab bar. */
const WITHOUT_TABS = ['/sign-in', '/sign-in/code'];

/**
 * The tab bar on every screen, held at the bottom while the page scrolls. Each destination is
 * its icon above its label (docs/brand.md), a 44-point target, as iOS asks of anything a thumb taps.
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
          const Icon = tab.icon;
          if ('primary' in tab) {
            // Capture opens every way to bring something in (FR-CAP-12).
            return (
              <span key={tab.label} className="flex justify-center">
                <CaptureMenu current={current} />
              </span>
            );
          }
          return (
            <Link
              key={tab.label}
              href={tab.href}
              aria-current={current ? 'page' : undefined}
              className={`flex min-h-11 flex-col items-center justify-center gap-0.5 ${current ? 'font-semibold text-carbon' : 'font-medium text-ink-2'}`}
            >
              <Icon />
              {tab.label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
