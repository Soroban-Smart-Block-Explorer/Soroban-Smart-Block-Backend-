import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    exclude: ['tests/orphaned-routers-integration.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    teardownTimeout: 10_000,
    retry: 2,
    poolOptions: {
      threads: {
        singleThread: false,
      },
    },
    // Exclude heavy native/stellar modules from Vite's bundler so they are
    // loaded as-is from node_modules — cuts peak heap usage during test
    // collection and prevents OOM crashes on the worker subprocess.
    server: {
      deps: {
        external: [
          /node_modules\/@stellar\/stellar-sdk/,
          /node_modules\/stellar-sdk/,
          /node_modules\/@stellar\/stellar-base/,
          /node_modules\/ws/,
          /node_modules\/@aws-sdk/,
          /node_modules\/prisma/,
          /node_modules\/@prisma/,
        ],
      },
    },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        'src/types/**',
        'src/**/*.d.ts',
        'src/**/*.test.ts',
        'src/**/__mocks__/**',
        'src/index.ts',
        'src/db.ts',
        'src/config.ts',
        'src/reputation/**',
        'src/sdk/**',
        'src/tip/**',
        'src/webhooks/**',
        'src/ws/**',
        'src/bridge-tracker/**',
        'src/services/abuse-detection.ts',
        'src/services/stripe-billing.ts',
      ],
      reporter: ['text', 'text-summary', 'lcov', 'html', 'json-summary'],
      reportsDirectory: './coverage',
      thresholds: {
        statements: 20,
        branches: 15,
        functions: 18,
        lines: 20,
      },
    },
  },
});
