import { Router, Request, Response } from 'express';
import { z } from 'zod';
import crypto from 'crypto';
import { Prisma } from '@prisma/client';
import { prismaWrite, prismaRead } from '../../db';
import { asyncHandler } from '../../middleware/asyncHandler';
import { invalidateKeyCache } from '../../middleware/apiKeyAuth';

export const keysRouter = Router();

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
      },
      select: { id: true, name: true, keyPrefix: true, status: true, createdAt: true },
    });

    res
      .status(201)
      .json({ ...newKey, key: raw, message: 'Old key expired. Store this new key securely.' });
  }),
);
