import Link from 'next/link';
import { connection } from 'next/server';
import { flags } from '../lib/flags';

const destinations = [
  { label: 'Home', current: true },
  { label: 'Expenses', href: '/expenses' },
  { label: 'Capture', primary: true },
  { label: 'Trips', href: '/trips' },
  { label: 'Reports' },
] as const;

/** Phase 0 app shell: the inbox layout and tab bar, with no data behind them yet. */
export default async function HomePage() {
  // Flags are read per request, so turning one on needs no redeploy.
  await connection();
  const showBuild = await flags.isEnabled('shell.build-version');
  const build = process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? 'dev';

  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col px-4 pt-[max(1rem,env(safe-area-inset-top))]">
      <header className="flex items-baseline justify-between py-3">
        <span className="font-mono text-xs tracking-widest text-ink-2 uppercase">ExpenseWise</span>
        <span className="flex items-baseline gap-3">
          <span className="font-mono text-xs text-ink-3">
            Phase 0 preview{showBuild ? ` · ${build}` : ''}
          </span>
          <Link href="/settings/ai" className="text-xs font-semibold text-carbon">
            Settings
          </Link>
        </span>
      </header>

      <main className="flex flex-1 flex-col gap-4">
        <h1 className="text-2xl font-bold">Needs you</h1>
        <section
          aria-labelledby="inbox-empty"
          className="rounded-xl border border-rule bg-sheet p-5"
        >
          <h2 id="inbox-empty" className="font-semibold">
            Nothing needs you right now
          </h2>
          <p className="mt-1 text-sm text-ink-2">
            Receipts you capture are read automatically. Only the ones ExpenseWise isn&apos;t sure
            about will show up here.
          </p>
        </section>
      </main>

      <nav
        aria-label="Main"
        className="sticky bottom-0 mt-6 grid grid-cols-5 items-center border-t border-rule bg-paper pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] text-center text-xs"
      >
        {destinations.map((d) =>
          'primary' in d ? (
            <span key={d.label} className="flex justify-center">
              <Link
                href="/receipts"
                className="grid size-11 place-items-center rounded-full bg-carbon text-xl text-carbon-ink"
              >
                <span aria-hidden="true">+</span>
                <span className="sr-only">{d.label}</span>
              </Link>
            </span>
          ) : 'href' in d ? (
            <Link key={d.label} href={d.href} className="font-semibold text-ink-2">
              {d.label}
            </Link>
          ) : (
            <span
              key={d.label}
              aria-current={'current' in d ? 'page' : undefined}
              aria-disabled={'current' in d ? undefined : 'true'}
              className={'current' in d ? 'font-semibold text-carbon' : 'text-ink-3'}
            >
              {d.label}
            </span>
          ),
        )}
      </nav>
    </div>
  );
}
