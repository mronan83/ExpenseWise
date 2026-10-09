/**
 * The Carbon identity (docs/brand.md, ADR-0049): a receipt whose torn edge is a W, on carbon.
 * Drawn here in the theme's own colors, so it follows light and dark; the files in
 * public/brand are the same geometry in fixed colors (scripts/brand-assets.mjs).
 */
const RECEIPT = 'M20 12h24a3 3 0 0 1 3 3v27l-6 9-9-8-9 8-6-9V15a3 3 0 0 1 3-3z';
const LINES = 'M23.5 21h17M23.5 28h11';

/** The mark alone. Decorative wherever the name is beside it. */
export function Mark({ className = 'size-5' }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden="true" focusable="false">
      <rect width="64" height="64" rx="14" fill="var(--carbon)" />
      <path d={RECEIPT} fill="var(--carbon-ink)" />
      <path d={LINES} stroke="var(--carbon)" strokeWidth="3.2" strokeLinecap="round" />
    </svg>
  );
}

/** The mark and the name, at the top of each screen: Expense in SemiBold, Wise in Regular. */
export function Wordmark() {
  return (
    <span className="inline-flex items-center gap-1.5 text-sm text-ink">
      <Mark className="size-5 shrink-0" />
      <span className="self-baseline">
        <span className="font-semibold">Expense</span>Wise
      </span>
    </span>
  );
}
