/**
 * Key Rotation & Expiry Scheduler (#888)
 *
 * Two independent jobs run on a single setInterval tick:
 *
 * 1. JWT Signing Key Rotation (existing)
 *    Calls rotateKeys() every ROTATION_INTERVAL_MS (30 days) so the RSA
 *    signing key pair doesn't sit static indefinitely.
 *
 * 2. DevApiKey Expiry Enforcement (NEW — closes #888)
 *    Runs every EXPIRY_CHECK_INTERVAL_MS (1 hour) and:
 *    - Finds all DevApiKeys where expiresAt <= now AND status = 'active'
 *    - Updates status → 'expired', sets revokedAt = now
 *    - Emits a KeyRotationAudit record for each key so the expiry is
 *      visible in the audit trail (wasSuccessful = true, reason = 'expiry_auto')
 *    - Calls invalidateKeyCache() on the key hash so the in-process cache
 *      stops serving the expired key immediately without waiting for the TTL.
 *
 * WebSocket expiry check: validateApiKey() in websocketServer.ts now delegates
 * to resolveApiKey() which already enforces expiresAt, so WebSocket connections
 * are automatically covered once this scheduler runs.
 */

import { rotateKeys } from './keys';
import { prismaRead, prismaWrite } from '../db';
import { invalidateKeyCache } from '../middleware/apiKeyAuth';
import { logger } from '../logger';
import { scheduler } from '../scheduler/cron-scheduler';

const ROTATION_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const EXPIRY_CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

let rotationTimer: ReturnType<typeof setInterval> | null = null;
let expiryTimer: ReturnType<typeof setInterval> | null = null;

/* ─── JWT signing-key rotation ─────────────────────────────────────────────── */

export function startKeyRotationScheduler(): void {
  if (rotationTimer) return;

  rotationTimer = setInterval(() => {
    rotateKeys()
      .then((kp) => {
        logger.info('Scheduled JWT signing key rotation completed', { kid: kp.kid });
        scheduler.recordHeartbeat(HEARTBEAT_ID, 'success', {
          taskName: 'JWT Signing Key Rotation',
          expectedIntervalMs: ROTATION_INTERVAL_MS,
        });
      })
      .catch((err) => {
        logger.error('Scheduled JWT signing key rotation failed', { error: String(err) });
        scheduler.recordHeartbeat(HEARTBEAT_ID, 'failure', {
          taskName: 'JWT Signing Key Rotation',
          expectedIntervalMs: ROTATION_INTERVAL_MS,
        });
      });
  }, ROTATION_INTERVAL_MS);
}

export function stopKeyRotationScheduler(): void {
  if (rotationTimer) {
    clearInterval(rotationTimer);
    rotationTimer = null;
  }
}

/* ─── DevApiKey expiry enforcement ─────────────────────────────────────────── */

/**
 * Find all active DevApiKeys whose expiresAt is in the past, mark them as
 * expired, and write a KeyRotationAudit record so the lifecycle is auditable.
 */
export async function runExpiredKeyDisable(): Promise<void> {
  const now = new Date();

  // Fetch candidates — only what we need to avoid over-fetching
  const expired = await prismaRead.devApiKey.findMany({
    where: {
      status: 'active',
      expiresAt: { lte: now },
    },
    select: {
      id: true,
      developerId: true,
      keyHash: true,
      name: true,
    },
  });

  if (expired.length === 0) return;

  logger.info('[key-expiry] Auto-disabling expired DevApiKeys', { count: expired.length });

  for (const key of expired) {
    try {
      // Atomically mark as expired + write audit record
      await prismaWrite.$transaction([
        prismaWrite.devApiKey.update({
          where: { id: key.id },
          data: {
            status: 'expired',
            revokedAt: now,
          },
        }),
        prismaWrite.keyRotationAudit.create({
          data: {
            developerId: key.developerId,
            oldKeyId: key.id,
            newKeyId: '', // no replacement issued by the scheduler
            reason: 'expiry_auto',
            wasSuccessful: true,
            metadata: {
              keyName: key.name,
              disabledAt: now.toISOString(),
              triggeredBy: 'scheduler',
            },
          },
        }),
      ]);

      // Evict from in-process cache immediately so the key is rejected on
      // the very next request rather than waiting for the TTL window.
      invalidateKeyCache(key.keyHash);

      logger.info('[key-expiry] Key expired and cache evicted', {
        keyId: key.id,
        developerId: key.developerId,
      });
    } catch (err) {
      logger.error('[key-expiry] Failed to expire key', {
        keyId: key.id,
        error: String(err),
      });
    }
  }
}

export function startExpiryCheckScheduler(): void {
  if (expiryTimer) return;

  // Run once at startup to catch keys that expired while the service was down
  runExpiredKeyDisable().catch((err) => {
    logger.error('[key-expiry] Startup expiry check failed', { error: String(err) });
  });

  expiryTimer = setInterval(() => {
    runExpiredKeyDisable().catch((err) => {
      logger.error('[key-expiry] Scheduled expiry check failed', { error: String(err) });
    });
  }, EXPIRY_CHECK_INTERVAL_MS);
}

export function stopExpiryCheckScheduler(): void {
  if (expiryTimer) {
    clearInterval(expiryTimer);
    expiryTimer = null;
  }
}
