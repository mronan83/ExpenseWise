import {
  createHttpApp,
  dbAuditStore,
  dbCategoryStore,
  dbExpenseStore,
  dbHomeStore,
  dbOrganizationStore,
  dbMileageStore,
  dbReportStore,
  dbReceiptStore,
  dbTripStore,
  dbWorkspaceStore,
  providerKeyVerifier,
  supabaseTokenVerifier,
} from '@expensewise/api';
import { createReadinessProbe } from '@expensewise/db';
import * as Sentry from '@sentry/nextjs';
import { handle } from 'hono/vercel';
import {
  appDatabase,
  dispatchEvents,
  handOffEmail,
  receiptFiles,
  secretBox,
} from '../../../lib/server';

// The whole versioned API lives in @expensewise/api; Next.js only hands it requests under /api.
// One source for the project URL: it is public, so a server-only copy (such as a Sensitive
// SUPABASE_URL, which nobody can read back) could silently point verification elsewhere.
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const db = appDatabase();

const handler = handle(
  createHttpApp({
    version: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? 'dev',
    // Without a Supabase project, protected routes answer 503 rather than failing the build.
    verifyToken: supabaseUrl ? supabaseTokenVerifier({ projectUrl: supabaseUrl }) : undefined,
    // Connects lazily on the first readiness request, with one connection per instance.
    readiness: createReadinessProbe(process.env.DATABASE_URL),
    // Tenant data as expensewise_app; the pool connects on first use.
    workspace: db && dbWorkspaceStore(db),
    organization: db && dbOrganizationStore(db),
    receipts: db && dbReceiptStore(db),
    expenses: db && dbExpenseStore(db),
    trips: db && dbTripStore(db),
    mileage: db && dbMileageStore(db),
    home: db && dbHomeStore(db),
    reports: db && dbReportStore(db),
    audit: db && dbAuditStore(db),
    categories: db && dbCategoryStore(db),
    files: receiptFiles(),
    dispatch: dispatchEvents,
    secrets: secretBox(),
    // Email-in (ADR-0026): Bird's webhook is checked with this secret, then handed off.
    birdWebhookSecret: process.env.BIRD_WEBHOOK_SECRET || undefined,
    receiveEmail: handOffEmail,
    verifyProviderKey: providerKeyVerifier(),
    // Features forced on or off for everyone, beating each owner's switch (the kill switch).
    flagOverrides: process.env.FLAG_OVERRIDES,
    // Unexpected errors go to error tracking (a no-op until NEXT_PUBLIC_SENTRY_DSN is set).
    reportError: (error) => Sentry.captureException(error),
  }),
);

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const PATCH = handler;
export const DELETE = handler;
