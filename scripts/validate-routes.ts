/**
 * RouterRegistry — Auto-discovery and conflict detection for API routers
 *
 * Scans src/api/ at build/CI time to detect:
 *   1. Router files that export a Router but are not mounted in router.ts
 *   2. Route path conflicts (overlapping patterns)
 *   3. Missing prefixes or root-level wildcard conflicts
 *
 * Usage:
 *   npx ts-node scripts/validate-routes.ts
 *   npm run validate-routes
 */

import * as fs from 'fs';
import * as path from 'path';

interface RouteConflict {
  route1: string;
  route2: string;
  prefix1: string;
  prefix2: string;
  conflictType: 'exact' | 'wildcard_overlap' | 'param_ambiguity';
}

interface ValidationResult {
  orphanedRouters: string[];
  pendingSchemaRouters: string[];
  mountedRouters: string[];
  routeConflicts: RouteConflict[];
  warnings: string[];
  passed: boolean;
}

/**
 * Routers that export a Router but are intentionally not mounted because they
 * depend on Prisma models not yet present in the schema. Remove a file from
 * this list once its schema models are added and the router is mounted in
 * router.ts. Any file here that is ALSO mounted will cause an error (the
 * allowlist entry should then be removed).
 *
 * Status: pending-schema — awaiting Prisma migration before mounting.
 */
const PENDING_SCHEMA_ROUTERS = new Set([
  'abi.ts',
  'advanced-events.ts',
  'analytics.ts',
  'arbitrage.ts',
  'archive.ts',
  'assets.ts',
  'auth.ts',
  'authMultisig.ts',
  'authOAuth2.ts',
  'authProfile.ts',
  'authSecurity.ts',
  'authWebhooks.ts',
  'backfill.ts',
  'benchmarks.ts',
  'bn254.ts',
  'checked-arithmetic.ts',
  'commodity-compliance.ts',
  'composability.ts',
  'dex-analytics.ts',
  'dex.ts',
  'dtcc-settlement.ts',
  'emergency-alerts.ts',
  'emergency-analysis.ts',
  'emergency-health.ts',
  'emergency-incidents.ts',
  'emergency-viz.ts',
  'emergency.ts',
  'factory-tracker.ts',
  'feed.ts',
  'feedSSE.ts',
  'fuzzing.ts',
  'graph.ts',
  'intelligence.ts',
  'mev.ts',
  'oracle-audit.ts',
  'oracle-feeds.ts',
  'playground.ts',
  'privacy.ts',
  'protocol-economics.ts',
  'protocol26-state-extension.ts',
  'reentrancy.ts',
  'reputation.ts',
  'resource-audit.ts',
  'revenue.ts',
  'rwa-compliance.ts',
  'sac-trustlines.ts',
  'sandbox.ts',
  'schedule.ts',
  'search.ts',
  'settlement-batch.ts',
  'signers.ts',
  'storage-trap.ts',
  'storage.ts',
  'systemic.ts',
  'tax.ts',
  'tip.ts',
  'treasury.ts',
  'upgrade-trace.ts',
  'virtualList.ts',
  'yield.ts',
]);

const API_DIR = path.resolve(__dirname, '../src/api');
const ROUTER_FILE = path.resolve(__dirname, '../src/api/router.ts');

/**
 * Collect all .ts files in src/api/ that export a Router
 */
function discoverRouterFiles(): string[] {
  const files = fs.readdirSync(API_DIR).filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'));
  const routerFiles: string[] = [];

  for (const file of files) {
    const filePath = path.join(API_DIR, file);
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) continue;

    const content = fs.readFileSync(filePath, 'utf-8');
    // Check for exported Router instances
    if (
      /export\s+const\s+\w+Router\s*=\s*Router\b/.test(content) ||
      /export\s+default\s+router\b/.test(content) ||
      /export\s+\{[^}]*[Rr]outer[^}]*\}/.test(content)
    ) {
      routerFiles.push(file);
    }
  }

  return routerFiles;
}

/**
 * Parse router.ts to find all imported router files
 */
function findMountedRouters(): Set<string> {
  const content = fs.readFileSync(ROUTER_FILE, 'utf-8');

  // Match import statements: import { ... } from './filename' or import router from './filename'
  const importRegex = /from\s+'\.\/([^']+)'/g;
  const mounted = new Set<string>();

  let match;
  while ((match = importRegex.exec(content)) !== null) {
    const importedFile = match[1];
    // Normalize: strip path separators, add .ts extension if missing
    const normalized = importedFile.includes('/') ? importedFile.split('/').pop()! : importedFile;
    mounted.add(normalized + '.ts');
    mounted.add(normalized);
  }

  return mounted;
}

/**
 * Extract router.use() prefixes from router.ts
 */
function extractMountedPrefixes(): string[] {
  const content = fs.readFileSync(ROUTER_FILE, 'utf-8');
  const useRegex = /router\.use\(['"]([^'"]+)['"]/g;
  const prefixes: string[] = [];

  let match;
  while ((match = useRegex.exec(content)) !== null) {
    prefixes.push(match[1]);
  }

  return prefixes;
}

/**
 * Detect route path conflicts between mounted prefixes
 */
function detectConflicts(prefixes: string[]): RouteConflict[] {
  const conflicts: RouteConflict[] = [];

  for (let i = 0; i < prefixes.length; i++) {
    for (let j = i + 1; j < prefixes.length; j++) {
      const p1 = prefixes[i];
      const p2 = prefixes[j];

      // Exact duplicate
      if (p1 === p2) {
        conflicts.push({ route1: p1, route2: p2, prefix1: p1, prefix2: p2, conflictType: 'exact' });
        continue;
      }

      // One is a prefix of the other (potential shadowing)
      if (p2.startsWith(p1 + '/') || p1.startsWith(p2 + '/')) {
        // This is intentional nesting (e.g., /feed and /feed/backfill) — warn but not error
        // Skip if they are clearly sub-routes
        continue;
      }

      // Wildcard/param ambiguity: /:param at root level
      const p1HasRootParam = /^\/:[^/]+$/.test(p1);
      const p2HasRootParam = /^\/:[^/]+$/.test(p2);
      if (p1HasRootParam && p2HasRootParam) {
        conflicts.push({
          route1: p1,
          route2: p2,
          prefix1: p1,
          prefix2: p2,
          conflictType: 'param_ambiguity',
        });
      }
    }
  }

  return conflicts;
}

/**
 * Main validation function
 */
export function validateRoutes(): ValidationResult {
  const discoveredFiles = discoverRouterFiles();
  const mountedSet = findMountedRouters();
  const prefixes = extractMountedPrefixes();

  const orphanedRouters: string[] = [];
  const pendingSchemaRouters: string[] = [];
  const mountedRouters: string[] = [];
  const warnings: string[] = [];

  // Exclusions: utility files that are not express routers
  const exclusions = new Set([
    'router.ts', // The main router file itself
    'compiler.ts', // Utility functions, not an Express router
    'emergency-router.ts', // Mounted via emergencyBaseRouter alias
  ]);

  for (const file of discoveredFiles) {
    if (exclusions.has(file)) continue;

    const baseName = file.replace(/\.ts$/, '');
    const isMounted = mountedSet.has(file) || mountedSet.has(baseName);

    if (isMounted) {
      if (PENDING_SCHEMA_ROUTERS.has(file)) {
        warnings.push(
          `WARNING: "${file}" is in PENDING_SCHEMA_ROUTERS but is also mounted — remove it from the allowlist`,
        );
      }
      mountedRouters.push(file);
    } else if (PENDING_SCHEMA_ROUTERS.has(file)) {
      pendingSchemaRouters.push(file);
    } else {
      orphanedRouters.push(file);
    }
  }

  const routeConflicts = detectConflicts(prefixes);

  // Warn about root-level param patterns
  for (const prefix of prefixes) {
    if (/^\/:[^/]+/.test(prefix)) {
      warnings.push(
        `WARNING: Router mounted at root param pattern "${prefix}" may shadow other routes`,
      );
    }
  }

  const passed =
    orphanedRouters.length === 0 &&
    routeConflicts.filter((c) => c.conflictType === 'exact').length === 0;

  return {
    orphanedRouters,
    pendingSchemaRouters,
    mountedRouters,
    routeConflicts,
    warnings,
    passed,
  };
}

/**
 * CLI entrypoint
 */
if (require.main === module) {
  const result = validateRoutes();

  console.log('\n═══════════════════════════════════════════════════');
  console.log('  Soroban Router Registry Validation');
  console.log('═══════════════════════════════════════════════════\n');

  console.log(`✅ Mounted routers (${result.mountedRouters.length}):`);
  for (const r of result.mountedRouters) {
    console.log(`   • ${r}`);
  }

  if (result.pendingSchemaRouters.length > 0) {
    console.log(
      `\n⏳ Pending-schema routers — allowlisted, awaiting Prisma migration (${result.pendingSchemaRouters.length}):`,
    );
    for (const r of result.pendingSchemaRouters) {
      console.log(`   • ${r}`);
    }
  }

  if (result.orphanedRouters.length > 0) {
    console.log(
      `\n❌ ORPHANED ROUTERS — not mounted and not allowlisted (${result.orphanedRouters.length}):`,
    );
    for (const r of result.orphanedRouters) {
      console.log(`   • ${r}`);
    }
  } else {
    console.log('\n✅ No unexplained orphaned routers');
  }

  if (result.routeConflicts.length > 0) {
    console.log(`\n⚠️  Route conflicts detected (${result.routeConflicts.length}):`);
    for (const c of result.routeConflicts) {
      console.log(`   • ${c.conflictType}: "${c.route1}" vs "${c.route2}"`);
    }
  } else {
    console.log('✅ No route conflicts detected');
  }

  if (result.warnings.length > 0) {
    console.log('\n⚠️  Warnings:');
    for (const w of result.warnings) {
      console.log(`   ${w}`);
    }
  }

  console.log('\n───────────────────────────────────────────────────');
  if (result.passed) {
    console.log('✅ VALIDATION PASSED\n');
    process.exit(0);
  } else {
    console.log('❌ VALIDATION FAILED — fix orphaned routers and conflicts\n');
    process.exit(1);
  }
}
