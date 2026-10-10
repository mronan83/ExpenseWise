/*
 * The signed-in end-to-end checks (#54): a bench API on its own database, and the stand-in
 * Supabase project the web app is built with for them. Shared by the bench, the Playwright
 * config and the spec.
 */

/** Where the bench API listens. */
export const BENCH_PORT = 3999;
export const BENCH_URL = `http://127.0.0.1:${BENCH_PORT}`;

/**
 * The Supabase project the web app is built with for end-to-end runs. Nothing answers there:
 * `.invalid` never resolves, and the tests answer its requests themselves.
 */
export const E2E_SUPABASE_URL = 'https://e2e.supabase.invalid';
export const E2E_SUPABASE_KEY = 'sb_publishable_e2e';

/** Where supabase-js keeps the session for that project: sb-<first label of the host>-auth-token. */
export const E2E_SESSION_KEY = 'sb-e2e-auth-token';

/** The bench signs a request in as whoever its bearer token names. */
export const E2E_USER = 'riley';

/**
 * The day `offset` days from the bench's day 0, as YYYY-MM-DD. Every date the bench seeds and
 * the spec types or expects is one of these, so each receipt, trip, drive and report stands
 * where it was meant to against the day the checks run, whatever that day is: a receipt is
 * never a year older than its upload, a past trip has ended and a future one hasn't begun.
 */
export function benchDay(today: string, offset: number): string {
  const at = new Date(`${today}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + offset);
  return at.toISOString().slice(0, 10);
}

/** What the bench seeded, by name, for the spec to open. */
export interface Seeded {
  /** The bench's day 0: the UTC day it started, which every seeded date counts from. */
  readonly today: string;
  readonly trips: Record<'omaha' | 'houston' | 'long' | 'empty', string>;
  readonly receipts: Record<string, string>;
  readonly expenses: Record<string, string>;
  /**
   * open: still needing review, with a justified and an unjustified local expense. toApprove:
   * Sam's, waiting for Riley's approval. returned: Riley's, which Casey returned with its drive
   * rejected (#24).
   */
  readonly reports: Record<'open' | 'closed' | 'toApprove' | 'returned', string>;
  /**
   * Links to another organization (#29): one Riley's own work stops Riley joining, and one its
   * owner revoked.
   */
  readonly invites: Record<'join' | 'revoked', string>;
  /** Card charges by name: the flight's, with no expense, for adding its receipt (AC17). */
  readonly charges: Record<'delta', string>;
}
