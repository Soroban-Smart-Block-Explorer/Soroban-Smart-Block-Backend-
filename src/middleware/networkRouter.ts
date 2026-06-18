import { Request, Response, NextFunction } from 'express';
import { getProfile, type NetworkName } from '../profiles';

const VALID_NETWORKS = new Set<NetworkName>(['mainnet', 'testnet', 'devnet']);

/**
 * Resolves the target network for a request using two strategies (in order):
 *
 * 1. `X-Network` request header  (e.g. `X-Network: mainnet`)
 * 2. Subdomain prefix             (e.g. `mainnet-api.example.com`)
 *
 * Falls back to the server's own `STELLAR_NETWORK` env var (the default
 * network this instance was started with).
 *
 * On success, attaches `req.network` (the resolved NetworkName) and
 * `req.networkProfile` (the full NetworkProfile) so downstream handlers can
 * use network-specific config without re-reading env vars.
 *
 * Responds 400 if an explicit `X-Network` value is unrecognised.
 */
export function networkRouter(req: Request, res: Response, next: NextFunction): void {
  // 1. Explicit header takes highest precedence
  const headerValue = (req.headers['x-network'] as string | undefined)?.toLowerCase().trim();
  if (headerValue) {
    if (!VALID_NETWORKS.has(headerValue as NetworkName)) {
      res.status(400).json({
        error: `Unknown network "${headerValue}". Valid values: ${[...VALID_NETWORKS].join(', ')}`,
      });
      return;
    }
    const profile = getProfile(headerValue);
    req.network = profile.name;
    req.networkProfile = profile;
    res.setHeader('X-Network', profile.name);
    return next();
  }

  // 2. Subdomain detection  (e.g. "testnet-api.example.com" → "testnet")
  const host = req.hostname ?? '';
  const subdomain = host.split('.')[0] ?? '';
  for (const net of VALID_NETWORKS) {
    if (subdomain === net || subdomain.startsWith(`${net}-`)) {
      const profile = getProfile(net);
      req.network = profile.name;
      req.networkProfile = profile;
      res.setHeader('X-Network', profile.name);
      return next();
    }
  }

  // 3. Default: use the network this server instance was started with
  const defaultNetwork = (process.env.STELLAR_NETWORK ?? 'testnet') as NetworkName;
  const profile = getProfile(defaultNetwork);
  req.network = profile.name;
  req.networkProfile = profile;
  res.setHeader('X-Network', profile.name);
  next();
}
