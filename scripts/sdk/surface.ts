/**
 * API surface manifest + semver breaking-change detection (DX01/DX02).
 *
 * The manifest (`packages/client/api-surface.json`) is a compact, sorted,
 * reviewable projection of the normalized OpenAPI operations: exactly the
 * facts a generated client depends on. Comparing two manifests classifies a
 * change as breaking, additive or none.
 */
import type { NormalizedOperation } from '../../src/lib/openapi/normalize';

export interface SurfaceParam {
  type: string;
  required: boolean;
  enum?: Array<string | number>;
}

export interface SurfaceOperation {
  method: string;
  path: string;
  params: Record<string, SurfaceParam>;
  body: 'none' | 'optional' | 'required';
  deprecated: boolean;
}

export interface ApiSurface {
  specVersion: string;
  operationCount: number;
  operations: Record<string, SurfaceOperation>;
}

export function buildSurface(specVersion: string, ops: NormalizedOperation[]): ApiSurface {
  const operations: Record<string, SurfaceOperation> = {};
  for (const op of [...ops].sort((a, b) => a.id.localeCompare(b.id))) {
    const params: Record<string, SurfaceParam> = {};
    for (const p of op.params.filter((x) => x.in !== 'header')) {
      const entry: SurfaceParam = { type: p.type, required: p.required };
      if (p.enum && p.enum.length > 0) entry.enum = [...p.enum];
      params[`${p.in}:${p.name}`] = entry;
    }
    operations[op.id] = {
      method: op.method.toUpperCase(),
      path: op.path,
      params,
      body: op.body ? (op.body.required ? 'required' : 'optional') : 'none',
      deprecated: op.deprecated,
    };
  }
  return { specVersion, operationCount: ops.length, operations };
}

export interface SurfaceDiff {
  breaking: string[];
  additive: string[];
}

/** Classify every difference between two surfaces. */
export function diffSurfaces(base: ApiSurface, next: ApiSurface): SurfaceDiff {
  const breaking: string[] = [];
  const additive: string[] = [];
  for (const [id, before] of Object.entries(base.operations)) {
    const after = next.operations[id];
    if (!after) {
      breaking.push(`removed operation ${id} (${before.method} ${before.path})`);
      continue;
    }
    if (after.method !== before.method || after.path !== before.path) {
      breaking.push(
        `${id}: route changed ${before.method} ${before.path} → ${after.method} ${after.path}`,
      );
    }
    for (const [key, p] of Object.entries(before.params)) {
      const q = after.params[key];
      if (!q) {
        breaking.push(`${id}: removed parameter ${key}`);
        continue;
      }
      if (q.type !== p.type) breaking.push(`${id}: parameter ${key} type ${p.type} → ${q.type}`);
      if (!p.required && q.required) breaking.push(`${id}: parameter ${key} became required`);
      if (p.enum && q.enum) {
        const removed = p.enum.filter((v) => !q.enum!.includes(v));
        if (removed.length > 0) {
          breaking.push(`${id}: parameter ${key} enum lost ${removed.join(', ')}`);
        }
      } else if (!p.enum && q.enum) {
        breaking.push(`${id}: parameter ${key} became an enum`);
      }
    }
    for (const [key, q] of Object.entries(after.params)) {
      if (!before.params[key]) {
        if (q.required) breaking.push(`${id}: new required parameter ${key}`);
        else additive.push(`${id}: new optional parameter ${key}`);
      }
    }
    if (before.body !== 'required' && after.body === 'required') {
      breaking.push(`${id}: request body became required`);
    }
    if (!before.deprecated && after.deprecated) additive.push(`${id}: deprecated`);
  }
  for (const id of Object.keys(next.operations)) {
    if (!base.operations[id]) additive.push(`added operation ${id}`);
  }
  return { breaking, additive };
}

export function parseSemver(v: string): [number, number, number] {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
  if (!m) throw new Error(`invalid semver: ${v}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/**
 * Enforce the SDK versioning policy (docs/sdk/versioning.md):
 *   breaking change ⇒ major bump; additive change ⇒ at least a minor bump.
 * Returns the list of violations (empty when compliant).
 */
export function checkVersionPolicy(
  diff: SurfaceDiff,
  baseVersion: string,
  nextVersion: string,
): string[] {
  const [bMaj, bMin, bPatch] = parseSemver(baseVersion);
  const [nMaj, nMin, nPatch] = parseSemver(nextVersion);
  const violations: string[] = [];
  const cmp = nMaj - bMaj || nMin - bMin || nPatch - bPatch;
  if (cmp < 0) violations.push(`version went backwards: ${baseVersion} → ${nextVersion}`);
  if (diff.breaking.length > 0 && nMaj <= bMaj) {
    violations.push(
      `breaking API changes require a major version bump (${baseVersion} → ${nextVersion}):\n  - ${diff.breaking.join('\n  - ')}`,
    );
  }
  if (diff.breaking.length === 0 && diff.additive.length > 0 && nMaj === bMaj && nMin <= bMin) {
    violations.push(
      `additive API changes require at least a minor version bump (${baseVersion} → ${nextVersion})`,
    );
  }
  return violations;
}
