import { defineConfig } from 'vitest/config';

// The API against Postgres, as expensewise_app, on a throwaway database the db package's
// setup makes and migrates. Needs DATABASE_URL, as the db integration tests do.
export default defineConfig({
  test: {
    include: ['test/**/*.int.test.ts'],
    globalSetup: ['../db/test/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
