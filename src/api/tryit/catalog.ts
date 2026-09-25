/**
 * Try-it console operation catalog (DX04).
 *
 * Turns the OpenAPI document into the compact, browser-ready catalog the
 * console renders: one entry per operation, with typed parameters and a
 * pre-filled example body. Built once per process from the same spec served
 * at /api/v1/openapi.json, so the console always covers 100% of the
 * documented surface.
 */

import { createHash } from 'crypto';
import {
  exampleFor,
  normalizeOperations,
  type NormalizedParam,
  type OpenApiDocument,
} from '../../lib/openapi/normalize';

export interface TryItOperation {
  id: string;
  method: string;
  path: string;
  summary: string;
  description: string;
  tags: string[];
  deprecated: boolean;
  params: NormalizedParam[];
  body: { required: boolean; contentType: string; example: string } | null;
  responses: Array<{ status: string; description: string }>;
}

export interface TryItCatalog {
  title: string;
  specVersion: string;
  basePath: string;
  operationCount: number;
  tags: string[];
  operations: TryItOperation[];
  /** Content hash; the console embeds it in share links to flag stale links. */
  etag: string;
}

/** Longest description shipped to the browser (keeps the catalog small). */
const MAX_DESCRIPTION = 600;

function trim(text: string): string {
  return text.length > MAX_DESCRIPTION ? `${text.slice(0, MAX_DESCRIPTION - 1)}…` : text;
}

/**
 * The console only ever calls this origin. An absolute or protocol-relative
 * server URL in the spec is ignored rather than trusted (SSRF / open-redirect
 * defence in depth; the browser enforces it again).
 */
export function sameOriginBasePath(url: string | undefined): string {
  return typeof url === 'string' && /^\/(?!\/)[A-Za-z0-9/_.-]*$/.test(url)
    ? url.replace(/\/$/, '')
    : '/api/v1';
}

export function buildCatalog(doc: OpenApiDocument): TryItCatalog {
  const ops = normalizeOperations(doc);
  const operations: TryItOperation[] = ops.map((op) => ({
    id: op.id,
    method: op.method.toUpperCase(),
    path: op.path,
    summary: op.summary,
    description: trim(op.description),
    tags: op.tags.length > 0 ? op.tags : ['Other'],
    deprecated: op.deprecated,
    // Header params are dropped: the console only injects the API key header
    // and never lets a page (or a share link) set arbitrary request headers.
    params: op.params
      .filter((p) => p.in !== 'header')
      .map((p) => ({ ...p, description: p.description ? trim(p.description) : undefined })),
    body: op.body
      ? {
          required: op.body.required,
          contentType: op.body.contentType,
          example:
            op.body.contentType === 'application/json'
              ? JSON.stringify(exampleFor(doc, op.body.schema), null, 2)
              : '',
        }
      : null,
    responses: op.responses.map((r) => ({ status: r.status, description: trim(r.description) })),
  }));
  const tags = Array.from(new Set(operations.flatMap((o) => o.tags))).sort();
  const base = {
    title: doc.info?.title ?? 'API',
    specVersion: doc.info?.version ?? '0.0.0',
    basePath: sameOriginBasePath(doc.servers?.[0]?.url),
    operationCount: operations.length,
    tags,
    operations,
  };
  const etag = createHash('sha256').update(JSON.stringify(base)).digest('hex').slice(0, 16);
  return { ...base, etag };
}
