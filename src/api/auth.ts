import { Router, Request, Response } from 'express';
import { Keypair } from '@stellar/stellar-sdk';
import { prismaWrite as prisma } from '../db';
import {
  createChallenge,
  consumeChallenge,
  getChallenge,
  incrementAttempts,
  checkChallengeRateLimit,
} from '../auth/challenge';
import { issueTokens, hashToken, generateSessionId, REFRESH_TOKEN_TTL } from '../auth/tokens';
import { getJwks, rotateKeys } from '../auth/keys';
import { getFeatures, featureList } from '../auth/rbac';
import { requireAuth, requireRole } from '../auth/middleware';

export const authRouter = Router();

// ─── JWKS ────────────────────────────────────────────────────────────────────
authRouter.get(
  '/.well-known/jwks.json',
  asyncHandler(async (_req, res) => {
    res.json(await getJwks());
  }),
);

// ─── Challenge ────────────────────────────────────────────────────────────────
authRouter.post(
  '/challenge',
  asyncHandler(async (req: Request, res: Response) => {
    const { address, network = 'testnet', appId = 'explorer-web' } = req.body ?? {};
    if (!address) return res.status(400).json({ error: 'address required' });

    const ip = req.ip ?? 'unknown';
    const allowed = await checkChallengeRateLimit(ip);
    if (!allowed) return res.status(429).json({ error: 'Rate limit exceeded (5/min per IP)' });

    const ch = await createChallenge(address, network, appId);
    return res.json({
      challenge: ch.message,
      challengeId: ch.challengeId,
      expiresAt: ch.expiresAt,
      type: 'stellar_message',
    });
  }),
);

// ─── Verify ───────────────────────────────────────────────────────────────────
authRouter.post(
  '/verify',
  asyncHandler(async (req: Request, res: Response) => {
    const { address, challengeId, signature, network = 'testnet' } = req.body ?? {};
    if (!address || !challengeId || !signature) {
      return res.status(400).json({ error: 'address, challengeId, and signature required' });
    }

    const ch = await getChallenge(challengeId);
    if (!ch) return res.status(400).json({ error: 'Challenge not found or expired' });
    if (ch.address !== address) return res.status(400).json({ error: 'Address mismatch' });

    const attempts = await incrementAttempts(challengeId);
    if (attempts > 3) {
      await consumeChallenge(challengeId);
      return res.status(429).json({ error: 'Too many verification attempts' });
    }

    // Verify Stellar ed25519 signature
    try {
      const kp = Keypair.fromPublicKey(address);
      const messageBytes = Buffer.from(ch.message);
      const sigBytes = Buffer.from(signature, 'base64');
      const valid = kp.verify(messageBytes, sigBytes);
      if (!valid) {
        return res.status(401).json({ error: 'Invalid signature' });
      }
    } catch {
      return res.status(401).json({ error: 'Signature verification failed' });
    }

    await consumeChallenge(challengeId);

    // Upsert user
    let user = await prisma.walletUser.findUnique({ where: { address } });
    if (!user) {
      user = await prisma.walletUser.create({
        data: { address, role: 'user', tier: 'free' },
      });
    } else {
      await prisma.walletUser.update({ where: { id: user.id }, data: { lastLogin: new Date() } });
    }

    const sessionId = generateSessionId();
    const tokens = await issueTokens({
      sub: address,
      userId: user.id,
      role: user.role,
      tier: user.tier,
      sessionId,
      appId: ch.appId,
    });

    const ip = req.ip ?? 'unknown';
    const ua = req.headers['user-agent'] ?? '';

    await prisma.authSession.create({
      data: {
        id: sessionId,
        userId: user.id,
        tokenHash: tokens.tokenHash,
        refreshTokenHash: tokens.refreshTokenHash,
        deviceInfo: { ip, userAgent: ua },
        appId: ch.appId,
        expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL * 1000),
      },
    });

    await prisma.authEvent.create({
      data: {
        userId: user.id,
        sessionId,
        eventType: 'login',
        ipAddress: ip,
        userAgent: ua,
        metadata: { network, appId: ch.appId },
      },
    });

    return res.json({
      token: tokens.token,
      refreshToken: tokens.refreshToken,
      sessionId,
      expiresAt: tokens.expiresAt.toISOString(),
    });
  }),
);

// ─── Refresh ──────────────────────────────────────────────────────────────────
authRouter.post(
  '/refresh',
  asyncHandler(async (req: Request, res: Response) => {
    const { refreshToken } = req.body ?? {};
    if (!refreshToken) return res.status(400).json({ error: 'refreshToken required' });

    const hash = hashToken(refreshToken);
    const session = await prisma.authSession.findFirst({
      where: { refreshTokenHash: hash, isActive: true },
      include: { user: true },
    });
    if (!session) return res.status(401).json({ error: 'Invalid or expired refresh token' });
    if (new Date(session.expiresAt) < new Date()) {
      return res.status(401).json({ error: 'Refresh token expired' });
    }

    const tokens = await issueTokens({
      sub: session.user.address,
      userId: session.user.id,
      role: session.user.role,
      tier: session.user.tier,
      sessionId: session.id,
      appId: session.appId ?? 'explorer-web',
    });

    // Rotate: update token hashes
    await prisma.authSession.update({
      where: { id: session.id },
      data: {
        tokenHash: tokens.tokenHash,
        refreshTokenHash: tokens.refreshTokenHash,
        lastActivity: new Date(),
      },
    });

    await prisma.authEvent.create({
      data: {
        userId: session.user.id,
        sessionId: session.id,
        eventType: 'token_rotated',
        ipAddress: req.ip,
      },
    });

    return res.json({
      token: tokens.token,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt.toISOString(),
    });
  }),
);

// ─── Logout ───────────────────────────────────────────────────────────────────
authRouter.post(
  '/logout',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    await prisma.authSession.update({
      where: { id: req.user!.sessionId },
      data: { isActive: false, revokedAt: new Date(), revocationReason: 'logout' },
    });
    await prisma.authEvent.create({
      data: {
        userId: req.user!.id,
        sessionId: req.user!.sessionId,
        eventType: 'logout',
        ipAddress: req.ip,
      },
    });
    res.json({ success: true });
  }),
);

authRouter.post(
  '/logout/all',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    await prisma.authSession.updateMany({
      where: { userId: req.user!.id, isActive: true },
      data: { isActive: false, revokedAt: new Date(), revocationReason: 'logout' },
    });
    await prisma.authEvent.create({
      data: { userId: req.user!.id, eventType: 'logout', metadata: { all: true } },
    });
    res.json({ success: true });
  }),
);

// ─── Key rotation (admin) ─────────────────────────────────────────────────────
authRouter.post(
  '/keys/rotate',
  requireAuth,
  requireRole('admin'),
  asyncHandler(async (_req, res) => {
    const kp = await rotateKeys();
    res.json({ kid: kp.kid, createdAt: new Date(kp.createdAt).toISOString() });
  }),
);

// ─── Me ───────────────────────────────────────────────────────────────────────
authRouter.get(
  '/me',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const user = await prisma.walletUser.findUnique({ where: { id: req.user!.id } });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const [activeSessions, totalSessions, webhooks] = await Promise.all([
      prisma.authSession.count({ where: { userId: user.id, isActive: true } }),
      prisma.authSession.count({ where: { userId: user.id } }),
      prisma.authWebhook.count({ where: { userId: user.id } }),
    ]);

    const tier = user.tier as 'free' | 'developer' | 'premium' | 'enterprise';
    const cfg = getFeatures(tier);

    return res.json({
      address: user.address,
      displayName: user.displayName,
      role: user.role,
      tier,
      email: user.email,
      createdAt: user.createdAt,
      lastLogin: user.lastLogin,
      features: featureList(tier),
      rateLimit: { requestsPerMinute: cfg.rateLimit.perMinute, burstLimit: cfg.rateLimit.burst },
      stats: { activeSessions, totalSessions, webhooks },
    });
  }),
);

authRouter.patch(
  '/me',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const { displayName, email, avatarUrl } = req.body ?? {};
    const data: Record<string, unknown> = {};
    if (displayName !== undefined) data.displayName = displayName;
    if (email !== undefined) data.email = email;
    if (avatarUrl !== undefined) data.avatarUrl = avatarUrl;
    const user = await prisma.walletUser.update({ where: { id: req.user!.id }, data });
    res.json({ success: true, displayName: user.displayName, email: user.email });
  }),
);

authRouter.delete(
  '/me',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    await prisma.authSession.updateMany({
      where: { userId: req.user!.id },
      data: { isActive: false, revokedAt: new Date(), revocationReason: 'admin' },
    });
    await prisma.walletUser.update({ where: { id: req.user!.id }, data: { isActive: false } });
    res.json({ success: true });
  }),
);

// ─── Sessions ─────────────────────────────────────────────────────────────────
authRouter.get(
  '/me/sessions',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const sessions = await prisma.authSession.findMany({
      where: { userId: req.user!.id, isActive: true },
      orderBy: { lastActivity: 'desc' },
    });
    res.json({
      sessions: sessions.map((s) => ({
        id: s.id,
        deviceInfo: s.deviceInfo,
        appId: s.appId,
        createdAt: s.createdAt,
        lastActivity: s.lastActivity,
        isCurrent: s.id === req.user!.sessionId,
      })),
    });
  }),
);

authRouter.delete(
  '/me/sessions/:id',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const session = await prisma.authSession.findFirst({
      where: { id: req.params.id, userId: req.user!.id },
    });
    if (!session) return res.status(404).json({ error: 'Session not found' });
    await prisma.authSession.update({
      where: { id: session.id },
      data: { isActive: false, revokedAt: new Date(), revocationReason: 'logout' },
    });
    res.json({ success: true });
  }),
);

// ─── Activity ─────────────────────────────────────────────────────────────────
authRouter.get(
  '/me/activity',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const events = await prisma.authEvent.findMany({
      where: { userId: req.user!.id },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    res.json({ events });
  }),
);

// ─── Check Access ─────────────────────────────────────────────────────────────
authRouter.get(
  '/check-access',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const tier = req.user!.tier;
    const cfg = getFeatures(tier);
    const order: Array<typeof tier> = ['free', 'developer', 'premium', 'enterprise'];
    const nextIdx = order.indexOf(tier) + 1;
    const nextTier = order[nextIdx] as typeof tier | undefined;

    res.json({
      tier,
      features: {
        webhooks: { max: cfg.webhooks.max, enabled: cfg.webhooks.enabled },
        dashboards: { max: cfg.dashboards.max, enabled: true },
        rateLimit: cfg.rateLimit,
      },
      tokenRequirements: {
        currentTier: tier,
        nextTier: nextTier ?? 'max',
      },
    });
  }),
);
