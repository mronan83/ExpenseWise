import Link from 'next/link';

const PAGES = [
  { href: '/settings/ai', label: 'AI providers' },
  { href: '/settings/sign-ins', label: 'Sign-ins' },
] as const;

/** Moves between the settings pages. */
export function SettingsNav({ current }: { current: (typeof PAGES)[number]['href'] }) {
  return (
    <nav aria-label="Settings" className="flex gap-4 border-b border-rule text-sm">
      {PAGES.map((p) => (
        <Link
          key={p.href}
          href={p.href}
          aria-current={p.href === current ? 'page' : undefined}
          className={
            p.href === current
              ? '-mb-px border-b-2 border-carbon pb-2 font-semibold'
              : 'pb-2 text-ink-2'
          }
        >
          {p.label}
        </Link>
      ))}
    </nav>
  );
}
