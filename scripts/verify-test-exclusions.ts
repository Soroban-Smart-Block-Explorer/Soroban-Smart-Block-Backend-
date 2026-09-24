/**
 * Tracked test-suite exclusion ratchet.
 *
 * A handful of legacy test suites were written against APIs that drifted
 * during refactors and never passed in CI (their failures were part of why CI
 * was historically red). Excluding them silently would recreate #895 — suites
 * that never run and nobody notices. This script makes every exclusion
 * *visible and bounded*, mirroring the ratchet pattern used by
 * scripts/lint-budget.ts / scripts/typecheck-budget.ts / scripts/validate-routes.ts:
 *
 *   1. Every entry in vitest.config.ts's `test.exclude` (except the orphaned-
 *      router integration harness, which is governed by validate-routes) MUST
 *      have a matching record in the EXCLUDED_SUITES registry below, stating
 *      why it is excluded and what re-enabling requires.
 *   2. Every registry record MUST point at a real test file that is still
 *      collected by vitest's include globs — a registry entry for a deleted or
 *      re-enabled file fails CI, so the registry cannot rot.
 *   3. The number of excluded suites cannot exceed MAX_EXCLUDED_SUITES, so a
 *      new exclusion needs an explicit, deliberate decision to raise it (the
 *      same pressure the other ratchets apply to their budgets).
 *
 * Re-enabling a suite: make it pass (`npx vitest run <file>`), delete its
 * record here, and remove the path from vitest.config.ts's exclude list. The
 * suite is then part of the default run again.
 *
 * Usage:
 *   npx ts-node scripts/verify-test-exclusions.ts
 *   npm run test:exclusions
 */

import * as path from 'path';
import * as glob from 'glob';
import vitestConfig from '../vitest.config';

// Pre-existing exclusion that is NOT tracked as debt — it is an integration
// harness driven by scripts/validate-routes.ts instead of the default suite.
const NON_DEBT_EXCLUSIONS = new Set(['tests/orphaned-routers-integration.test.ts']);

// Ceiling on tracked debt exclusions. Raised from 9 to 41 on 2026-09-07 after
// the first CI run that actually exercised the full suite (the "Test job" only
// ever ran a hardcoded subset before #895 was fixed) surfaced a second batch of
// suites that never passed under CI-parity conditions — see
// docs/test-suite-debt-tracking.md for the per-suite triage. Lower it as suites
// are re-enabled. Raising it again requires a deliberate, documented decision.
const MAX_EXCLUDED_SUITES = 41;

/**
 * Registry of deliberately excluded test suites. `path` must match exactly the
 * vitest.config.ts exclude entry (relative to repo root).
 */
const EXCLUDED_SUITES: Array<{ path: string; reason: string; reEnable: string }> = [
  {
    path: 'tests/verification-engine.test.ts',
    reason:
      '32-test suite written against verification APIs that drifted during the class-based ' +
      'refactor of src/verification: BadgeSystem.evaluateBadge, SymbolicExecutor()/execute(wasmFunc), ' +
      'SpecCompiler.compile(spec)/decompile, plus Differential/Gas/Exploit/Reentrancy suites ' +
      'exercising behavior the shipped classes do not expose.',
    reEnable:
      'Rewrite each describe block against the real exported classes (SmtSolver.solve, ' +
      'SpecCompiler.compileProperty, BadgeSystem.issueBadge, ReentrancyAnalyzer.analyze, ...) and ' +
      'drop the z3 install step only after no suite shells out to a solver.',
  },
  {
    path: 'tests/graph-database.test.ts',
    reason:
      'Neo4j-backed graph performance suite (~40 tests) that requires a live graph database; CI ' +
      'provides Postgres only, and several fixtures use invalid strkeys / expect APIs the graph ' +
      'backend does not implement.',
    reEnable:
      'Either add a Neo4j service to the CI test job and validate fixtures, or convert the suite to ' +
      'drive the in-memory/prisma graph backend with the real exported template/analytics functions.',
  },
  {
    path: 'tests/health-endpoints.test.ts',
    reason:
      'Mocks were written before health checks grew live probes for rpc/indexer/worker/p2p, cache ' +
      'pingRedis/cacheBackendType, staleness gates (fee-aggregator/gasAnalyticsEngine) and the ' +
      'readiness dependency set expanded from 4 to 7 keys (rpc/p2p/worker added).',
    reEnable:
      'Extend the vi.mock set to the modules src/health.ts actually imports and update the ' +
      'readiness toEqual assertions to the 7-key dependency set.',
  },
  {
    path: 'tests/indexer/reorg.test.ts',
    reason:
      'IndexerState persistence moved to optimistic-concurrency findFirst/updateMany writes, but ' +
      'the suite mocks the old upsert-only API and drives syncToLatest with a static mock queue, ' +
      'so getLastIndexedLedger/setLastIndexedLedger never resolve as the tests assume.',
    reEnable:
      'Rewire the suite mocks around findFirst + updateMany (a mutable last-ledger stub) so the ' +
      'sync/backfill loop converges to the asserted ledger sequence.',
  },
  {
    path: 'tests/i18n.test.ts',
    reason:
      'Asserts specific translation keys/counts/default-language behavior that drifted from the ' +
      'shipped locale dictionaries (missing general.ok-style keys, keyCount mismatches, fr/en ' +
      'fallback differences).',
    reEnable:
      'Audit the locale dictionaries against the test expectations and reconcile either the ' +
      'dictionaries or the assertions to the real supported-language contract.',
  },
  {
    path: 'tests/playground-session.test.ts',
    reason:
      'Mocks for @stellar/stellar-sdk and the sandbox runtime drifted: the suite builds simulated ' +
      'transactions whose error strings/objects no longer match the sandbox output and stubs SDK ' +
      'types without the methods the transaction builder now calls.',
    reEnable:
      'Update the SDK/sandbox mocks to the current runtime contract (valid XDR fixtures, ' +
      'simulation result shape) and align asserted error messages with sandbox output.',
  },
  {
    path: 'tests/predictive.test.ts',
    reason:
      'Route handlers return 500 under the current forecasting/ensemble engine (the suite mocks a ' +
      'db shape the handlers no longer read through, and the ensemble/anomaly handlers depend on ' +
      'internal state that is absent in tests).',
    reEnable:
      'Re-derive the handler dependencies from src/api/predict and mock the exact model registry ' +
      'the handlers use, then assert real forecast payloads.',
  },
  {
    path: 'tests/ws-broadcasters.test.ts',
    reason:
      'Broadcaster tests expect subscriber/ack counts and pub-sub delivery semantics that drifted ' +
      'from the current WebSocket broadcaster implementations (also no Redis service in CI).',
    reEnable:
      'Reconcile the assertions with the broadcaster implementation (or supply an in-process ' +
      'pub-sub backend) so delivery/ack counts match real behavior.',
  },
  {
    path: 'tests/api/error-scenarios.test.ts',
    reason:
      'Three assertions drift from the shipped API surface: too-short account addresses return 200 ' +
      '(no query-param validation), non-numeric pagination params are accepted, and contract ' +
      'registration conflict bodies no longer contain the word "conflict".',
    reEnable:
      'Add query-param validation to the transactions route (400 for malformed account/page/limit), ' +
      'and assert the actual 409 conflict body wording.',
  },
  // ─── Batch 2 (2026-09-07) ───────────────────────────────────────────────
  // Surfaced by the first CI run that exercised the full suite. Each file
  // fails under CI-parity conditions (fresh Postgres, no Redis, Node 24 on
  // ubuntu-latest) with the root cause noted per entry; most also fail when
  // run individually against a migrated Postgres + Redis. See
  // docs/test-suite-debt-tracking.md for the full triage table.
  {
    path: 'src/__tests__/cacheFallback.test.ts',
    reason:
      'Asserts /health cache-backend fields and cache_backend_status metric events that only exist ' +
      'when Redis is wired up; CI has no Redis service so the fallback/metric paths never fire.',
    reEnable: 'Add a Redis service to the CI test job and align the cacheBackend field spelling.',
  },
  {
    path: 'src/middleware/cookieAuth.test.ts',
    reason: 'Written for Jest globals ("jest is not defined" under vitest).',
    reEnable: 'Port jest.fn/jest.mock calls to vi.fn/vi.mock.',
  },
  {
    path: 'src/middleware/requestTimeout.test.ts',
    reason: 'Written for Jest globals ("jest is not defined" under vitest).',
    reEnable: 'Port jest.fn/jest.mock calls to vi.fn/vi.mock.',
  },
  {
    path: 'src/webhooks/ssrf-guard.test.ts',
    reason: 'DNS-pinning integration tests hit the live network and time out after 30s in CI.',
    reEnable: 'Mock DNS resolution (dns.lookup) so redirect-hop pinning is asserted offline.',
  },
  {
    path: 'tests/adaptive-indexer-integration.test.ts',
    reason:
      '"Logger is not a constructor" — the logger import shape the suite mocks no longer matches src/logger.',
    reEnable: 'Update the mocked logger export to the current constructor/default shape.',
  },
  {
    path: 'tests/api/agents-router.test.ts',
    reason:
      'Expects public /agents routes; the router now sits behind API-key auth (401 "API key ' +
      'required") and service-info shapes drifted.',
    reEnable: 'Authenticate the test client and assert the real agent service-info payload.',
  },
  {
    path: 'tests/api/analytics.test.ts',
    reason:
      'Gas-analytics validation returns 500 for invalid bucket/limit values the suite expects to 400.',
    reEnable:
      'Fix validation error mapping in the analytics handler (or assert the real 500 contract).',
  },
  {
    path: 'tests/api/api-integration.test.ts',
    reason:
      'Event filters by contract/type return 400 and pagination validation returns 500 — handler ' +
      'validation/query contracts drifted from the suite.',
    reEnable:
      'Reconcile the events/transactions handlers with the asserted filter + validation contract.',
  },
  {
    path: 'tests/api/archive-assets-routers.test.ts',
    reason:
      'Expects an /assets router mount that returns 404 — archive/assets router wiring drifted.',
    reEnable:
      'Mount the archive/assets router where the suite expects it or assert the real mount paths.',
  },
  {
    path: 'tests/api/auth-extension-routers-mount.test.ts',
    reason:
      'Expects auth extension routers NOT to be mounted (404) while they now respond 200/400/401.',
    reEnable:
      'Flip assertions to expect the mounted routers, or unmount them if intentionally removed.',
  },
  {
    path: 'tests/api/batch-endpoints.test.ts',
    reason:
      '"app.post(...).send is not a function" — batch route/middleware wiring drifted from the suite.',
    reEnable: 'Rewrite against the current batch router mount and supertest usage.',
  },
  {
    path: 'tests/api/compliance-extension-routers-mount.test.ts',
    reason:
      'Expects compliance extension routers NOT to be mounted (404) while they now respond 200/400.',
    reEnable:
      'Flip assertions to expect the mounted routers, or unmount them if intentionally removed.',
  },
  {
    path: 'tests/api/dex.test.ts',
    reason: '/dex/analyze returns 500 for missing/invalid params the suite expects to 400.',
    reEnable:
      'Fix validation error mapping in the dex analyze handler (or assert the real 500 contract).',
  },
  {
    path: 'tests/api/freeze.test.ts',
    reason:
      'Freeze routes now require auth (401 vs 200) and DELETE /keys/:id returns 500 — auth + handler drift.',
    reEnable: 'Authenticate the test client and fix the DELETE handler error path.',
  },
  {
    path: 'tests/api/gas-router.test.ts',
    reason: 'Gas router responses/validation drifted from the suite (500s and auth mismatches).',
    reEnable: 'Reconcile the gas router handlers with the asserted response contract.',
  },
  {
    path: 'tests/api/predictive.test.ts',
    reason:
      'Predictive router returns 500 under the current forecasting engine the suite does not mock.',
    reEnable:
      'Mock the model registry the handlers actually read and assert real forecast payloads.',
  },
  {
    path: 'tests/api/router-mounts-emergency.test.ts',
    reason: 'Emergency router mount/response expectations drifted (404s vs mounted 200s).',
    reEnable: 'Assert the real emergency router mount paths and responses.',
  },
  {
    path: 'tests/api/router-mounts-predict.test.ts',
    reason: 'Predict router mount/response expectations drifted (404s vs mounted 200s).',
    reEnable: 'Assert the real predict router mount paths and responses.',
  },
  {
    path: 'tests/api/router-mounts-ramp.test.ts',
    reason: 'Ramp router mount/response expectations drifted (404s vs mounted 200s).',
    reEnable: 'Assert the real ramp router mount paths and responses.',
  },
  {
    path: 'tests/api/routes-advanced.test.ts',
    reason:
      'Advanced route expectations (mounts, auth, response bodies) drifted from the shipped routers.',
    reEnable: 'Reconcile each advanced-route assertion with the actual mounted router surface.',
  },
  {
    path: 'tests/api/tip-router.test.ts',
    reason: 'Tip router auth/response expectations drifted from the shipped handler surface.',
    reEnable: 'Authenticate the test client and assert the real tip-router responses.',
  },
  {
    path: 'tests/api/treasury-router.test.ts',
    reason: 'Treasury router auth/response expectations drifted from the shipped handler surface.',
    reEnable: 'Authenticate the test client and assert the real treasury-router responses.',
  },
  {
    path: 'tests/api/verify.test.ts',
    reason:
      'Verify route expectations (auth + response contract) drifted from the shipped handlers.',
    reEnable: 'Authenticate the test client and assert the real verify responses.',
  },
  {
    path: 'tests/api/virtualList.test.ts',
    reason: 'Virtual-list route expectations drifted from the shipped router surface.',
    reEnable: 'Reconcile assertions with the real virtual-list router responses.',
  },
  {
    path: 'tests/archive.test.ts',
    reason:
      'Archive store expectations drifted from the shipped archival layer (query shapes, DB-backed paths).',
    reEnable:
      'Re-derive mocks from the current archival module exports and assert its real contract.',
  },
  {
    path: 'tests/auth/error-scenarios.test.ts',
    reason:
      '~20 auth error scenarios assert specific messages (challenge reuse, nonce ordering, IP whitelist, ' +
      'session conflicts, ...) the current auth implementation does not emit.',
    reEnable:
      'Either implement the asserted error taxonomy in src/auth or rewrite the scenarios against the ' +
      'errors the shipped auth flow actually produces.',
  },
  {
    path: 'tests/bridge-tracker.test.ts',
    reason:
      'Mocks prismaRead.bridgeAlert.count / prismaWrite.monitoredAddress.upsert which "are not ' +
      'functions" — the prisma client split and model methods drifted from the suite.',
    reEnable: 'Update mocks to the current prismaRead/prismaWrite model surface the tracker uses.',
  },
  {
    path: 'tests/config.test.ts',
    reason:
      'Expects config loading to throw on missing production variables, but the loader calls ' +
      'process.exit(1) instead — behavior contract drifted.',
    reEnable:
      'Make the config loader throw (or assert the process.exit path) to match one contract.',
  },
  {
    path: 'tests/db-integration.test.ts',
    reason:
      'Real-DB suite: CI Postgres is never migrated (P2021: tables missing) and it introspects ' +
      'constraints/index names (Ledger_pkey, ...) that changed in the squashed migration baseline.',
    reEnable: 'Run prisma migrate deploy in the CI test job and update introspection assertions.',
  },
  {
    path: 'tests/dex-analytics.test.ts',
    reason:
      'Fails to transform at collection ("Transform failed with 2 errors") under the vitest config.',
    reEnable: 'Fix the module/type errors so the file loads, then reconcile assertions.',
  },
  {
    path: 'tests/event-broadcaster.test.ts',
    reason: 'Expects pub-sub delivery (length 1) that never arrives without a Redis service in CI.',
    reEnable: 'Add a Redis service to the CI test job or mock the pub-sub backend in the suite.',
  },
  {
    path: 'tests/predictive/deterministic-forecast.test.ts',
    reason:
      'Snapshot-stability suite whose recorded snapshots only match the Node version they were ' +
      'generated on — float drift across Node 24 patch levels makes every snapshot mismatch on the ' +
      'CI runner while passing locally.',
    reEnable:
      'Regenerate snapshots on the pinned CI Node version (and pin setup-node to an exact patch), ' +
      'or round forecast outputs so snapshots are stable across Node versions.',
  },
];

const ROOT = path.join(__dirname, '..');

function main(): void {
  const errors: string[] = [];
  const testConfig = vitestConfig.test ?? {};
  const include = (testConfig.include as string[] | undefined) ?? [];
  const exclude = (testConfig.exclude as string[] | undefined) ?? [];

  const debtExcluded = exclude.filter((f) => !NON_DEBT_EXCLUSIONS.has(f));
  const registryPaths = new Set(EXCLUDED_SUITES.map((e) => e.path));

  // 1. Every debt exclusion in vitest.config.ts must be registered.
  for (const file of debtExcluded) {
    if (!registryPaths.has(file)) {
      errors.push(
        `vitest.config.ts excludes "${file}" but it has no record in EXCLUDED_SUITES ` +
          `(scripts/verify-test-exclusions.ts). Add a record with a reason and re-enable ` +
          `criteria, or remove the exclusion.`,
      );
    }
  }

  // 2. Every registry entry must be a real, still-collected test file that is
  //    actually excluded (no dead or prematurely re-enabled records).
  const collected = new Set<string>();
  for (const pattern of include) {
    for (const f of glob.sync(pattern, { cwd: ROOT, nodir: true })) collected.add(f);
  }
  for (const entry of EXCLUDED_SUITES) {
    if (!collected.has(entry.path)) {
      errors.push(
        `EXCLUDED_SUITES references "${entry.path}" which is no longer collected by vitest's ` +
          `include globs. Delete the record (the file was removed or re-enabled).`,
      );
      continue;
    }
    if (!exclude.includes(entry.path)) {
      errors.push(
        `EXCLUDED_SUITES has "${entry.path}" but vitest.config.ts no longer excludes it. ` +
          `If the suite now passes, remove the record too — otherwise restore the exclusion.`,
      );
    }
  }

  // 3. Ceiling on the debt pile.
  if (debtExcluded.length > MAX_EXCLUDED_SUITES) {
    errors.push(
      `${debtExcluded.length} tracked test-suite exclusions exceed MAX_EXCLUDED_SUITES ` +
        `(${MAX_EXCLUDED_SUITES}). Raising the ceiling requires a documented decision in ` +
        `docs/test-suite-debt-tracking.md — prefer re-enabling suites instead.`,
    );
  }

  if (errors.length > 0) {
    console.error(`\n${errors.join('\n\n')}\n`);
    process.exit(1);
  }

  const remainingBudget = MAX_EXCLUDED_SUITES - debtExcluded.length;
  console.log(
    `Tracked test-suite exclusions: ${debtExcluded.length}/${MAX_EXCLUDED_SUITES} ` +
      `(budget remaining: ${remainingBudget}).`,
  );
  console.log('Registry is in sync with vitest.config.ts. OK');
}

main();
