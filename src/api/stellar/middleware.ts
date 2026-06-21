import { Request, Response, NextFunction } from 'express';
import { isValidStellarAddress } from '../../middleware/sanitize';

export function requireWalletAuth(req: Request, res: Response, next: NextFunction) {
  const wallet = req.headers['x-wallet-address'] as string | undefined;
  if (!wallet || !isValidStellarAddress(wallet)) {
    return res
      .status(401)
      .json({ error: 'Wallet authentication required. Provide X-Wallet-Address header.' });
  }
  (req as Request & { walletAddress: string }).walletAddress = wallet;
  next();
}

export function requireAdminAuth(req: Request, res: Response, next: NextFunction) {
  const apiKey = req.headers['x-api-key'] as string | undefined;
  const developerKeys = (process.env.API_KEYS_DEVELOPER ?? '').split(',').filter(Boolean);
  const premiumKeys = (process.env.API_KEYS_PREMIUM ?? '').split(',').filter(Boolean);
  const adminKeys = [...developerKeys, ...premiumKeys];

  if (!apiKey || !adminKeys.includes(apiKey)) {
    return res.status(403).json({ error: 'Admin API key required' });
  }
  next();
}
