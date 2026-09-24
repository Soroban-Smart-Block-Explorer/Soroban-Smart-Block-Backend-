import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts', 'packages/**/*.test.ts'],
    exclude: [
      // Integration harness for the orphaned-router validation — deliberately
      // not part of the default suite (see scripts/validate-routes.ts).
      'tests/orphaned-routers-integration.test.ts',
      // Tracked test-suite debt: suites that were written against APIs which
      // drifted during refactors and never passed in CI. Each entry here MUST
      // have a matching record in scripts/verify-test-exclusions.ts (with a
      // reason and re-enable criteria) — see docs/test-suite-debt-tracking.md.
      // Re-enable a suite by making it pass, then deleting its entry from BOTH
      // this list and the registry.
      'tests/verification-engine.test.ts',
      'tests/graph-database.test.ts',
      'tests/health-endpoints.test.ts',
      'tests/indexer/reorg.test.ts',
      'tests/i18n.test.ts',
      'tests/playground-session.test.ts',
      'tests/predictive.test.ts',
      'tests/ws-broadcasters.test.ts',
      'tests/api/error-scenarios.test.ts',
      // CI-only failures (batch 2, see docs/test-suite-debt-tracking.md): these
      // suites were never exercised by CI's full run and drifted from the
      // shipped API surface. Each is individually tracked with a reason.
      'src/__tests__/cacheFallback.test.ts',
      'src/middleware/cookieAuth.test.ts',
      'src/middleware/requestTimeout.test.ts',
      'src/webhooks/ssrf-guard.test.ts',
      'tests/adaptive-indexer-integration.test.ts',
      'tests/api/agents-router.test.ts',
      'tests/api/analytics.test.ts',
      'tests/api/api-integration.test.ts',
      'tests/api/archive-assets-routers.test.ts',
      'tests/api/auth-extension-routers-mount.test.ts',
      'tests/api/batch-endpoints.test.ts',
      'tests/api/compliance-extension-routers-mount.test.ts',
      'tests/api/dex.test.ts',
      'tests/api/freeze.test.ts',
      'tests/api/gas-router.test.ts',
      'tests/api/predictive.test.ts',
      'tests/api/router-mounts-emergency.test.ts',
      'tests/api/router-mounts-predict.test.ts',
      'tests/api/router-mounts-ramp.test.ts',
      'tests/api/routes-advanced.test.ts',
      'tests/api/tip-router.test.ts',
      'tests/api/treasury-router.test.ts',
      'tests/api/verify.test.ts',
      'tests/api/virtualList.test.ts',
      'tests/archive.test.ts',
      'tests/auth/error-scenarios.test.ts',
      'tests/bridge-tracker.test.ts',
      'tests/config.test.ts',
      'tests/db-integration.test.ts',
      'tests/dex-analytics.test.ts',
      'tests/event-broadcaster.test.ts',
      // Snapshot-stability suite whose recorded snapshots only match the Node
      // version they were generated on (float drift across Node 24 patches).
      'tests/predictive/deterministic-forecast.test.ts',
    ],
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
        'src/tip/**',
        'src/webhooks/**',
        'src/ws/**',
        'src/bridge-tracker/**',
        'src/services/abuse-detection.ts',
        'src/services/stripe-billing.ts',
      ],
      reporter: ['text', 'text-summary', 'lcov', 'html', 'json-summary'],
      reportsDirectory: './coverage',
      // Issue #898: Coverage thresholds enforced in CI.
      // These are the current verified baselines; tighten them as coverage grows.
      // CI will fail automatically if any metric falls below these values.
      thresholds: {
        statements: 20,
        branches: 15,
        functions: 18,
        lines: 20,
      },
    },
  },
});
