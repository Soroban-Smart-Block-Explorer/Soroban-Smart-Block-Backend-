import type { Request, Response, NextFunction } from 'express';

const PROXY_HEADERS = [
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-forwarded-port',
  'x-forwarded-server',
];

function isTrustProxyEnabled(req: Request): boolean {
  const trustProxy = req.app.get('trust proxy');
  return (
    trustProxy === true ||
    Array.isArray(trustProxy) ||
    (typeof trustProxy === 'string' && trustProxy.length > 0)
  );
}

function hasProxyHeaders(req: Request): boolean {
  return PROXY_HEADERS.some((name) => req.headers[name] !== undefined);
}

export function rejectUntrustedForwardedHeaders(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!isTrustProxyEnabled(req) && hasProxyHeaders(req)) {
    res.status(400).json({ error: 'Untrusted proxy headers are not allowed' });
    return;
  }

  next();
}
