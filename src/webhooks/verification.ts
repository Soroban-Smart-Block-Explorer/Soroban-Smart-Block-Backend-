/**
 * Challenge/response verification helpers for webhook subscriptions (#verification).
 *
 * A subscription proves ownership of its destination URL by completing a
 * handshake:
 *
 *   1. The owner calls `POST /webhooks/:id/verify`.
 *   2. The server sends a signed request to the destination URL containing a
 *      random `challenge`.
 *   3. The destination echoes the challenge back in its 2xx response body,
 *      either as `{"challenge":"<value>"}` (also accepted: `{"token":...}`,
 *      nested under `data`, or as a plain-text body equal to the challenge).
 *   4. The server marks the subscription verified.
 *
 * Only the SHA-256 digest of the challenge is persisted, so a database leak
 * cannot be used to forge a verification response. Comparison is constant-time.
 */

import crypto from 'crypto';

/** How long a challenge stays valid before the owner must request a new one. */
export const VERIFICATION_TOKEN_TTL_MS =
  Number(process.env.WEBHOOK_VERIFICATION_TTL_MS ?? '') || 15 * 60 * 1000; // 15 minutes

/** Envelope `type` used for the outbound verification request. */
export const VERIFICATION_EVENT_TYPE = 'webhook.verification';

/** Generate a high-entropy verification challenge (256 bits, hex-encoded). */
export function generateVerificationToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

/** One-way digest of a challenge, suitable for at-rest storage. */
export function hashVerificationToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export interface VerificationChallengePayload {
  type: typeof VERIFICATION_EVENT_TYPE;
  subscriptionId: string;
  /** The secret value the destination must echo back. */
  challenge: string;
  timestamp: string;
}

/** Build the JSON body sent to the destination during verification. */
export function buildVerificationBody(subscriptionId: string, challenge: string): string {
  const payload: VerificationChallengePayload = {
    type: VERIFICATION_EVENT_TYPE,
    subscriptionId,
    challenge,
    timestamp: new Date().toISOString(),
  };
  return JSON.stringify(payload);
}

/**
 * Pull every candidate challenge value out of an endpoint response.
 * Handles parsed JSON objects, nested `data` envelopes, and raw text bodies
 * (including a JSON document encoded as a string).
 */
export function extractChallenges(body: unknown): string[] {
  if (body == null) return [];

  if (typeof body === 'object') {
    const obj = body as Record<string, unknown>;
    const out: string[] = [];
    for (const key of ['challenge', 'token']) {
      const value = obj[key];
      if (typeof value === 'string') out.push(value);
    }
    if (obj.data && typeof obj.data === 'object') {
      out.push(...extractChallenges(obj.data));
    }
    return out;
  }

  if (typeof body === 'string') {
    const trimmed = body.trim();
    const out = [trimmed];
    try {
      out.push(...extractChallenges(JSON.parse(trimmed)));
    } catch {
      // Plain-text body — the trimmed value is the candidate.
    }
    return out;
  }

  return [];
}

/**
 * Constant-time check that a response body echoes the expected challenge.
 * Comparison is performed on SHA-256 digests so both operands are always the
 * same length.
 */
export function challengeMatches(body: unknown, expectedToken: string): boolean {
  const expectedHash = Buffer.from(hashVerificationToken(expectedToken), 'hex');
  return extractChallenges(body).some((candidate) => {
    const candidateHash = Buffer.from(hashVerificationToken(candidate), 'hex');
    return (
      candidateHash.length === expectedHash.length &&
      crypto.timingSafeEqual(candidateHash, expectedHash)
    );
  });
}
