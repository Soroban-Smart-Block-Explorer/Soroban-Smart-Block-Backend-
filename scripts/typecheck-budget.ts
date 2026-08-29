/**
 * TypeScript error budget — ratchet enforcement for `tsc --noEmit`.
 *
 * Resolves #896: CI's Lint job used to run `npm run build:strict || echo
 * 'Type errors found (pre-existing)'`, so a genuinely new type error never
 * failed the build — it was indistinguishable from the pre-existing ones.
 * This script counts the *current* number of `tsc --noEmit` errors and fails
 * only when that count exceeds a checked-in budget, so CI still catches any
 * newly introduced type error (which pushes the count above budget) while
 * the large pre-existing backlog is paid down incrementally rather than
 * fixed in one PR. Lower the budget as errors are fixed; the target is 0.
 * Mirrors the `--max-orphans` pattern in scripts/validate-routes.ts.
 *
 * Usage:
 *   npx ts-node scripts/typecheck-budget.ts                   # strict (budget 0)
 *   npx ts-node scripts/typecheck-budget.ts --max-errors 1374
 *   npm run typecheck:budget                                  # strict
 *   npm run typecheck:budget:ci                                # CI budget
 */

import { spawnSync } from 'child_process';

const ERROR_RE = /error TS\d+:/g;

interface TypeCheckResult {
  count: number;
  output: string;
}

/** Runs `tsc --noEmit` against the main project config and counts errors. */
function countTypeErrors(): TypeCheckResult {
  const result = spawnSync('npx', ['tsc', '-p', 'tsconfig.json', '--noEmit'], {
    encoding: 'utf-8',
    maxBuffer: 1024 * 1024 * 64,
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const matches = output.match(ERROR_RE);
  return { count: matches ? matches.length : 0, output };
}

function parseMaxErrors(argv: string[]): number {
  const budgetIndex = argv.indexOf('--max-errors');
  if (budgetIndex === -1) return 0;
  const raw = argv[budgetIndex + 1];
  const parsed = raw !== undefined ? parseInt(raw, 10) : NaN;
  if (Number.isNaN(parsed) || parsed < 0) {
    console.error(`Invalid --max-errors value: "${String(raw)}" (expected a non-negative integer)`);
    process.exit(2);
  }
  return parsed;
}

if (require.main === module) {
  const maxErrors = parseMaxErrors(process.argv.slice(2));

  console.log('Running `tsc --noEmit`  (this may take a minute)...\n');
  const { count, output } = countTypeErrors();

  if (count > 0) {
    console.log(output);
  }

  console.log('───────────────────────────────────────────────────');
  if (count > maxErrors) {
    console.log(
      `❌ TYPE-CHECK FAILED — ${count} error(s) exceed budget of ${maxErrors}. ` +
        `${count - maxErrors} new error(s) were introduced. Fix them, or run ` +
        `'npm run build:strict' locally to see the full list without truncation.\n`,
    );
    process.exit(1);
  }

  if (count > 0) {
    console.log(
      `✅ TYPE-CHECK PASSED — ${count} pre-existing error(s), within budget of ${maxErrors}. ` +
        `Consider fixing some and lowering the budget in package.json ('typecheck:budget:ci').\n`,
    );
  } else {
    console.log('✅ TYPE-CHECK PASSED — no type errors\n');
  }
  process.exit(0);
}

export { countTypeErrors };
