import { PostHog } from 'posthog-node';
import type { FlagContext, FlagSource } from './flags.ts';
import type { FlagKey } from './registry.ts';

export interface PostHogSourceOptions {
  /** The project token (phc_…). It is public; remote evaluation needs nothing else. */
  readonly apiKey: string;
  /** https://us.i.posthog.com or https://eu.i.posthog.com. */
  readonly host?: string;
  /** Reuse an answer this long per distinct id, so a page view costs no extra round trip. */
  readonly cacheMs?: number;
  readonly now?: () => number;
}

/** The distinct id for flags evaluated without a signed-in user. */
export const SERVER_DISTINCT_ID = 'expensewise-server';

/**
 * PostHog as the flag source, with remote evaluation: PostHog advises against local
 * evaluation on serverless, and one remote call per distinct id every 30 seconds stays far
 * inside the free plan's million flag requests a month.
 */
export function posthogSource(options: PostHogSourceOptions): FlagSource {
  const client = new PostHog(options.apiKey, {
    host: options.host ?? 'https://us.i.posthog.com',
    // Serverless instances freeze between requests; don't hold events in memory for long.
    flushAt: 1,
    flushInterval: 0,
  });
  const cacheMs = options.cacheMs ?? 30_000;
  const now = options.now ?? Date.now;
  const cache = new Map<
    string,
    { at: number; values: Promise<Partial<Record<FlagKey, boolean>>> }
  >();

  return {
    evaluate(keys: readonly FlagKey[], context: FlagContext) {
      const distinctId = context.distinctId ?? SERVER_DISTINCT_ID;
      const hit = cache.get(distinctId);
      if (hit && now() - hit.at < cacheMs) return hit.values;
      const values = client.evaluateFlags(distinctId, { flagKeys: [...keys] }).then((snapshot) => {
        const out: Partial<Record<FlagKey, boolean>> = {};
        for (const key of keys) {
          const value = snapshot.getFlag(key);
          if (value !== undefined) out[key] = value !== false;
        }
        return out;
      });
      // A failed lookup is not cached, so the next request tries again.
      values.catch(() => cache.delete(distinctId));
      cache.set(distinctId, { at: now(), values });
      return values;
    },
  };
}
