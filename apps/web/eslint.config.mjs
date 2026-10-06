import nextVitals from 'eslint-config-next/core-web-vitals';
import { defineConfig } from 'eslint/config';
import root from '../../eslint.config.js';

// The root config already applies type-aware typescript-eslint rules. Next's own
// TypeScript block registers a second copy of that plugin, so keep only its React,
// hooks and Core Web Vitals rules.
const nextRules = nextVitals.filter((config) => config.name !== 'next/typescript');

// Bird's webhook is a function of its own (#93): a cold start loads the signature check and the
// hand-off, never the API, the database or the workflows, so Bird has its answer in time.
const birdWebhookStaysSmall = {
  files: ['app/api/v1/inbound/**/*.ts', 'lib/email-in.ts'],
  rules: {
    'no-restricted-imports': [
      'error',
      {
        paths: [
          {
            name: '@expensewise/api',
            message: 'Import @expensewise/api/bird-webhook: this loads the whole API (#93).',
          },
          {
            name: '@expensewise/workflows',
            message: 'Import @expensewise/workflows/client: this loads every workflow (#93).',
          },
        ],
        patterns: [
          {
            group: [
              '@expensewise/db',
              '@expensewise/domain',
              '@expensewise/extraction',
              '@expensewise/flags',
              '@expensewise/storage',
              '**/lib/server',
              '@sentry/*',
              'hono',
              'hono/*',
            ],
            message: 'Bird’s webhook loads only the signature check and the hand-off (#93).',
          },
        ],
      },
    ],
  },
};

// Root comes last so its type-aware TypeScript parser wins over Next's default parser.
export default defineConfig(nextRules, root, birdWebhookStaysSmall, {
  ignores: ['.next/**', 'playwright-report/**', 'test-results/**', 'next-env.d.ts'],
});
