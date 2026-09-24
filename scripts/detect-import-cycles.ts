#!/usr/bin/env ts-node
// @ts-check
/**
 * scripts/detect-import-cycles.ts
 *
 * Builds the static (runtime) import graph for `src/**`/*.ts and reports any
 * circular dependencies as strongly connected components, plus a concrete
 * cycle path for each one.
 *
 * Only *value* imports are considered, because they are the ones that can
 * trigger a module-initialization cycle (`undefined` exports):
 *   - `import { x } from './y'`   → tracked
 *   - `import './y'`              → tracked (side-effect)
 *   - `import type { x } from './y'` → ignored (erased at compile time)
 *   - `import('./y')` (dynamic)   → ignored (lazy, never runs during init)
 *
 * Usage:
 *   npx ts-node -P tsconfig.scripts.json scripts/detect-import-cycles.ts
 *
 * Exit code 0 = no cycles, 1 = at least one cycle found.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

interface Graph {
  [file: string]: string[];
}

// ─── File collection ─────────────────────────────────────────────────────────

function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

// ─── Module resolution ───────────────────────────────────────────────────────

/** Resolve a relative specifier to an on-disk file, or null if external/missing. */
function resolveModule(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null; // node_modules / bare specifiers

  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, 'index.ts'),
    path.join(base, 'index.tsx'),
  ];

  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      /* keep trying */
    }
  }
  return null;
}

// ─── Graph construction ──────────────────────────────────────────────────────

function buildGraph(files: string[]): Graph {
  const graph: Graph = {};
  for (const file of files) graph[file] = [];

  for (const file of files) {
    const text = fs.readFileSync(file, 'utf-8');
    const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);

    for (const statement of sourceFile.statements) {
      if (!ts.isImportDeclaration(statement)) continue;

      // `import type { ... }` produces no runtime code → cannot form an init cycle.
      if (statement.importClause?.isTypeOnly) continue;

      const specifier = statement.moduleSpecifier;
      if (!ts.isStringLiteral(specifier)) continue;

      const target = resolveModule(file, specifier.text);
      if (target && target !== file) graph[file].push(target);
    }
  }

  return graph;
}

// ─── Strongly connected components (Tarjan) ─────────────────────────────────

function findSccs(graph: Graph): string[][] {
  const nodes = Object.keys(graph);
  const index = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const sccs: string[][] = [];
  let counter = 0;

  const strongconnect = (v: string): void => {
    index.set(v, counter);
    lowlink.set(v, counter);
    counter++;
    stack.push(v);
    onStack.add(v);

    for (const w of graph[v] ?? []) {
      if (!index.has(w)) {
        strongconnect(w);
        lowlink.set(v, Math.min(lowlink.get(v)!, lowlink.get(w)!));
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v)!, index.get(w)!));
      }
    }

    if (lowlink.get(v) === index.get(v)) {
      const scc: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        scc.push(w);
      } while (w !== v);
      sccs.push(scc);
    }
  };

  for (const node of nodes) {
    if (!index.has(node)) strongconnect(node);
  }

  return sccs;
}

/** Find a concrete cycle starting (and ending) at `start`, restricted to `scc`. */
function findCyclePath(start: string, scc: Set<string>, graph: Graph): string[] | null {
  const visited = new Set<string>();
  const path: string[] = [];

  const dfs = (node: string): boolean => {
    visited.add(node);
    path.push(node);

    for (const next of graph[node] ?? []) {
      if (next === start) {
        path.push(start);
        return true;
      }
      if (scc.has(next) && !visited.has(next)) {
        if (dfs(next)) return true;
      }
    }

    path.pop();
    return false;
  };

  return dfs(start) ? path : null;
}

// ─── Reporting ───────────────────────────────────────────────────────────────

function rel(file: string): string {
  return path.relative(process.cwd(), file).split(path.sep).join('/');
}

function run(): void {
  const SRC = path.resolve(__dirname, '..', 'src');

  const files = collectTsFiles(SRC);
  const graph = buildGraph(files);
  const edgeCount = Object.values(graph).reduce((sum, edges) => sum + edges.length, 0);

  console.log(`\n🔎  Import-cycle audit\n`);
  console.log(`  files : ${files.length}`);
  console.log(`  edges : ${edgeCount} (runtime value imports)`);

  const sccs = findSccs(graph);

  // Self-loops are their own SCC of size 1.
  const selfLoops = files.filter((f) => graph[f].includes(f));
  const cyclic = sccs.filter((scc) => scc.length > 1 || selfLoops.includes(scc[0]));

  if (cyclic.length === 0) {
    console.log(`\n✅  No circular dependencies detected.\n`);
    process.exit(0);
  }

  console.error(`\n❌  ${cyclic.length} cycle(s) detected:\n`);

  for (const scc of cyclic) {
    const set = new Set(scc);
    if (scc.length === 1 && selfLoops.includes(scc[0])) {
      console.error(`  self-import: ${rel(scc[0])} → ${rel(scc[0])}`);
      continue;
    }
    const cycle = findCyclePath(scc[0], set, graph);
    console.error(`  ${cycle ? cycle.map(rel).join(' → ') : scc.map(rel).join(' ⇄ ')}`);
  }

  console.error(
    `\n` +
      `  These files form a module-initialization cycle. Break one edge by\n` +
      `  extracting the shared dependency, using dependency injection, or deferring\n` +
      `  the import (dynamic import / moving it into a function).\n`,
  );
  process.exit(1);
}

if (require.main === module) {
  run();
}
