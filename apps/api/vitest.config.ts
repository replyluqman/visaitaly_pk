import { defineConfig } from 'vitest/config';

/**
 * Integration tests run against a REAL Postgres (docs/TESTING.md Gate 3).
 * Files run serially: they share one database and truncate between tests.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    setupFiles: ['test/setup.ts'],
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
});
