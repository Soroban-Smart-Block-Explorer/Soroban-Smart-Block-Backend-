/**
 * Test-suite coverage guard.
 *
 * Resolves #895: CI's Test job used to run `vitest run` against a hardcoded
 * list of 7 files instead of the full ~126-file suite, so almost the entire
 * suite silently never ran in CI. Two checks guard against that regressing:
 *
 *   1. The `test:full` script that CI now invokes must be exactly
 *      `vitest run` with no file-path arguments — a hardcoded file list of
 *      any kind defeats "run everything" and would silently reintroduce
 *      #895.
 *   2. The number of test files vitest's own `include`/`exclude` config
 *      (read directly from vitest.config.ts, not duplicated here, so this
 *      guard can't drift from what actually runs) would collect must not
 *      drop below MIN_EXPECTED_TEST_FILES — catching an accidental new
 *      `exclude` entry, or a moved/renamed test directory, that silently
 *      drops files from the suite in the future.
 *
 * Usage:
 *   npx ts-node scripts/verify-test-coverage.ts
 *   npm run test:guard
 */

import * as fs from 'fs';
import * as path from 'path';
import * as glob from 'glob';
import vitestConfig from '../vitest.config';

// Full suite size at the time #895 was fixed. The issue was filed against an
// older snapshot of the repo citing 126 files; the true count today (verified
// via vitest.config.ts's own include/exclude) is higher. Lower this only when
// test files are deliberately deleted or merged — never to silence a real
// regression.
const MIN_EXPECTED_TEST_FILES = 205;

const ROOT = path.join(__dirname, '..');

function readPackageScript(name: string): string {
  const pkgPath = path.join(ROOT, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { scripts?: Record<string, string> };
  const script = pkg.scripts?.[name];
  if (!script) {
    throw new Error(`package.json has no "${name}" script`);
  }
  return script;
}

function collectTestFiles(): string[] {
  const testConfig = vitestConfig.test ?? {};
  const include = (testConfig.include as string[] | undefined) ?? [];
  const exclude = (testConfig.exclude as string[] | undefined) ?? [];

  const matched = new Set<string>();
  for (const pattern of include) {
    const files = glob.sync(pattern, { cwd: ROOT, ignore: exclude, nodir: true });
    for (const f of files) matched.add(f);
  }
  return [...matched].sort();
}

function main(): void {
  const errors: string[] = [];

  const testFullScript = readPackageScript('test:full');
  if (testFullScript.trim() !== 'vitest run') {
    errors.push(
      `"test:full" must be exactly 'vitest run' (no file-path arguments) so CI runs the whole ` +
        `suite instead of a hardcoded subset. Found: "${testFullScript}"`,
    );
  }

  const files = collectTestFiles();
  console.log(`Discovered ${files.length} test file(s) via vitest.config.ts include/exclude.`);
  if (files.length < MIN_EXPECTED_TEST_FILES) {
    errors.push(
      `Only ${files.length} test file(s) would run — expected at least ${MIN_EXPECTED_TEST_FILES}. ` +
        `Check for a new vitest.config.ts 'exclude' entry or a moved/renamed test directory.`,
    );
  }

  console.log('───────────────────────────────────────────────────');
  if (errors.length > 0) {
    console.log('❌ TEST COVERAGE GUARD FAILED:\n');
    for (const e of errors) console.log(`   • ${e}`);
    console.log('');
    process.exit(1);
  }

  console.log(
    `✅ TEST COVERAGE GUARD PASSED — ${files.length} test file(s), 'test:full' runs all of them\n`,
  );
}

main();
