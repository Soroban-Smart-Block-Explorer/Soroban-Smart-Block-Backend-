/**
 * Runtime request building + validation against the generated operation
 * metadata, mirroring the declared TypeScript types so untyped (JS) callers
 * get the same guarantees.
 */
import { RequestValidationError } from './errors';
import type { OperationSpec, QueryParamSpec } from '../generated/operations';

export interface CallParams {
  path?: Record<string, string | number>;
  query?: Record<string, unknown>;
  body?: unknown;
}

function checkQuery(spec: QueryParamSpec, value: unknown): string | null {
  const values = Array.isArray(value) ? value : [value];
  if (spec.type === 'array' && !Array.isArray(value)) return `${spec.name} must be an array`;
  const itemType = spec.type === 'array' ? (spec.itemType ?? 'string') : spec.type;
  for (const v of values) {
    if (itemType === 'integer' && !(typeof v === 'number' && Number.isInteger(v))) {
      return `${spec.name} must be an integer`;
    }
    if (itemType === 'number' && !(typeof v === 'number' && Number.isFinite(v))) {
      return `${spec.name} must be a number`;
    }
    if (itemType === 'boolean' && typeof v !== 'boolean') return `${spec.name} must be a boolean`;
    if (itemType === 'string' && typeof v !== 'string') return `${spec.name} must be a string`;
    if (typeof v === 'number') {
      if (spec.minimum !== undefined && v < spec.minimum)
        return `${spec.name} must be >= ${spec.minimum}`;
      if (spec.maximum !== undefined && v > spec.maximum)
        return `${spec.name} must be <= ${spec.maximum}`;
    }
    if (spec.enum && !spec.enum.includes(v as string | number)) {
      return `${spec.name} must be one of ${spec.enum.join(', ')}`;
    }
  }
  return null;
}

/** Validate params and produce the encoded relative path + body. */
export function buildRequest(
  operationId: string,
  spec: OperationSpec,
  params: CallParams = {},
): { path: string; body?: string; contentType?: string } {
  const issues: string[] = [];
  let path = spec.path;
  for (const name of spec.pathParams) {
    const raw = params.path?.[name];
    if (raw === undefined || raw === null || String(raw) === '') {
      issues.push(`path parameter ${name} is required`);
      continue;
    }
    const value = String(raw);
    if (value === '.' || value === '..') {
      issues.push(`path parameter ${name} must not be a dot segment`);
      continue;
    }
    path = path.split(`{${name}}`).join(encodeURIComponent(value));
  }
  const search = new URLSearchParams();
  const known = new Set(spec.query.map((q) => q.name));
  for (const key of Object.keys(params.query ?? {})) {
    if (!known.has(key)) issues.push(`unknown query parameter ${key}`);
  }
  for (const q of spec.query) {
    const value = params.query?.[q.name];
    if (value === undefined || value === null) {
      if (q.required) issues.push(`query parameter ${q.name} is required`);
      continue;
    }
    const problem = checkQuery(q, value);
    if (problem) {
      issues.push(problem);
      continue;
    }
    if (Array.isArray(value)) search.set(q.name, value.map(String).join(','));
    else search.set(q.name, String(value));
  }
  let body: string | undefined;
  if (params.body !== undefined) {
    if (spec.body === 'none') issues.push('this operation does not accept a body');
    else if (spec.contentType === 'application/json') body = JSON.stringify(params.body);
    else body = String(params.body);
  } else if (spec.body === 'required') {
    issues.push('request body is required');
  }
  if (issues.length > 0) throw new RequestValidationError(operationId, issues);
  const qs = search.toString();
  return { path: qs ? `${path}?${qs}` : path, body, contentType: spec.contentType };
}
