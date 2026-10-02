import { redactEvent } from '@expensewise/api/redact';

/** One DSN for server and browser. It is public; without it Sentry stays off. */
export const SENTRY_DSN = process.env.NEXT_PUBLIC_SENTRY_DSN;

/**
 * What error tracking may collect. ExpenseWise holds financial records and receipts, so the
 * SDK's collect-everything defaults are turned down: no request or response bodies, no
 * cookies, no query strings, no database parameters, no local variables, no user details.
 */
export const dataCollection = {
  userInfo: false,
  cookies: false,
  httpHeaders: { request: { allow: ['user-agent', 'content-type'] }, response: false },
  httpBodies: [],
  urlQueryParams: false,
  databaseQueryData: false,
  queues: false,
  genAI: { inputs: false, outputs: false },
  stackFrameVariables: false,
};

export const sharedOptions = {
  dsn: SENTRY_DSN,
  enabled: Boolean(SENTRY_DSN),
  environment: process.env.NEXT_PUBLIC_VERCEL_ENV ?? 'development',
  release: process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA,
  dataCollection,
  // Every trace for now: one user stays far inside the free plan's 5 million spans a month.
  tracesSampleRate: 1,
  // Credentials never leave in messages, exception values or console breadcrumbs.
  beforeSend: redactEvent,
};
