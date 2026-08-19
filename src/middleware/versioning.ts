import type { Request, Response, NextFunction } from 'express';

/**
 * API Versioning Middleware
 *
 * Performs version negotiation using the `Accept-Version` header.
 * - Supports `v1` (with variations like `1.0`, `1.x`, `1`).
 * - For unsupported versions, returns `406 Not Acceptable` in the standard error format.
 * - Sets RFC-compliant deprecation headers (`Deprecation`, `Sunset`, `Link`) for older versions.
 */
export function versioningMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Read Accept-Version header or fall back to 'v1'
  const acceptVersion =
    (req.headers['accept-version'] as string | undefined)?.toLowerCase() ?? 'v1';

  // Normalize request version: e.g. "v1", "1.0", "1.x", "1" -> "v1"
  let matchedVersion: string | null = null;
  if (/^v?1(\.0)?(\.x)?$/.test(acceptVersion)) {
    matchedVersion = 'v1';
  }

  if (!matchedVersion) {
    res.status(406).json({
      success: false,
      error: {
        code: 'NOT_ACCEPTABLE',
        message: `Unsupported API version requested: "${acceptVersion}". Supported versions: v1`,
      },
      meta: {
        requestId: req.requestId ?? 'unknown',
        timestamp: new Date().toISOString(),
      },
    });
    return;
  }

  // Set API version header
  res.setHeader('X-API-Version', 'v1');

  // Deprecation headers for older version (v1) according to RFC 8594 / RFC 7231
  res.setHeader('Deprecation', 'true');
  res.setHeader('Sunset', 'Wed, 11 Nov 2026 23:59:59 GMT');
  res.setHeader(
    'Link',
    '<https://api.example.com/docs/versioning>; rel="deprecation"; type="text/html"',
  );

  next();
}
