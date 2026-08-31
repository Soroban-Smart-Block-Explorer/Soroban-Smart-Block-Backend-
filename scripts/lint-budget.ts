/**
 * ESLint warning budget — ratchet enforcement, fixes #920.
 *
 * The repo's `lint` script used to run `eslint ... --max-warnings 1750`, which
 * meant CI silently tolerated up to 1,750 warnings. With that much headroom a
 * genuinely new warning was indistinguishable from the existing debt and there
 * was no pressure to pay the pile down. This script replaces the flat
 * `--max-warnings` cap with a *ratchet*, mirroring `scripts/typecheck-budget.ts`
 * and the `--max-orphans` pattern in scripts/validate-routes.ts:
 *
 *   1. It counts the *blocking* warnings (everything except the tracked-but-
 *      non-blocking "noise" rules, see below) and fails CI only when that
 *      count exceeds a checked-in budget. So a new warning — any new warning —
 *      pushes the count above budget and fails the build, while the large
 *      pre-existing backlog is paid down incrementally rather than in one PR.
 *   2. It records and prints a warning-count *trend* so a PR that burns down
 *      warnings (or lets them climb back) is visible in the CI log.
 *   3. The noisiest rules — `@typescript-eslint/no-explicit-any` and
 *      `error-handling/no-phantom-prisma-field` — are *tracked but not
 *      blocking*: they are reported in the trend and counted toward the total,
 *      but do not trip the ratchet. This is the "split the config" suggestion
 *      from #920: keep the real error rules strict and let the noisy ones be a
 *      separate, non-blocking warnings pass. Lower the budget as these are
 *      burned down.
 *
 * Usage:
 *   npx ts-node scripts/lint-budget.ts                    # blocking budget 0
 *   npx ts-node scripts/lint-budget.ts --max-warnings 196
 *   npm run lint:budget                                   # enforce budget
 *   npm run lint:budget:ci                                # CI budget
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const LINT_TARGETS = ['src/**/*.ts', 'tests/**/*.ts'];

/**
 * Rules that become a trending-but-non-blocking warnings pass. These are the
 * noisy classes #920 calls out explicitly — `any`-typing and the custom
 * phantom-Prisma-field linter — which would otherwise drown out the warning
 * types that actually indicate bugs (unused vars, eqeqeq, no-unsafe-*, …).
 * Keeping them reported-but-not-blocking lets them be paid down at leisure
 * while any *other* new warning still fails CI immediately.
 */
const NON_BLOCKING_RULES = new Set([
  '@typescript-eslint/no-explicit-any',
  'error-handling/no-phantom-prisma-field',
]);

interface LintResult {
  totalWarnings: number;
  blockingWarnings: number;
  errors: number;
  output: string;
}

/** Runs eslint and counts warnings. Errors still fail the build outright. */
function runLint(): LintResult {
  const result = spawnSync('npx', ['eslint', ...LINT_TARGETS, '--format', 'json'], {
    encoding: 'utf-8',
    maxBuffer: 1024 * 1024 * 64,
  });
  const stdout = `${result.stdout ?? ''}`;
  const stderr = `${result.stderr ?? ''}`;

  // By default eslint exits non-zero only when it finds errors (a cap like
  // `--max-warnings -1` isn't valid and plain warnings don't trip the exit
  // code), so we parse the JSON to enforce the ratchet ourselves. A hard
  // failure (bad config, fatal parse error) surfaces as stderr or a non-zero
  // exit code even with only warnings present; treat that as an error.
  if (/fatal|Parsing error/i.test(stderr)) {
    // eslint still prints JSON to stdout on many failures; fall through to the
    // JSON-lines below if we can parse it, otherwise bail with the raw text.
    const parsed = safeParseJson(stdout);
    if (parsed === null) {
      return { totalWarnings: -1, blockingWarnings: -1, errors: 1, output: stderr + stdout };
    }
    return countFromJson(parsed, stderr + stdout, true);
  }

  const parsed = safeParseJson(stdout);
  if (parsed === null) {
    return { totalWarnings: -1, blockingWarnings: -1, errors: 1, output: stderr + stdout };
  }
  return countFromJson(parsed, stderr + stdout, false);
}

function safeParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function countFromJson(data: unknown, output: string, forcedError: boolean): LintResult {
  const files = Array.isArray(data)
    ? (data as Array<{ messages?: Array<Record<string, unknown>> }>)
    : [];
  let totalWarnings = 0;
  let blockingWarnings = 0;
  let errors = 0;
  for (const file of files) {
    for (const msg of file.messages ?? []) {
      const severity = msg.severity as number | undefined;
      const ruleId = typeof msg.ruleId === 'string' ? (msg.ruleId as string) : '';
      if (severity === 2) errors += 1;
      else if (severity === 1) {
        totalWarnings += 1;
        if (!NON_BLOCKING_RULES.has(ruleId)) blockingWarnings += 1;
      }
    }
  }
  if (forcedError && errors === 0) errors = 1;
  return { totalWarnings, blockingWarnings, errors, output };
}

function parseMaxWarnings(argv: string[]): number {
  const budgetIndex = argv.indexOf('--max-warnings');
  if (budgetIndex === -1) return 0;
  const raw = argv[budgetIndex + 1];
  const parsed = raw !== undefined ? parseInt(raw, 10) : NaN;
  if (Number.isNaN(parsed) || parsed < 0) {
    console.error(
      `Invalid --max-warnings value: "${String(raw)}" (expected a non-negative integer)`,
    );
    process.exit(2);
  }
  return parsed;
}

/** Reads the last-recorded warning count for trend reporting, if any. */
function readBaseline(): number | null {
  const file = path.join(__dirname, '..', 'node_modules', '.lint-budget-baseline');
  try {
    const n = parseInt(fs.readFileSync(file, 'utf-8').trim(), 10);
    return Number.isNaN(n) ? null : n;
  } catch {
    return null;
  }
}

/** Persists the current warning count so the next run can show the trend. */
function writeBaseline(count: number): void {
  try {
    const dir = path.join(__dirname, '..', 'node_modules');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.lint-budget-baseline'), String(count), 'utf-8');
  } catch {
    // Trend is best-effort; a failure to write must never fail lint.
  }
}

if (require.main === module) {
  const maxWarnings = parseMaxWarnings(process.argv.slice(2));

  console.log('Running eslint (budget ratchet, #920)...\n');
  const { totalWarnings, blockingWarnings, errors, output } = runLint();

  if (errors > 0) {
    console.log(output);
  }

  const previous = readBaseline();

  // ── Trend ────────────────────────────────────────────────────────────────
  const arrow =
    previous === null
      ? ''
      : blockingWarnings > previous
        ? `  (⬆️ +${blockingWarnings - previous} since last run)`
        : blockingWarnings < previous
          ? `  (⬇️ -${previous - blockingWarnings} since last run)`
          : '  (unchanged)';
  console.log('───────────────────────────────────────────────────');
  console.log(`Total warnings:     ${totalWarnings}`);
  console.log(`Blocking warnings:  ${blockingWarnings}${arrow}`);
  console.log(
    `Non-blocking debt:  ${totalWarnings - blockingWarnings} (no-explicit-any + no-phantom-prisma-field)`,
  );
  console.log(`Budget:             ${maxWarnings}`);
  if (previous !== null) {
    console.log(`Previous blocking:  ${previous}`);
  }
  console.log('───────────────────────────────────────────────────');

  if (errors > 0) {
    console.log(
      `❌ LINT FAILED — ${errors} error(s). See output above and fix them before merging.\n`,
    );
    process.exit(1);
  }

  if (blockingWarnings > maxWarnings) {
    console.log(
      `❌ LINT FAILED — ${blockingWarnings} blocking warning(s) exceed budget of ${maxWarnings}. ` +
        `${blockingWarnings - maxWarnings} new warning(s) were introduced. Fix them, or — if this is a ` +
        `deliberate, reviewed burn-down step — bump the budget in package.json ('lint:budget:ci').\n`,
    );
    process.exit(1);
  }

  if (blockingWarnings > 0) {
    console.log(
      `✅ LINT PASSED — ${blockingWarnings} blocking warning(s), within budget of ${maxWarnings}. ` +
        `Consider fixing some and lowering the budget in package.json ('lint:budget:ci').\n`,
    );
  } else {
    console.log('✅ LINT PASSED — no blocking warnings\n');
  }

  writeBaseline(blockingWarnings);
  process.exit(0);
}

export { runLint };
