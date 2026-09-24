#!/usr/bin/env node
/**
 * npm audit with tracked, expiring exceptions.
 *
 * Resolves #897: CI's Security job used to run `npm audit --audit-level=high
 * || true`, so a real high/critical finding never failed the build — it just
 * scrolled by in the log. `npm audit --audit-level=high` on its own has no
 * way to allow through *one specific, already-understood* finding while still
 * failing on everything else, so this wrapper adds that: it runs the real
 * audit and fails the build on any high/critical finding UNLESS that
 * package is explicitly listed in .auditignore with a reason and a
 * `reviewBy` date. An expired exception fails the build too — this file
 * documents accepted risk, it cannot be used to silently suppress a new
 * vulnerability forever.
 *
 * Deliberately plain Node (no ts-node / devDependencies): this same script
 * runs in the Docker runtime stage's `npm ci --omit=dev` step, which must
 * not need the TypeScript toolchain.
 *
 * Usage:
 *   node scripts/audit-check.js                # full dependency tree (CI, Docker builder stage)
 *   node scripts/audit-check.js --omit=dev      # prod deps only (Docker runtime stage)
 *   npm run audit:ci [-- --omit=dev]
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ENFORCED_SEVERITIES = new Set(['high', 'critical']);
const AUDITIGNORE_PATH = path.join(__dirname, '..', '.auditignore');

function loadExceptions() {
  if (!fs.existsSync(AUDITIGNORE_PATH)) return [];
  const raw = fs.readFileSync(AUDITIGNORE_PATH, 'utf-8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error(`Failed to parse ${AUDITIGNORE_PATH}: ${err.message}`);
    process.exit(2);
  }
  return Array.isArray(parsed.exceptions) ? parsed.exceptions : [];
}

function runAudit(extraArgs) {
  const result = spawnSync('npm', ['audit', '--json', ...extraArgs], {
    encoding: 'utf-8',
    maxBuffer: 1024 * 1024 * 64,
  });
  // `npm audit` exits non-zero whenever it finds vulnerabilities — that is
  // expected and handled below. A missing/unparseable report means the
  // invocation itself failed (e.g. no network, corrupt lockfile).
  if (!result.stdout) {
    console.error(result.stderr || 'npm audit produced no output');
    process.exit(2);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    console.error('Failed to parse `npm audit --json` output:');
    console.error(result.stdout);
    process.exit(2);
  }
}

function main() {
  const extraArgs = process.argv.slice(2);
  const exceptions = loadExceptions();
  const today = new Date().toISOString().slice(0, 10);

  const expired = exceptions.filter((e) => typeof e.reviewBy === 'string' && e.reviewBy < today);
  if (expired.length > 0) {
    console.error('❌ .auditignore has expired exceptions that must be re-reviewed:\n');
    for (const e of expired) {
      console.error(`   • ${e.package} (reviewBy: ${e.reviewBy}) — ${e.reason}`);
    }
    console.error(
      '\nRe-check whether a fix now exists. Either fix the finding and remove the entry, or\nbump reviewBy after confirming the exception still applies.\n',
    );
    process.exit(1);
  }

  const exceptionNames = new Set(exceptions.map((e) => e.package));
  const report = runAudit(extraArgs);
  const vulnerabilities = report.vulnerabilities || {};

  const unexcepted = [];
  const excepted = [];

  for (const [name, advisory] of Object.entries(vulnerabilities)) {
    if (!ENFORCED_SEVERITIES.has(advisory.severity)) continue;
    if (exceptionNames.has(name)) {
      excepted.push(`${name} (${advisory.severity})`);
    } else {
      unexcepted.push(`${name} (${advisory.severity})`);
    }
  }

  console.log('───────────────────────────────────────────────────');
  console.log('  npm audit — tracked exceptions');
  console.log('───────────────────────────────────────────────────');

  if (excepted.length > 0) {
    console.log(`\n⚠️  ${excepted.length} finding(s) covered by documented .auditignore exceptions:`);
    for (const e of excepted) console.log(`   • ${e}`);
  }

  if (unexcepted.length > 0) {
    console.log(`\n❌ AUDIT FAILED — ${unexcepted.length} unlisted high/critical finding(s):`);
    for (const u of unexcepted) console.log(`   • ${u}`);
    console.log(
      '\nRun `npm audit --audit-level=high` for full details. Fix the finding (preferred), or add\n' +
        'a justified, dated entry to .auditignore if it genuinely cannot be fixed yet.\n',
    );
    process.exit(1);
  }

  console.log('\n✅ AUDIT PASSED — no unlisted high/critical vulnerabilities\n');
  process.exit(0);
}

main();
