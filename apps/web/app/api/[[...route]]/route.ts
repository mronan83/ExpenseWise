import {
  createHttpApp,
  createSecretBox,
  dbWorkspaceStore,
  providerKeyVerifier,
  supabaseTokenVerifier,
} from '@expensewise/api';
import { createDatabase, createReadinessProbe } from '@expensewise/db';
import * as Sentry from '@sentry/nextjs';
import { handle } from 'hono/vercel';

// The whole versioned API lives in @expensewise/api; Next.js only hands it requests under /api.
// One source for the project URL: it is public, so a server-only copy (such as a Sensitive
// SUPABASE_URL, which nobody can read back) could silently point verification elsewhere.
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const databaseUrl = process.env.DATABASE_URL;
// AI provider keys are encrypted with a key derived from this server-only secret (ADR-0015).
const encryptionSecret = process.env.APP_ENCRYPTION_KEY || process.env.SUPABASE_SECRET_KEY;

/** Builds an optional dependency; a bad setting disables its routes (503) instead of the API. */
function optional<T>(name: string, build: () => T): T | undefined {
  try {
    return build();
  } catch (error) {
    console.error(`${name} is not usable; its routes will answer 503`, error);
    return undefined;
  }
}

const handler = handle(
  createHttpApp({
    version: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? 'dev',
    // Without a Supabase project, protected routes answer 503 rather than failing the build.
    verifyToken: supabaseUrl ? supabaseTokenVerifier({ projectUrl: supabaseUrl }) : undefined,
    // Connects lazily on the first readiness request, with one connection per instance.
    readiness: createReadinessProbe(process.env.DATABASE_URL),
    // Tenant data as expensewise_app. The pool connects on first use; two connections per
    // instance stay well inside the transaction pooler's limits.
    workspace: databaseUrl
      ? optional('DATABASE_URL', () => dbWorkspaceStore(createDatabase(databaseUrl, { max: 2 }).db))
      : undefined,
    secrets: encryptionSecret
      ? optional('The key encryption secret', () => createSecretBox(encryptionSecret))
      : undefined,
    verifyProviderKey: providerKeyVerifier(),
    // Unexpected errors go to error tracking (a no-op until NEXT_PUBLIC_SENTRY_DSN is set).
    reportError: (error) => Sentry.captureException(error),
  }),
);

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const PATCH = handler;
export const DELETE = handler;
