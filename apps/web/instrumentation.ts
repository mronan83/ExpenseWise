import * as Sentry from '@sentry/nextjs';

// Next.js runs register() once per server instance, before any request.
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') await import('./sentry.server.config');
}

// Errors thrown while rendering pages and route handlers. The API catches its own errors
// and reports them through reportError (see app/api/[[...route]]/route.ts).
export const onRequestError = Sentry.captureRequestError;
