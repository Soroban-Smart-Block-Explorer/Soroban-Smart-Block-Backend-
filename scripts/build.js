#!/usr/bin/env node
/**
 * Production build driver.
 *
 * Runs the two TypeScript emits that produce deployable artifacts:
 *   1. `tsc`                      → CommonJS app in dist/        (tsconfig.json)
 *   2. `tsc -p tsconfig.p2p.json` → ESM P2P factory in dist-esm/ (tsconfig.p2p.json)
 *
 * TypeScript still reports pre-existing type errors during emit (tsc emits
 * despite them unless noEmitOnError is set). This script makes that state
 * *visible and honest* instead of hiding it behind `tsc || echo …`:
 *   - the number of type errors is always printed,
 *   - the build FAILS if the expected runtime artifacts were not emitted,
 *   - the type-error budget is enforced separately by `npm run typecheck`
 *     (scripts/typecheck-budget.ts, a ratchet that fails CI when the count
 *     grows). The target is 0; the budget is lowered as errors are fixed.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REQUIRED_ARTIFACTS = ['dist/index.js', 'dist/indexer/run.js', 'dist-esm/node-factory.mjs'];

function run(label, args, cwd) {
  const result = spawnSync('npx', args, { cwd, encoding: 'utf-8' });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const errorCount = (output.match(/error TS\d+:/g) ?? []).length;
  return { label, status: result.status ?? 0, errorCount, output };
}

const root = path.join(__dirname, '..');

const main = run('main (tsconfig.json → dist/)', ['tsc'], root);
const p2p = run('p2p (tsconfig.p2p.json → dist-esm/)', ['tsc', '-p', 'tsconfig.p2p.json'], root);

const totalErrors = main.errorCount + p2p.errorCount;
const missing = REQUIRED_ARTIFACTS.filter((a) => !fs.existsSync(path.join(root, a)));

console.log('──────────────────────────────────────────────────');
console.log(`main build:  ${main.errorCount} type error(s)`);
console.log(`p2p build:   ${p2p.errorCount} type error(s)`);
console.log(`total:       ${totalErrors} type error(s)`);

if (missing.length > 0) {
  console.log(`❌ BUILD FAILED — missing emit artifacts:\n   ${missing.join('\n   ')}`);
  console.log(main.output.slice(0, 4000));
  console.log(p2p.output.slice(0, 4000));
  process.exit(1);
}

if (totalErrors > 0) {
  console.log(
    `⚠️  Build emitted ${totalErrors} pre-existing type error(s) — runtime artifacts are produced, ` +
      `but run 'npm run typecheck' and pay the debt down toward 0.`,
  );
} else {
  console.log('✅ Build clean — no type errors.');
}
console.log('✅ Runtime artifacts present:');
for (const a of REQUIRED_ARTIFACTS) console.log(`   - ${a}`);
process.exit(0);
