import { defineConfig } from 'vitest/config';

// Pure unit tests (gate G2). Integration tests against Postgres use vitest.config.ts.
export default defineConfig({
  test: { include: ['src/**/*.test.ts'] },
});
