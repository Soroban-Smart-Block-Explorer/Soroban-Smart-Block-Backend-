/**
 * OpenAPI → normalized operation list.
 *
 * The single interpretation of the OpenAPI document shared by every consumer
 * that must agree on the API surface: the in-browser try-it console
 * (src/api/tryit), the TypeScript SDK generator and the Python client
 * generator (scripts/sdk). Keeping one normalizer means an operation's id,
 * parameters and body shape are identical everywhere, and drift between the
 * spec and any generated artefact is a byte-level diff.
 *
 * Deterministic: output depends only on the input document (paths and
 * methods are sorted; ids are derived, never random).
 */

export const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export type ParamLocation = 'path' | 'query' | 'header';
export type ScalarType = 'string' | 'integer' | 'number' | 'boolean' | 'array' | 'object';

export interface NormalizedParam {
  name: string;
  in: ParamLocation;
  required: boolean;
  type: ScalarType;
  /** Item type when `type === 'array'`. */
  itemType?: ScalarType;
  enum?: Array<string | number>;
  minimum?: number;
  maximum?: number;
  default?: unknown;
  description?: string;
}

export interface NormalizedBody {
  required: boolean;
  contentType: string;
  /** JSON Schema of the body with local `$ref`s left intact. */
  schema: JsonSchema | null;
}

export interface NormalizedResponse {
  status: string;
  description: string;
  schema: JsonSchema | null;
}

export interface NormalizedOperation {
  id: string;
  method: HttpMethod;
  /** Path template relative to the server base, always `{param}` style. */
  path: string;
  summary: string;
  description: string;
  tags: string[];
  deprecated: boolean;
  params: NormalizedParam[];
  body: NormalizedBody | null;
  responses: NormalizedResponse[];
}

/** Minimal structural JSON Schema type (OpenAPI 3.0 subset). */
export interface JsonSchema {
  $ref?: string;
  type?: string | string[];
  format?: string;
  nullable?: boolean;
  enum?: unknown[];
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  oneOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  allOf?: JsonSchema[];
  description?: string;
  example?: unknown;
  default?: unknown;
  minimum?: number;
  maximum?: number;
  title?: string;
  [key: string]: unknown;
}

export interface OpenApiDocument {
  openapi?: string;
  info?: { title?: string; version?: string };
  servers?: Array<{ url: string }>;
  paths?: Record<string, Record<string, unknown>>;
  components?: { schemas?: Record<string, JsonSchema>; [key: string]: unknown };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Convert Express-style `:param` segments to OpenAPI `{param}`. */
export function normalizePathTemplate(path: string): string {
  return path.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, '{$1}');
}

export function pathParamNames(path: string): string[] {
  return Array.from(path.matchAll(/\{([^}]+)\}/g), (m) => m[1]);
}

function pascal(word: string): string {
  return word
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join('');
}

/**
 * Derive a stable camelCase id: `GET /transactions/{hash}` → `getTransactionsByHash`.
 * An explicit `operationId` in the spec always wins.
 */
export function deriveOperationId(method: string, path: string): string {
  const parts = normalizePathTemplate(path)
    .split('/')
    .filter(Boolean)
    .map((seg) => {
      const m = /^\{(.+)\}$/.exec(seg);
      return m ? `By${pascal(m[1])}` : pascal(seg);
    });
  const id = method.toLowerCase() + parts.join('');
  return /^[a-z]/.test(id) ? id : `op${id}`;
}

function scalarType(schema: unknown): ScalarType {
  if (!isRecord(schema)) return 'string';
  const t = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  switch (t) {
    case 'integer':
    case 'number':
    case 'boolean':
    case 'array':
    case 'object':
      return t;
    default:
      return 'string';
  }
}

function normalizeParam(raw: unknown): NormalizedParam | null {
  if (!isRecord(raw) || typeof raw.name !== 'string') return null;
  const location = raw.in;
  if (location !== 'path' && location !== 'query' && location !== 'header') return null;
  const schema = isRecord(raw.schema) ? raw.schema : {};
  const p: NormalizedParam = {
    name: raw.name,
    in: location,
    required: location === 'path' ? true : raw.required === true,
    type: scalarType(schema),
  };
  if (p.type === 'array') p.itemType = scalarType(schema.items);
  if (Array.isArray(schema.enum)) {
    p.enum = schema.enum.filter(
      (v): v is string | number => typeof v === 'string' || typeof v === 'number',
    );
  }
  if (typeof schema.minimum === 'number') p.minimum = schema.minimum;
  if (typeof schema.maximum === 'number') p.maximum = schema.maximum;
  if (schema.default !== undefined) p.default = schema.default;
  if (typeof raw.description === 'string') p.description = raw.description.trim();
  return p;
}

function normalizeBody(raw: unknown): NormalizedBody | null {
  if (!isRecord(raw) || !isRecord(raw.content)) return null;
  const types = Object.keys(raw.content).sort();
  const contentType = types.includes('application/json') ? 'application/json' : types[0];
  if (!contentType) return null;
  const media = raw.content[contentType];
  const schema = isRecord(media) && isRecord(media.schema) ? (media.schema as JsonSchema) : null;
  return { required: raw.required === true, contentType, schema };
}

function normalizeResponses(raw: unknown): NormalizedResponse[] {
  if (!isRecord(raw)) return [];
  return Object.keys(raw)
    .sort()
    .map((status) => {
      const r = raw[status];
      const content = isRecord(r) && isRecord(r.content) ? r.content : {};
      const json = content['application/json'];
      return {
        status,
        description: isRecord(r) && typeof r.description === 'string' ? r.description : '',
        schema: isRecord(json) && isRecord(json.schema) ? (json.schema as JsonSchema) : null,
      };
    });
}

/**
 * Normalize every operation in the document. Path params that appear in the
 * template but are not declared are synthesized as required strings, so every
 * consumer can always fill every placeholder.
 */
export function normalizeOperations(doc: OpenApiDocument): NormalizedOperation[] {
  const out: NormalizedOperation[] = [];
  const paths = isRecord(doc.paths) ? doc.paths : {};
  for (const rawPath of Object.keys(paths).sort()) {
    const item = paths[rawPath];
    if (!isRecord(item)) continue;
    const path = normalizePathTemplate(rawPath);
    const shared = Array.isArray(item.parameters) ? item.parameters : [];
    for (const method of HTTP_METHODS) {
      const op = item[method];
      if (!isRecord(op)) continue;
      const declared = [...shared, ...(Array.isArray(op.parameters) ? op.parameters : [])]
        .map(normalizeParam)
        .filter((p): p is NormalizedParam => p !== null);
      // Later (operation-level) declarations override path-item ones.
      const byKey = new Map<string, NormalizedParam>();
      for (const p of declared) byKey.set(`${p.in}:${p.name}`, p);
      for (const name of pathParamNames(path)) {
        if (!byKey.has(`path:${name}`)) {
          byKey.set(`path:${name}`, { name, in: 'path', required: true, type: 'string' });
        }
      }
      const templateNames = new Set(pathParamNames(path));
      const params = Array.from(byKey.values()).filter(
        (p) => p.in !== 'path' || templateNames.has(p.name),
      );
      const order: Record<ParamLocation, number> = { path: 0, query: 1, header: 2 };
      params.sort((a, b) =>
        a.in === b.in
          ? a.in === 'path'
            ? pathParamNames(path).indexOf(a.name) - pathParamNames(path).indexOf(b.name)
            : a.name.localeCompare(b.name)
          : order[a.in] - order[b.in],
      );
      out.push({
        id:
          typeof op.operationId === 'string' && /^[A-Za-z][A-Za-z0-9_]*$/.test(op.operationId)
            ? op.operationId
            : deriveOperationId(method, path),
        method,
        path,
        summary: typeof op.summary === 'string' ? op.summary.trim() : '',
        description: typeof op.description === 'string' ? op.description.trim() : '',
        tags: Array.isArray(op.tags)
          ? op.tags.filter((t): t is string => typeof t === 'string')
          : [],
        deprecated: op.deprecated === true,
        params,
        body: normalizeBody(op.requestBody),
        responses: normalizeResponses(op.responses),
      });
    }
  }
  // Resolve id collisions deterministically (sorted order ⇒ stable suffixes).
  const seen = new Map<string, number>();
  for (const op of out) {
    const n = seen.get(op.id) ?? 0;
    seen.set(op.id, n + 1);
    if (n > 0) op.id = `${op.id}${n + 1}`;
  }
  return out;
}

/** Resolve a local `#/components/schemas/X` reference. */
export function resolveRef(doc: OpenApiDocument, schema: JsonSchema): JsonSchema {
  let current = schema;
  const seen = new Set<string>();
  while (current.$ref && !seen.has(current.$ref)) {
    seen.add(current.$ref);
    const m = /^#\/components\/schemas\/(.+)$/.exec(current.$ref);
    const target = m ? doc.components?.schemas?.[m[1]] : undefined;
    if (!target) return {};
    current = target;
  }
  return current;
}

/**
 * Build a representative example value for a schema (used for try-it request
 * bodies and SDK docs). Depth-limited; never throws.
 */
export function exampleFor(doc: OpenApiDocument, schema: JsonSchema | null, depth = 0): unknown {
  if (!schema || depth > 4) return null;
  const s = resolveRef(doc, schema);
  if (s.example !== undefined) return s.example;
  if (s.default !== undefined) return s.default;
  if (Array.isArray(s.enum) && s.enum.length > 0) return s.enum[0];
  const variants = s.oneOf ?? s.anyOf;
  if (variants && variants.length > 0) return exampleFor(doc, variants[0], depth + 1);
  if (s.allOf && s.allOf.length > 0) {
    const merged: Record<string, unknown> = {};
    for (const part of s.allOf) {
      const v = exampleFor(doc, part, depth + 1);
      if (isRecord(v)) Object.assign(merged, v);
    }
    return merged;
  }
  switch (scalarType(s)) {
    case 'integer':
      return typeof s.minimum === 'number' ? s.minimum : 0;
    case 'number':
      return typeof s.minimum === 'number' ? s.minimum : 0;
    case 'boolean':
      return false;
    case 'array':
      return s.items ? [exampleFor(doc, s.items, depth + 1)] : [];
    case 'object': {
      const obj: Record<string, unknown> = {};
      for (const [key, prop] of Object.entries(s.properties ?? {})) {
        obj[key] = exampleFor(doc, prop, depth + 1);
      }
      return obj;
    }
    default:
      if (s.properties) return exampleFor(doc, { ...s, type: 'object' }, depth);
      if (s.format === 'date-time') return '2026-01-01T00:00:00Z';
      if (s.format === 'uri') return 'https://example.com/hook';
      return 'string';
  }
}
