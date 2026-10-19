import { withSentryConfig } from '@sentry/nextjs/config';
import type { NextConfig } from 'next';

const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  // Capture needs the camera on our own origin; nothing else gets device access.
  { key: 'Permissions-Policy', value: 'camera=(self), microphone=(), geolocation=()' },
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
];

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Workspace packages ship TypeScript source; Next compiles them.
  transpilePackages: [
    '@expensewise/api',
    '@expensewise/db',
    '@expensewise/domain',
    '@expensewise/extraction',
    '@expensewise/flags',
    '@expensewise/storage',
    '@expensewise/workflows',
  ],
  headers: () =>
    Promise.resolve([
      { source: '/:path*', headers: securityHeaders },
      // The service worker that shows notifications is checked for a new copy on every load.
      { source: '/sw.js', headers: [{ key: 'Cache-Control', value: 'no-cache' }] },
    ]),
};

// Error tracking (Sentry). Source maps upload only when SENTRY_AUTH_TOKEN is set; without it
// the build still succeeds and browser stack traces stay minified.
export default withSentryConfig(config, {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  sourcemaps: { disable: !process.env.SENTRY_AUTH_TOKEN },
  silent: !process.env.SENTRY_AUTH_TOKEN,
  telemetry: false,
});
