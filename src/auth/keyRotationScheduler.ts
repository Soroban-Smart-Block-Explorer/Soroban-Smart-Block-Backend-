/**
 * JWT Signing Key Rotation Scheduler
 *
 * Automatically calls rotateKeys() (src/auth/keys.ts) every ROTATION_INTERVAL_MS
 * so the RSA signing key pair doesn't sit static indefinitely. A manual,
 * admin-only trigger is also available at POST /auth/keys/rotate.
 *
 * What a rotation invalidates:
 *   - JWKS cache (`auth:jwks:keys`) is overwritten with the new key pair, so
 *     GET /.well-known/jwks.json immediately stops advertising the old public key.
 *   - Every previously-issued access token is signed with the old `kid`. Since
 *     verifyToken() only checks the *current* key pair (src/auth/tokens.ts), those
 *     tokens fail verification as soon as rotation completes — effectively logging
 *     out every active session until each client re-authenticates or refreshes.
 *   - Refresh tokens are unaffected: they're opaque, DB-backed (authSession.tokenHash),
 *     not JWTs, so rotation does not invalidate them.
 *
 * Because rotation is disruptive to live access tokens, this runs on a long
 * (30-day) cadence rather than anything shorter.
 */

import { rotateKeys } from './keys';
import { logger } from '../logger';

const ROTATION_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

let rotationTimer: ReturnType<typeof setInterval> | null = null;

export function startKeyRotationScheduler(): void {
  if (rotationTimer) return;

  rotationTimer = setInterval(() => {
    rotateKeys()
      .then((kp) => {
        logger.info('Scheduled JWT signing key rotation completed', { kid: kp.kid });
      })
      .catch((err) => {
        logger.error('Scheduled JWT signing key rotation failed', { error: String(err) });
      });
  }, ROTATION_INTERVAL_MS);
}

export function stopKeyRotationScheduler(): void {
  if (rotationTimer) {
    clearInterval(rotationTimer);
    rotationTimer = null;
  }
}
