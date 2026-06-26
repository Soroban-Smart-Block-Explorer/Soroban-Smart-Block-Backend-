import { Router, Request, Response } from 'express';
import { randomBytes, createHash } from 'crypto';
import { prismaWrite as prisma } from '../db';
import { requireAuth } from '../auth/middleware';
import { issueTokens, generateSessionId, REFRESH_TOKEN_TTL } from '../auth/tokens';

export const authOAuth2Router = Router();

// App registration
authOAuth2Router.post('/apps', requireAuth, async (req: Request, res: Response) => {
  const { name, redirectUris, scopes = [] } = req.body ?? {};
  if (!name || !redirectUris || !Array.isArray(redirectUris)) {
    return res.status(400).json({ error: 'name and redirectUris[] required' });
  }

  const clientId = `app_${randomBytes(12).toString('hex')}`;
  const clientSecret = randomBytes(32).toString('hex');

  const app = await prisma.oAuthApp.create({
    data: {
      clientId,
      clientSecret: createHash('sha256').update(clientSecret).digest('hex'),
      name,
      redirectUris,
      scopes,
      ownerId: req.user!.id,
    },
  });

  res.status(201).json({
    clientId: app.clientId,
    clientSecret, // shown once
    name: app.name,
    redirectUris: app.redirectUris,
    scopes: app.scopes,
  });
});

authOAuth2Router.get('/apps', requireAuth, async (req: Request, res: Response) => {
  const apps = await prisma.oAuthApp.findMany({
    where: { ownerId: req.user!.id, isActive: true },
    select: { clientId: true, name: true, redirectUris: true, scopes: true, createdAt: true },
  });
  res.json({ apps });
});

authOAuth2Router.delete('/apps/:clientId', requireAuth, async (req: Request, res: Response) => {
  const app = await prisma.oAuthApp.findFirst({
    where: { clientId: req.params.clientId, ownerId: req.user!.id },
  });
  if (!app) return res.status(404).json({ error: 'App not found' });
  await prisma.oAuthApp.update({ where: { id: app.id }, data: { isActive: false } });
  res.json({ success: true });
});

// Authorization endpoint
authOAuth2Router.get('/authorize', requireAuth, async (req: Request, res: Response) => {
  const { client_id, redirect_uri, response_type, scope = '', state } = req.query as Record<string, string>;
  if (response_type !== 'code') return res.status(400).json({ error: 'unsupported_response_type' });

  const app = await prisma.oAuthApp.findFirst({ where: { clientId: client_id, isActive: true } });
  if (!app) return res.status(400).json({ error: 'invalid_client' });

  const uris = app.redirectUris as string[];
  if (!uris.includes(redirect_uri)) return res.status(400).json({ error: 'invalid_redirect_uri' });

  const code = randomBytes(24).toString('hex');
  await prisma.oAuthCode.create({
    data: {
      code,
      clientId: client_id,
      userId: req.user!.id,
      redirectUri: redirect_uri,
      scopes: scope.split(' ').filter(Boolean),
      expiresAt: new Date(Date.now() + 600_000), // 10 min
    },
  });

  const redirect = `${redirect_uri}?code=${code}${state ? `&state=${state}` : ''}`;
  res.redirect(redirect);
});

// Token exchange
authOAuth2Router.post('/token', async (req: Request, res: Response) => {
  const { grant_type, code, client_id, client_secret, redirect_uri } = req.body ?? {};
  if (grant_type !== 'authorization_code') return res.status(400).json({ error: 'unsupported_grant_type' });

  const app = await prisma.oAuthApp.findFirst({
    where: { clientId: client_id, isActive: true },
  });
  if (!app) return res.status(401).json({ error: 'invalid_client' });

  const secretHash = createHash('sha256').update(client_secret ?? '').digest('hex');
  if (secretHash !== app.clientSecret) return res.status(401).json({ error: 'invalid_client' });

  const authCode = await prisma.oAuthCode.findFirst({
    where: { code, clientId: client_id, used: false },
  });
  if (!authCode || authCode.expiresAt < new Date() || authCode.redirectUri !== redirect_uri) {
    return res.status(400).json({ error: 'invalid_grant' });
  }

  await prisma.oAuthCode.update({ where: { id: authCode.id }, data: { used: true } });

  const user = await prisma.walletUser.findUnique({ where: { id: authCode.userId } });
  if (!user) return res.status(400).json({ error: 'user_not_found' });

  const sessionId = generateSessionId();
  const tokens = await issueTokens({
    sub: user.address,
    userId: user.id,
    role: user.role,
    tier: user.tier,
    sessionId,
    appId: client_id,
  });

  await prisma.authSession.create({
    data: {
      id: sessionId,
      userId: user.id,
      tokenHash: tokens.tokenHash,
      refreshTokenHash: tokens.refreshTokenHash,
      appId: client_id,
      expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL * 1000),
    },
  });

  res.json({
    access_token: tokens.token,
    refresh_token: tokens.refreshToken,
    token_type: 'Bearer',
    expires_in: 86400,
    scope: (authCode.scopes as string[]).join(' '),
  });
});

// UserInfo endpoint (OIDC)
authOAuth2Router.get('/userinfo', requireAuth, async (req: Request, res: Response) => {
  const user = await prisma.walletUser.findUnique({ where: { id: req.user!.id } });
  if (!user) return res.status(404).json({ error: 'not_found' });
  res.json({
    sub: user.address,
    name: user.displayName,
    email: user.email,
    picture: user.avatarUrl,
    stellar_address: user.address,
    role: user.role,
    tier: user.tier,
  });
});
