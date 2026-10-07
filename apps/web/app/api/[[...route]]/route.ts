import {
  createHttpApp,
  dbApprovalStore,
  dbAuditStore,
  dbCategoryStore,
  dbCompanyPaidStore,
  dbExpenseStore,
  dbHomeStore,
  dbItemizedStore,
  dbCardStore,
  dbOrganizationStore,
  dbMileageRateStore,
  dbMileageStore,
  dbModelSettingsStore,
  dbReimbursementStore,
  dbPeopleStore,
  dbReportStore,
  dbReceiptStore,
  dbRouteKeyStore,
  dbRouteMileageStore,
  dbTripStore,
  dbUnfiledEmailStore,
  dbWorkspaceStore,
  providerKeyVerifier,
  supabaseTokenVerifier,
} from '@expensewise/api';
import { createReadinessProbe } from '@expensewise/db';
import { routeKeyVerifier } from '@expensewise/workflows';
import { handle } from 'hono/vercel';
import { appDatabase, dispatchEvents, receiptFiles, secretBox } from '../../../lib/server';

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
    mileageRates: db && dbMileageRateStore(db),
    routeMileage: db && dbRouteMileageStore(db),
    routeKeys: db && dbRouteKeyStore(db),
    home: db && dbHomeStore(db),
    reports: db && dbReportStore(db),
    approvals: db && dbApprovalStore(db),
    audit: db && dbAuditStore(db),
    categories: db && dbCategoryStore(db),
    itemized: db && dbItemizedStore(db),
    cards: db && dbCardStore(db),
    companyPaid: db && dbCompanyPaidStore(db),
    modelSettings: db && dbModelSettingsStore(db),
    reimbursement: db && dbReimbursementStore(db),
    people: db && dbPeopleStore(db),
    emails: db && dbUnfiledEmailStore(db),
    files: receiptFiles(),
    dispatch: dispatchEvents,
    secrets: secretBox(),
    // Email-in's webhook isn't configured here: app/api/v1/inbound/bird answers it as a function
    // of its own (#93). A delivery that ever reached this one would get 503, and Bird retries.
    verifyProviderKey: providerKeyVerifier(),
    // An OpenRouteService key is checked with one short route as it is saved (ADR-0039).
    verifyRouteKey: routeKeyVerifier(),
    // Features forced on or off for everyone, beating each owner's switch (the kill switch).
    flagOverrides: process.env.FLAG_OVERRIDES,
    // Unexpected errors go to error tracking, loaded only once NEXT_PUBLIC_SENTRY_DSN is set, so
    // a cold start doesn't pay for it while it is off (#93).
    reportError: process.env.NEXT_PUBLIC_SENTRY_DSN
      ? (error) => void import('@sentry/nextjs').then((Sentry) => Sentry.captureException(error))
      : undefined,
  }),
);

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const PATCH = handler;
export const DELETE = handler;
