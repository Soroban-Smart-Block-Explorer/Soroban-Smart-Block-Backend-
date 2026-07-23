import { Router, Request, Response } from 'express';
import { prismaWrite as prisma } from '../db';
import { requireAuth, requireRole } from '../auth/middleware';

export const authSecurityRouter = Router();

interface RiskFlag {
  flag: string;
  severity: 'low' | 'medium' | 'high';
}

async function assessSessionRisk(
  sessionId: string,
  userId: string,
): Promise<{ score: number; flags: RiskFlag[] }> {
  const flags: RiskFlag[] = [];

  // Check recent failed logins for this user
  const recentFailed = await prisma.authEvent.count({
    where: {
      userId,
      eventType: 'failed_verify',
      createdAt: { gte: new Date(Date.now() - 24 * 3600 * 1000) },
    },
  });
  if (recentFailed >= 5) flags.push({ flag: 'multiple_failed_logins', severity: 'high' });
  else if (recentFailed >= 2) flags.push({ flag: 'failed_login_attempts', severity: 'medium' });

  // Check logins from multiple IPs in short window
  const recentLogins = await prisma.authEvent.findMany({
    where: {
      userId,
      eventType: 'login',
      createdAt: { gte: new Date(Date.now() - 60 * 60 * 1000) },
    },
    select: { ipAddress: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });

  const uniqueIps = new Set(recentLogins.map((e) => e.ipAddress).filter(Boolean));
  if (uniqueIps.size >= 3) flags.push({ flag: 'multiple_ips_short_window', severity: 'high' });
  else if (uniqueIps.size >= 2) flags.push({ flag: 'different_ip', severity: 'low' });

  // Impossible travel: check time between logins from different IPs
  if (recentLogins.length >= 2) {
    for (let i = 1; i < recentLogins.length; i++) {
      const prev = recentLogins[i - 1];
      const curr = recentLogins[i];
      if (prev.ipAddress && curr.ipAddress && prev.ipAddress !== curr.ipAddress) {
        const diffMs = curr.createdAt.getTime() - prev.createdAt.getTime();
        if (diffMs < 5 * 60 * 1000) {
          // <5 min between different IPs
          flags.push({ flag: 'impossible_travel', severity: 'high' });
          break;
        }
      }
    }
  }

  const score = flags.reduce((s, f) => {
    return s + (f.severity === 'high' ? 0.4 : f.severity === 'medium' ? 0.2 : 0.1);
  }, 0);

  return { score: Math.min(score, 1), flags };
}

authSecurityRouter.get(
  '/sessions/:sessionId/risk',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const { sessionId } = req.params;
    const session = await prisma.authSession.findFirst({
      where: { id: sessionId, userId: req.user!.id },
    });
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const { score, flags } = await assessSessionRisk(sessionId, req.user!.id);
    const level = score >= 0.6 ? 'high' : score >= 0.3 ? 'medium' : 'low';

    res.json({
      riskScore: Math.round(score * 100) / 100,
      riskLevel: level,
      flags: flags.map((f) => f.flag),
      lastAssessment: new Date().toISOString(),
    });
  }),
);

authSecurityRouter.get(
  '/events',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const events = await prisma.authEvent.findMany({
      where: {
        userId: req.user!.id,
        eventType: {
          in: [
            'failed_verify',
            'failed_challenge',
            'session_revoked',
            'access_denied',
            'token_rotated',
          ],
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    res.json({ events });
  }),
);

authSecurityRouter.get(
  '/overview',
  requireAuth,
  requireRole('admin'),
  asyncHandler(async (_req, res) => {
    const since24h = new Date(Date.now() - 24 * 3600 * 1000);

    const [totalUsers, activeSessions, failedLogins] = await Promise.all([
      prisma.walletUser.count({ where: { isActive: true } }),
      prisma.authSession.count({ where: { isActive: true } }),
      prisma.authEvent.count({
        where: { eventType: 'failed_verify', createdAt: { gte: since24h } },
      }),
    ]);

    // Find sessions with risk flags (multiple IPs in last hour)
    const suspiciousUsers = await prisma.authEvent.groupBy({
      by: ['userId'],
      where: { eventType: 'login', createdAt: { gte: since24h } },
      _count: { ipAddress: true },
      having: { ipAddress: { _count: { gt: 2 } } },
    });

    res.json({
      totalUsers,
      activeSessions,
      failedLogins24h: failedLogins,
      flaggedSessions: suspiciousUsers.length,
      suspiciousPatterns: suspiciousUsers.length > 0 ? ['multiple_ips'] : [],
    });
  }),
);
