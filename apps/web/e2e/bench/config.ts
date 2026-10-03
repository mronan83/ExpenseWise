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

/** What the bench seeded, by name, for the spec to open. */
export interface Seeded {
  readonly trips: Record<'omaha' | 'houston' | 'long' | 'empty', string>;
  readonly receipts: Record<string, string>;
  readonly expenses: Record<string, string>;
}
