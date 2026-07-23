import { Request, Response, NextFunction } from 'express';
import { verifyToken } from './tokens';
import { prismaWrite as prisma } from '../db';
import { hashToken } from './tokens';
import { hasRole, type Role, type Tier } from './rbac';
import { background } from '../utils/background';

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers['authorization'];
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Authentication required' });

  const payload = await verifyToken(token);
  if (!payload) return res.status(401).json({ error: 'Invalid or expired token' });

  // Check session is still active
  const session = await prisma.authSession.findFirst({
    where: { id: payload.sessionId, tokenHash: hashToken(token), isActive: true },
    include: { user: true },
  });
  if (!session || !session.user.isActive) {
    return res.status(401).json({ error: 'Session revoked or user inactive' });
  }

  // Update last activity (non-blocking)
  background('auth.updateSessionActivity', () =>
    prisma.authSession
      .update({ where: { id: session.id }, data: { lastActivity: new Date() } })
      .then(() => {}),
  );

  req.user = {
    id: session.user.id,
    address: session.user.address,
    role: session.user.role as Role,
    tier: session.user.tier as Tier,
    sessionId: payload.sessionId,
    appId: payload.appId,
  };
  next();
}

export async function optionalAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers['authorization'];
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return next();

  const payload = await verifyToken(token);
  if (!payload) return next();

  const session = await prisma.authSession.findFirst({
    where: { id: payload.sessionId, tokenHash: hashToken(token), isActive: true },
    include: { user: true },
  });
  if (session?.user.isActive) {
    req.user = {
      id: session.user.id,
      address: session.user.address,
      role: session.user.role as Role,
      tier: session.user.tier as Tier,
      sessionId: payload.sessionId,
      appId: payload.appId,
    };
  }
  next();
}

export function requireRole(role: Role) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    if (!hasRole(req.user.role, role)) return res.status(403).json({ error: 'Insufficient role' });
    next();
  };
}

export function requireTier(tier: Tier) {
  const order: Tier[] = ['free', 'developer', 'premium', 'enterprise'];
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    if (order.indexOf(req.user.tier) < order.indexOf(tier)) {
      return res.status(403).json({ error: `Requires ${tier} tier or higher` });
    }
    next();
  };
}
