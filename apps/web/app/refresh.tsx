'use client';

import { useEffect, useState } from 'react';
import { RefreshIcon } from './icons';

/** How far a pull travels, after damping, before letting go refreshes the screen. */
const PULL_TO_REFRESH = 64;
/** A finger moves twice as far as the pull shows, as iOS's own pull does. */
const DAMPING = 0.5;

/** Loads the screen again, as Safari's reload would: its data, and any new release. */
const reload = () => window.location.reload();

/**
 * Refreshes the screen (#111): the Home Screen app has no Safari bar to reload it from. A
 * button, so the screen can be refreshed without dragging (WCAG 2.5.1), beside pull to refresh.
 */
export function RefreshButton() {
  return (
    <button
      type="button"
      onClick={reload}
      aria-label="Refresh"
      title="Refresh"
      className="tap inline-flex size-6 items-center justify-center self-center text-carbon"
    >
      <RefreshIcon />
    </button>
  );
}

/**
 * Pull down from the top of any screen and let go to refresh it (#111), as Safari does outside
 * the Home Screen app. Only with one finger, from the very top, never inside an open dialog or
 * a field; the circle turns as the pull grows and says when letting go will refresh.
 */
export function PullToRefresh() {
  const [pull, setPull] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    let from: number | null = null;
    let distance = 0;
    const start = (event: TouchEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (
        event.touches.length !== 1 ||
        window.scrollY > 0 ||
        target?.closest('dialog[open], input, textarea, select, [data-no-pull]')
      ) {
        from = null;
        return;
      }
      from = event.touches[0]!.clientY;
      distance = 0;
    };
    const move = (event: TouchEvent) => {
      if (from === null) return;
      if (event.touches.length !== 1 || window.scrollY > 0) {
        from = null;
        setPull(0);
        return;
      }
      distance = Math.max(0, (event.touches[0]!.clientY - from) * DAMPING);
      setPull(Math.min(distance, PULL_TO_REFRESH * 1.5));
    };
    const end = () => {
      if (from === null) return;
      from = null;
      if (distance >= PULL_TO_REFRESH) {
        setRefreshing(true);
        reload();
      } else {
        setPull(0);
      }
    };
    window.addEventListener('touchstart', start, { passive: true });
    window.addEventListener('touchmove', move, { passive: true });
    window.addEventListener('touchend', end);
    window.addEventListener('touchcancel', end);
    return () => {
      window.removeEventListener('touchstart', start);
      window.removeEventListener('touchmove', move);
      window.removeEventListener('touchend', end);
      window.removeEventListener('touchcancel', end);
    };
  }, []);

  const ready = pull >= PULL_TO_REFRESH;
  const shown = refreshing || pull > 0;
  return (
    <div
      aria-hidden={!refreshing}
      className="pointer-events-none fixed inset-x-0 top-[max(0.5rem,env(safe-area-inset-top))] z-40 flex justify-center"
      style={{ opacity: shown ? Math.min(1, pull / PULL_TO_REFRESH) || 1 : 0 }}
    >
      {shown ? (
        <span
          role="status"
          className={`flex items-center gap-2 rounded-full border border-rule bg-sheet px-3 py-1.5 text-xs font-semibold shadow-sm ${
            ready || refreshing ? 'text-carbon' : 'text-ink-2'
          }`}
        >
          <span
            className={refreshing ? 'animate-spin motion-reduce:animate-none' : ''}
            style={
              refreshing ? undefined : { transform: `rotate(${(pull / PULL_TO_REFRESH) * 270}deg)` }
            }
          >
            <RefreshIcon />
          </span>
          {refreshing ? 'Refreshing…' : ready ? 'Let go to refresh' : 'Pull to refresh'}
        </span>
      ) : null}
    </div>
  );
}
