import { Request, Response, NextFunction } from 'express';
import { config } from '../config';

export function adminAuth(req: Request, res: Response, next: NextFunction) {
  const token = req.headers['x-admin-token'] as string | undefined;

  if (!token) {
    return res.status(401).json({ error: 'Unauthorized: admin token required' });
  }

  if (!config.adminApiKey) {
    return res.status(500).json({ error: 'Server misconfiguration: ADMIN_API_KEY not set' });
  }

  if (token !== config.adminApiKey) {
    return res.status(401).json({ error: 'Unauthorized: invalid admin token' });
  }

  req.actor = 'admin';
  next();
}
