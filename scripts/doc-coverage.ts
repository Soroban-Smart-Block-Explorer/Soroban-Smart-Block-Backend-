/**
 * scripts/doc-coverage.ts
 *
 * Measures the percentage of Express route handlers that have @swagger JSDoc
 * comments in src/api/**\/\*.ts files.
 *
 * Usage:
 *   npx ts-node scripts/doc-coverage.ts [--threshold <0-100>]
 *
 * Exit code 1 if coverage is below the threshold (default: 60).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as glob from 'fs';

const THRESHOLD = (() => {
  const idx = process.argv.indexOf('--threshold');
  return idx !== -1 ? parseInt(process.argv[idx + 1], 10) : 60;
})();

const API_GLOB_ROOT = path.join(__dirname, '../src/api');

/** Recursively collect all .ts files under a directory */
function collectTs(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) files.push(...collectTs(full));
    else if (e.isFile() && e.name.endsWith('.ts')) files.push(full);
  }
  return files;
}

/** HTTP method verbs to search for */
const METHOD_RE = /\.(get|post|put|patch|delete|head|options)\s*\(/gi;
/** @swagger tag presence check */
const SWAGGER_RE = /@swagger/g;

interface FileReport {
  file: string;
  total: number;
  documented: number;
}

function analyseFile(filePath: string): FileReport {
  const src = fs.readFileSync(filePath, 'utf8');
  const lines = src.split('\n');

  let total = 0;
  let documented = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Match .get( .post( etc. as route registrations (skip imports/non-route calls)
    if (/\.(get|post|put|patch|delete)\s*\(\s*['"`\/]/.test(line)) {
      total++;
      // Look backwards up to 80 lines for a @swagger comment block
      const lookback = lines.slice(Math.max(0, i - 80), i).join('\n');
      if (/@swagger/.test(lookback)) {
        documented++;
      }
    }
  }

  return { file: path.relative(process.cwd(), filePath), total, documented };
}

function main() {
  const files = collectTs(API_GLOB_ROOT);
  const reports = files.map(analyseFile).filter((r) => r.total > 0);

  const totalEndpoints = reports.reduce((s, r) => s + r.total, 0);
  const totalDocumented = reports.reduce((s, r) => s + r.documented, 0);
  const coverage = totalEndpoints > 0 ? (totalDocumented / totalEndpoints) * 100 : 100;

  console.log('\n📊  Swagger/OpenAPI Documentation Coverage Report');
  console.log('═'.repeat(60));

  const undocumented = reports.filter((r) => r.documented < r.total);
  if (undocumented.length > 0) {
    console.log('\n⚠️  Files with undocumented endpoints:');
    for (const r of undocumented) {
      const pct = Math.round((r.documented / r.total) * 100);
      console.log(`  ${r.file.padEnd(55)} ${r.documented}/${r.total} (${pct}%)`);
    }
  }

  console.log(
    `\n✅  Documented: ${totalDocumented}/${totalEndpoints} endpoints — ${coverage.toFixed(1)}% coverage`,
  );
  console.log(`🎯  Threshold:  ${THRESHOLD}%`);

  if (coverage < THRESHOLD) {
    console.error(
      `\n❌  Coverage ${coverage.toFixed(1)}% is below the required ${THRESHOLD}% threshold.`,
    );
    process.exit(1);
  }

  console.log(`\n✔️   Coverage meets the ${THRESHOLD}% threshold.\n`);
}

main();
