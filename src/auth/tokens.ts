import jwt, { SignOptions } from 'jsonwebtoken';
import { createHash, randomBytes } from 'crypto';
import { getOrCreateKeyPair, getKeyPairForKid, getGraceKeyPairs } from './keys';
import { config } from '../config';

export interface TokenPayload {
  sub: string; // wallet address
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

export const ACCESS_TOKEN_TTL = 24 * 3600; // 24h
export const REFRESH_TOKEN_TTL = 30 * 24 * 3600; // 30d

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 64);
}

export async function issueTokens(payload: Omit<TokenPayload, 'jti'>): Promise<TokenPair> {
  const { kid, privateKeyPem } = await getOrCreateKeyPair();
  const jti = randomBytes(16).toString('hex');
  const sessionId = payload.sessionId?.trim() || generateSessionId();

  const claims: TokenPayload = { ...payload, jti, sessionId };

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
    const decodedHeader = jwt.decode(token, { complete: true }) as { header: { kid?: string; alg?: string } } | null;
    const kid = decodedHeader?.header?.kid;
    const alg = decodedHeader?.header?.alg;

    // Check HMAC algorithms if JWT_SECRET or JWT_PREVIOUS_SECRETS were used
    if (alg && alg.startsWith('HS')) {
      const secrets: string[] = [];
      if (config.jwtSecret) secrets.push(config.jwtSecret);
      if (config.jwtPreviousSecrets) {
        secrets.push(...config.jwtPreviousSecrets.split(',').map((s) => s.trim()).filter(Boolean));
      }
      for (const secret of secrets) {
        try {
          return jwt.verify(token, secret) as TokenPayload;
        } catch {
          // continue checking next secret in key ring
        }
      }
      return null;
    }

    // RS256 key ring lookup by kid
    if (kid) {
      const kp = await getKeyPairForKid(kid);
      if (kp) {
        try {
          return jwt.verify(token, kp.publicKeyPem, { algorithms: ['RS256'] }) as TokenPayload;
        } catch {
          // Fallback to testing remaining keys
        }
      }
    }

    // Try current key pair
    const currentKp = await getOrCreateKeyPair();
    try {
      return jwt.verify(token, currentKp.publicKeyPem, { algorithms: ['RS256'] }) as TokenPayload;
    } catch {
      // Fallback to grace key pairs
    }

    // Try grace key pairs
    for (const graceKp of getGraceKeyPairs()) {
      try {
        return jwt.verify(token, graceKp.publicKeyPem, { algorithms: ['RS256'] }) as TokenPayload;
      } catch {
        // Continue checking grace keys
      }
    }

    return null;
  } catch {
    return null;
  }
}

export function generateSessionId(): string {
  return `sess_${randomBytes(12).toString('hex')}`;
}
