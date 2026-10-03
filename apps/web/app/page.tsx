import Link from 'next/link';
import { connection } from 'next/server';
import { flags } from '../lib/flags';
import { HomeDashboard } from './home-dashboard';

/** Home: the Needs you inbox, then the person's trip, month and recent trips (FR-INS-01). */
export default async function HomePage() {
  // Flags are read per request, so turning one on needs no redeploy.
  await connection();
  const showBuild = await flags.isEnabled('shell.build-version');
  const build = process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? 'dev';

  return (
    <div className="mx-auto flex w-full max-w-md flex-1 flex-col px-4 pt-[max(1rem,env(safe-area-inset-top))]">
      <header className="flex items-baseline justify-between py-3">
        <span className="font-mono text-xs tracking-widest text-ink-2 uppercase">ExpenseWise</span>
        <span className="flex items-baseline gap-3">
          <span className="font-mono text-xs text-ink-3">
            Phase 0 preview{showBuild ? ` · ${build}` : ''}
          </span>
          <Link href="/settings/ai" className="tap text-xs font-semibold text-carbon">
            Settings
          </Link>
        </span>
      </header>

      <main className="flex flex-1 flex-col gap-4 pb-8">
        <HomeDashboard />
      </main>
    </div>
  );
}
