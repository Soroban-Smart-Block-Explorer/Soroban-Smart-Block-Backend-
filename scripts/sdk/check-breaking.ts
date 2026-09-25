/**
 * Semver breaking-change gate for the generated SDKs (CI).
 *
 * Compares packages/client/api-surface.json at a base git ref (default
 * origin/main) with the working tree and enforces docs/sdk/versioning.md:
 * breaking ⇒ major bump of every SDK package; additive ⇒ at least minor.
 *
 *   npm run sdk:breaking                      # base = origin/main
 *   npm run sdk:breaking -- --base <git-ref>
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { checkVersionPolicy, diffSurfaces, type ApiSurface } from './surface';

const ROOT = path.join(__dirname, '..', '..');
const SURFACE = 'packages/client/api-surface.json';

/** Version files for every SDK bound by the policy. */
const VERSION_SOURCES: Array<{ name: string; file: string; read: (text: string) => string }> = [
  {
    name: '@soroban-explorer/client',
    file: 'packages/client/package.json',
    read: (t) => (JSON.parse(t) as { version: string }).version,
  },
  {
    name: 'soroban-explorer-client (Python)',
    file: 'packages/python-client/pyproject.toml',
    read: (t) => {
      const m = /^version\s*=\s*"([^"]+)"/m.exec(t);
      if (!m) throw new Error('version not found in pyproject.toml');
      return m[1];
    },
  },
];

function atRef(ref: string, file: string): string | null {
  // execFileSync with an argument array: the ref is never interpreted by a shell.
  if (!/^[A-Za-z0-9_./~^-]+$/.test(ref)) throw new Error(`invalid git ref: ${ref}`);
  try {
    return execFileSync('git', ['show', `${ref}:${file}`], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

function main(): void {
  const idx = process.argv.indexOf('--base');
  const base = idx >= 0 ? process.argv[idx + 1] : 'origin/main';
  const before = atRef(base, SURFACE);
  if (before === null) {
    process.stdout.write(`No ${SURFACE} at ${base}; first introduction, nothing to compare.\n`);
    return;
  }
  const after = fs.readFileSync(path.join(ROOT, SURFACE), 'utf8');
  const diff = diffSurfaces(JSON.parse(before) as ApiSurface, JSON.parse(after) as ApiSurface);
  process.stdout.write(
    `API surface vs ${base}: ${diff.breaking.length} breaking, ${diff.additive.length} additive change(s)\n`,
  );
  const violations: string[] = [];
  for (const src of VERSION_SOURCES) {
    const prev = atRef(base, src.file);
    const abs = path.join(ROOT, src.file);
    if (prev === null || !fs.existsSync(abs)) continue;
    const v = checkVersionPolicy(diff, src.read(prev), src.read(fs.readFileSync(abs, 'utf8')));
    violations.push(...v.map((m) => `${src.name}: ${m}`));
  }
  if (violations.length > 0) {
    process.stderr.write(`SDK versioning policy violated:\n${violations.join('\n')}\n`);
    process.exit(1);
  }
  process.stdout.write('SDK versioning policy satisfied.\n');
}

if (require.main === module) main();
