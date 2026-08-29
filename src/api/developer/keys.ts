import { Router, Request, Response } from 'express';
import { z } from 'zod';
import crypto from 'crypto';
import { Prisma } from '@prisma/client';
import { prismaWrite, prismaRead } from '../../db';
import { asyncHandler } from '../../middleware/asyncHandler';
import { invalidateKeyCache } from '../../middleware/apiKeyAuth';
import { logger } from '../../logger';

export const keysRouter = Router();

/**
 * Rate limiting for key rotation: max 5 rotations per developer per hour
 * Stored by developerId to enforce account-wide limits
 */
const keyRotationAttempts = new Map<string, { attempts: number; resetAt: number }>();

const MAX_ROTATIONS_PER_HOUR = 5;
const ROTATION_WINDOW_MS = 60 * 60 * 1000; // 1 hour

function checkKeyRotationRateLimit(developerId: string): {
  allowed: boolean;
  retryAfterSeconds?: number;
} {
  const now = Date.now();
  const record = keyRotationAttempts.get(developerId);

  if (!record || record.resetAt < now) {
    // First attempt in this window
    keyRotationAttempts.set(developerId, {
      attempts: 1,
      resetAt: now + ROTATION_WINDOW_MS,
    });
    return { allowed: true };
  }

  if (record.attempts >= MAX_ROTATIONS_PER_HOUR) {
    const retryAfterSeconds = Math.ceil((record.resetAt - now) / 1000);
    return { allowed: false, retryAfterSeconds };
  }

  record.attempts++;
  return { allowed: true };
}

const createKeySchema = z.object({
  developerId: z.string(),
  name: z.string().min(1),
  permissions: z.record(z.unknown()).optional(),
  allowedIps: z.array(z.string()).optional(),
  allowedDomains: z.array(z.string()).optional(),
  expiresAt: z.string().datetime().optional(),
});

const updateKeySchema = z.object({
  name: z.string().min(1).optional(),
  permissions: z.record(z.unknown()).optional(),
  allowedIps: z.array(z.string()).optional(),
  allowedDomains: z.array(z.string()).optional(),
});

const rotateKeySchema = z.object({
  currentKey: z.string().min(1).describe('The current API key to revoke'),
  reason: z
    .enum(['manual', 'compromised', 'rotation_policy', 'security_review'])
    .optional()
    .describe('Reason for rotation'),
});

function generateApiKey(): { raw: string; prefix: string; hash: string } {
  const raw = 'sk_' + crypto.randomBytes(24).toString('hex');
  const prefix = raw.slice(0, 8);
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  return { raw, prefix, hash };
}

/** Evict a key record from the auth cache using the stored hash. */
function evictFromCache(keyHash: string): void {
  invalidateKeyCache(keyHash);
}

// POST /developer/keys
keysRouter.post(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = createKeySchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const { developerId, name, permissions, allowedIps, allowedDomains, expiresAt } = parsed.data;

    const developer = await prismaRead.developer.findUnique({ where: { id: developerId } });
    if (!developer) return res.status(404).json({ error: 'Developer not found' });

    const { raw, prefix, hash } = generateApiKey();

    const key = await prismaWrite.devApiKey.create({
      data: {
        developerId,
        name,
        keyPrefix: prefix,
        keyHash: hash,
        permissions: (permissions ?? {}) as Prisma.InputJsonValue,
        allowedIps: allowedIps ? (allowedIps as unknown as Prisma.InputJsonValue) : Prisma.JsonNull,
        allowedDomains: allowedDomains
          ? (allowedDomains as unknown as Prisma.InputJsonValue)
          : Prisma.JsonNull,
        expiresAt: expiresAt ? new Date(expiresAt) : null,
      },
      select: {
        id: true,
        name: true,
        keyPrefix: true,
        status: true,
        permissions: true,
        expiresAt: true,
        createdAt: true,
      },
    });

    // Return the raw key only on creation — never stored in plain text
    res
      .status(201)
      .json({ ...key, key: raw, message: 'Store this key securely — it will not be shown again.' });
  }),
);

// GET /developer/keys
keysRouter.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const { developerId } = z.object({ developerId: z.string() }).parse(req.query);

    const keys = await prismaRead.devApiKey.findMany({
      where: { developerId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        keyPrefix: true,
        status: true,
        permissions: true,
        expiresAt: true,
        lastUsedAt: true,
        createdAt: true,
      },
    });

    res.json({ data: keys });
  }),
);

// GET /developer/keys/:id
keysRouter.get(
  '/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const { developerId } = z.object({ developerId: z.string() }).parse(req.query);

    const key = await prismaRead.devApiKey.findFirst({
      where: { id: req.params.id, developerId },
      select: {
        id: true,
        name: true,
        keyPrefix: true,
        status: true,
        permissions: true,
        allowedIps: true,
        allowedDomains: true,
        expiresAt: true,
        lastUsedAt: true,
        createdAt: true,
      },
    });

    if (!key) return res.status(404).json({ error: 'API key not found' });
    res.json(key);
  }),
);

// PATCH /developer/keys/:id
keysRouter.patch(
  '/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const { developerId } = z.object({ developerId: z.string() }).parse(req.query);
    const parsed = updateKeySchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const existing = await prismaRead.devApiKey.findFirst({
      where: { id: req.params.id, developerId },
      select: { id: true, keyHash: true },
    });
    if (!existing) return res.status(404).json({ error: 'API key not found' });

    const { name, permissions, allowedIps, allowedDomains } = parsed.data;
    const updateData: Prisma.DevApiKeyUpdateInput = {
      ...(name !== undefined && { name }),
      ...(permissions !== undefined && { permissions: permissions as Prisma.InputJsonValue }),
      ...(allowedIps !== undefined && {
        allowedIps: allowedIps as unknown as Prisma.InputJsonValue,
      }),
      ...(allowedDomains !== undefined && {
        allowedDomains: allowedDomains as unknown as Prisma.InputJsonValue,
      }),
    };

    const key = await prismaWrite.devApiKey.update({
      where: { id: req.params.id },
      data: updateData,
      select: {
        id: true,
        name: true,
        keyPrefix: true,
        status: true,
        permissions: true,
        updatedAt: true,
      },
    });

    // Invalidate cache so updated permissions/IPs take effect immediately
    evictFromCache(existing.keyHash);

    res.json(key);
  }),
);

// DELETE /developer/keys/:id — revoke
keysRouter.delete(
  '/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const { developerId } = z.object({ developerId: z.string() }).parse(req.query);

    const existing = await prismaRead.devApiKey.findFirst({
      where: { id: req.params.id, developerId },
      select: { id: true, keyHash: true },
    });
    if (!existing) return res.status(404).json({ error: 'API key not found' });

    await prismaWrite.devApiKey.update({
      where: { id: req.params.id },
      data: { status: 'revoked' },
    });

    // Invalidate cache immediately so the revoked key is rejected on the
    // very next request rather than staying valid for up to KEY_CACHE_TTL ms.
    evictFromCache(existing.keyHash);

    res.status(204).end();
  }),
);

// POST /developer/keys/:id/rotate
keysRouter.post(
  '/:id/rotate',
  asyncHandler(async (req: Request, res: Response) => {
    const { developerId } = z.object({ developerId: z.string() }).parse(req.query);

    const existing = await prismaRead.devApiKey.findFirst({
      where: { id: req.params.id, developerId },
      select: {
        id: true,
        name: true,
        keyHash: true,
        permissions: true,
        allowedIps: true,
        allowedDomains: true,
        developerId: true,
      },
    });
    if (!existing) return res.status(404).json({ error: 'API key not found' });

    await prismaWrite.devApiKey.update({
      where: { id: req.params.id },
      data: { status: 'expired', expiresAt: new Date() },
    });

    // Evict the old key from cache before creating the replacement
    evictFromCache(existing.keyHash);

    const { raw, prefix, hash } = generateApiKey();

    const newKey = await prismaWrite.devApiKey.create({
      data: {
        developerId: existing.developerId,
        name: existing.name + ' (rotated)',
        keyPrefix: prefix,
        keyHash: hash,
        permissions: (existing.permissions ?? {}) as Prisma.InputJsonValue,
        allowedIps:
          existing.allowedIps !== null
            ? (existing.allowedIps as unknown as Prisma.InputJsonValue)
            : Prisma.JsonNull,
        allowedDomains:
          existing.allowedDomains !== null
            ? (existing.allowedDomains as unknown as Prisma.InputJsonValue)
            : Prisma.JsonNull,
        // Chain the audit trail: new key records which key it replaced (#888)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        rotatedFromKeyId: existing.id,
      } as any,
      select: { id: true, name: true, keyPrefix: true, status: true, createdAt: true },
    });

    res
      .status(201)
      .json({ ...newKey, key: raw, message: 'Old key expired. Store this new key securely.' });
  }),
);

/**
 * POST /developer/keys/rotate/self
 *
 * Self-service key rotation endpoint for developers.
 * Validates the current key, revokes it, and issues a new key with all settings preserved.
 * Logs the rotation event for audit purposes.
 *
 * Request body:
 *   - currentKey (required): The API key to rotate out
 *   - reason (optional): "manual" | "compromised" | "rotation_policy" | "security_review"
 *
 * Returns: { id, name, keyPrefix, key (raw), message }
 */
keysRouter.post(
  '/rotate/self',
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = rotateKeySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
    }

    const { currentKey, reason = 'manual' } = parsed.data;
    const clientIp = req.ip ?? '';
    const userAgent = req.headers['user-agent'] ?? undefined;

    // Hash the provided key to look it up
    const currentKeyHash = crypto.createHash('sha256').update(currentKey).digest('hex');

    // Find the key in the database
    const existingKey = await prismaRead.devApiKey.findFirst({
      where: { keyHash: currentKeyHash, status: 'active' },
      select: {
        id: true,
        name: true,
        developerId: true,
        keyHash: true,
        permissions: true,
        allowedIps: true,
        allowedDomains: true,
        allowedEndpoints: true,
      },
    });

    if (!existingKey) {
      logger.warn('[keys] Rotation attempt with invalid or revoked key', { ip: clientIp, reason });
      return res.status(401).json({ error: 'Invalid or revoked API key' });
    }

    // Check rate limit for this developer
    const rateLimitCheck = checkKeyRotationRateLimit(existingKey.developerId);
    if (!rateLimitCheck.allowed) {
      logger.warn('[keys] Key rotation rate limit exceeded', {
        developerId: existingKey.developerId,
        ip: clientIp,
      });
      res.setHeader('Retry-After', rateLimitCheck.retryAfterSeconds!);
      return res.status(429).json({
        error: 'Rate limit exceeded',
        message: `Too many rotation attempts. Try again in ${rateLimitCheck.retryAfterSeconds} seconds.`,
        retryAfterSeconds: rateLimitCheck.retryAfterSeconds,
      });
    }

    let rotationSuccess = false;
    let rotationError: string | undefined;

    try {
      // Start a transaction to atomically revoke old key and create new one
      const transaction = await prismaWrite.$transaction(async (tx) => {
        // Revoke the old key
        await tx.devApiKey.update({
          where: { id: existingKey.id },
          data: { status: 'revoked', revokedAt: new Date() },
        });

        // Create the new key with same settings
        const { raw, prefix, hash } = generateApiKey();

        const newKey = await tx.devApiKey.create({
          data: {
            developerId: existingKey.developerId,
            name: existingKey.name,
            keyPrefix: prefix,
            keyHash: hash,
            permissions: (existingKey.permissions ?? {}) as Prisma.InputJsonValue,
            allowedIps:
              existingKey.allowedIps !== null
                ? (existingKey.allowedIps as unknown as Prisma.InputJsonValue)
                : Prisma.JsonNull,
            allowedDomains:
              existingKey.allowedDomains !== null
                ? (existingKey.allowedDomains as unknown as Prisma.InputJsonValue)
                : Prisma.JsonNull,
            allowedEndpoints:
              existingKey.allowedEndpoints !== null
                ? (existingKey.allowedEndpoints as unknown as Prisma.InputJsonValue)
                : Prisma.JsonNull,
            // Chain the audit trail: new key records which key it replaced (#888)
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            rotatedFromKeyId: existingKey.id,
          } as any,
          select: { id: true, name: true, keyPrefix: true, status: true, createdAt: true },
        });

        // Create audit log entry
        await tx.keyRotationAudit.create({
          data: {
            developerId: existingKey.developerId,
            oldKeyId: existingKey.id,
            newKeyId: newKey.id,
            reason,
            ipAddress: clientIp,
            userAgent: userAgent,
            wasSuccessful: true,
            metadata: {
              oldKeyPrefix: existingKey.name,
              rotationType: 'self_service',
              timestamp: new Date().toISOString(),
            } as Prisma.InputJsonValue,
          },
        });

        return { newKey, rawKey: raw };
      });

      rotationSuccess = true;

      // Invalidate cache so the revoked key is rejected immediately
      invalidateKeyCache(currentKeyHash);

      logger.info('[keys] Self-service key rotation successful', {
        developerId: existingKey.developerId,
        oldKeyId: existingKey.id,
        newKeyId: transaction.newKey.id,
        reason,
        ip: clientIp,
      });

      return res.status(201).json({
        ...transaction.newKey,
        key: transaction.rawKey,
        message: 'Key rotated successfully. Old key has been revoked. Store this new key securely.',
      });
    } catch (err) {
      rotationError = String(err);
      logger.error('[keys] Key rotation failed', {
        developerId: existingKey.developerId,
        keyId: existingKey.id,
        error: rotationError,
      });

      // Log failed rotation attempt
      try {
        await prismaWrite.keyRotationAudit.create({
          data: {
            developerId: existingKey.developerId,
            oldKeyId: existingKey.id,
            newKeyId: '', // No new key was created
            reason,
            ipAddress: clientIp,
            userAgent: userAgent,
            wasSuccessful: false,
            errorMessage: rotationError,
            metadata: {
              rotationType: 'self_service',
              timestamp: new Date().toISOString(),
            } as Prisma.InputJsonValue,
          },
        });
      } catch (auditErr) {
        logger.warn('[keys] Failed to log rotation failure', { error: String(auditErr) });
      }

      return res.status(500).json({
        error: 'Key rotation failed',
        message: 'An unexpected error occurred during key rotation. Please try again later.',
      });
    }
  }),
);
