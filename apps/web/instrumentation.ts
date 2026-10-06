import type { Instrumentation } from 'next';

// Without a DSN error tracking is off, so the server never loads it: it would add about a
// quarter of a second to every function's cold start, Bird's webhook's included (#93).
const errorTracking = Boolean(process.env.NEXT_PUBLIC_SENTRY_DSN);

// Next.js runs register() once per server instance, before any request.
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs' && errorTracking) {
    await import('./sentry.server.config');
  }
}

// Errors thrown while rendering pages and route handlers. The API catches its own errors
// and reports them through reportError (see app/api/[[...route]]/route.ts).
export const onRequestError: Instrumentation.onRequestError = async (...args) => {
  if (!errorTracking) return;
  const Sentry = await import('@sentry/nextjs');
  Sentry.captureRequestError(...args);
};
