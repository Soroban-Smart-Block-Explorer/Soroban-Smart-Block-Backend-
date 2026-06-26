import jwt, { SignOptions } from 'jsonwebtoken';
import { createHash, randomBytes } from 'crypto';
import { getOrCreateKeyPair } from './keys';

export interface TokenPayload {
  sub: string;       // wallet address
  userId: string;
  role: string;
  tier: string;
  sessionId: string;
  appId: string;
  jti: string;
}

export interface TokenPair {
  token: string;
  refreshToken: string;
  refreshTokenHash: string;
  tokenHash: string;
  sessionId: string;
  expiresAt: Date;
}

export const ACCESS_TOKEN_TTL = 24 * 3600;    // 24h
export const REFRESH_TOKEN_TTL = 30 * 24 * 3600; // 30d

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 64);
}

export async function issueTokens(payload: Omit<TokenPayload, 'jti'>): Promise<TokenPair> {
  const { kid, privateKeyPem } = await getOrCreateKeyPair();
  const jti = randomBytes(16).toString('hex');
  const sessionId = payload.sessionId || `sess_${randomBytes(12).toString('hex')}`;

  const claims: TokenPayload = { ...payload, jti, sessionId };
  const opts: SignOptions = {
    algorithm: 'RS256',
    expiresIn: ACCESS_TOKEN_TTL,
    header: { alg: 'RS256', kid } as Parameters<typeof jwt.sign>[2] extends SignOptions ? never : never,
  };

  const token = jwt.sign(claims, privateKeyPem, {
    algorithm: 'RS256',
    expiresIn: ACCESS_TOKEN_TTL,
    keyid: kid,
  });

  const refreshToken = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + ACCESS_TOKEN_TTL * 1000);

  return {
    token,
    refreshToken,
    refreshTokenHash: hashToken(refreshToken),
    tokenHash: hashToken(token),
    sessionId,
    expiresAt,
  };
}

export async function verifyToken(token: string): Promise<TokenPayload | null> {
  try {
    const { publicKeyPem } = await getOrCreateKeyPair();
    return jwt.verify(token, publicKeyPem, { algorithms: ['RS256'] }) as TokenPayload;
  } catch {
    return null;
  }
}

export function generateSessionId(): string {
  return `sess_${randomBytes(12).toString('hex')}`;
}
