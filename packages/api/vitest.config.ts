import { configDefaults, defineConfig } from 'vitest/config';

// Unit tests with in-memory stores. The API on a real database is vitest.int.config.ts.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: [...configDefaults.exclude, 'test/**/*.int.test.ts'],
  },
});
