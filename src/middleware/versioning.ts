import type { Request, Response, NextFunction } from 'express';

export type VersionStatus = 'active' | 'deprecated' | 'retired';

export interface ApiVersionInfo {
  version: string;
  status: VersionStatus;
  /** RFC 7231 date; required when status is deprecated. */
  sunset?: string;
}

/**
 * Version registry. Policy (docs/api-versioning.md): no breaking changes within
 * a version; a version is deprecated at least 6 months before it is retired.
 */
export const API_VERSIONS: readonly ApiVersionInfo[] = [{ version: 'v1', status: 'active' }];

export const DEFAULT_API_VERSION = 'v1';
export const DEPRECATION_POLICY_URL = 'https://api.example.com/docs/versioning';

/** Normalizes "v1", "1", "1.0", "1.x" -> "v1"; returns null when malformed. */
export function normalizeVersion(raw: string): string | null {
  const m = /^v?(\d+)(\.(\d+|x))*$/.exec(raw.trim().toLowerCase());
  return m ? `v${m[1]}` : null;
}

export function resolveVersion(raw: string | undefined): ApiVersionInfo | null {
  const normalized = normalizeVersion(raw ?? DEFAULT_API_VERSION);
  if (!normalized) return null;
  const info = API_VERSIONS.find((v) => v.version === normalized);
  return info && info.status !== 'retired' ? info : null;
}

/**
 * API Versioning Middleware
 *
 * Negotiates the version via the `Accept-Version` header (default v1), rejects
 * unknown/retired versions with 406, and emits `X-API-Version` plus
 * `Deprecation`/`Sunset`/`Link` headers only for deprecated versions.
 */
export function versioningMiddleware(req: Request, res: Response, next: NextFunction): void {
  const raw = req.headers['accept-version'] as string | undefined;
  const info = resolveVersion(raw);

  if (!info) {
    const supported = API_VERSIONS.filter((v) => v.status !== 'retired').map((v) => v.version);
    res.status(406).json({
      success: false,
      error: {
        code: 'NOT_ACCEPTABLE',
        message: `Unsupported API version requested: "${raw}". Supported versions: ${supported.join(', ')}`,
      },
      meta: {
        requestId: req.requestId ?? 'unknown',
        timestamp: new Date().toISOString(),
      },
    });
    return;
  }

  res.setHeader('X-API-Version', info.version);
  if (info.status === 'deprecated') {
    res.setHeader('Deprecation', 'true');
    if (info.sunset) res.setHeader('Sunset', info.sunset);
    res.setHeader('Link', `<${DEPRECATION_POLICY_URL}>; rel="deprecation"; type="text/html"`);
  }

  next();
}
