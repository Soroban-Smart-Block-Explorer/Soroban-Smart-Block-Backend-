import { Router, Request, Response } from 'express';
import { prismaWrite as prisma } from '../db';
import { requireAuth } from '../auth/middleware';
import { cacheGet, cacheSet } from '../cache';

export const authProfileRouter = Router();

async function tryIpfsPublish(data: object): Promise<string | null> {
  try {
    const { create } = await import('kubo-rpc-client');
    const ipfs = create({ url: process.env.IPFS_API_URL ?? 'http://localhost:5001' });
    const result = await ipfs.add(JSON.stringify(data));
    return result.cid.toString();
  } catch {
    return null;
  }
}

async function tryIpfsFetch(cid: string): Promise<object | null> {
  try {
    const { create } = await import('kubo-rpc-client');
    const ipfs = create({ url: process.env.IPFS_API_URL ?? 'http://localhost:5001' });
    const chunks: Uint8Array[] = [];
    for await (const chunk of ipfs.cat(cid)) {
      chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks).toString();
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// GET own profile
authProfileRouter.get(
  '/me/profile',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const user = await prisma.walletUser.findUnique({ where: { id: req.user!.id } });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const meta = user.metadata as Record<string, unknown>;
    let ipfsProfile: object | null = null;
    if (meta.profileCid) {
      const cached = await cacheGet<object>(`profile:ipfs:${meta.profileCid}`);
      ipfsProfile = cached ?? (await tryIpfsFetch(meta.profileCid as string));
      if (ipfsProfile) await cacheSet(`profile:ipfs:${meta.profileCid}`, ipfsProfile, 3600);
    }

    res.json({
      address: user.address,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
      email: user.email,
      profileCid: meta.profileCid ?? null,
      profile: ipfsProfile ?? meta.profile ?? {},
      credentials: meta.credentials ?? [],
    });
  }),
);

// PUT own profile - publishes to IPFS
authProfileRouter.put(
  '/me/profile',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const { bio, website, social, pgpKey, displayName, avatarUrl } = req.body ?? {};

    const user = await prisma.walletUser.findUnique({ where: { id: req.user!.id } });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const profileData = {
      address: user.address,
      bio,
      website,
      social,
      pgpKey,
      updatedAt: new Date().toISOString(),
    };

    const cid = await tryIpfsPublish(profileData);
    const meta = (user.metadata as Record<string, unknown>) ?? {};
    meta.profile = profileData;
    if (cid) {
      meta.profileCid = cid;
      await cacheSet(`profile:ipfs:${cid}`, profileData, 3600);
    }

    const updates: { metadata: object; displayName?: string; avatarUrl?: string } = {
      metadata: meta as object,
    };
    if (displayName !== undefined) updates.displayName = displayName;
    if (avatarUrl !== undefined) updates.avatarUrl = avatarUrl;

    await prisma.walletUser.update({ where: { id: user.id }, data: updates });
    res.json({ success: true, profileCid: cid, profile: profileData });
  }),
);

// POST submit verifiable credential
authProfileRouter.post(
  '/me/profile/verify',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const { credential } = req.body ?? {};
    if (!credential) return res.status(400).json({ error: 'credential required' });

    const user = await prisma.walletUser.findUnique({ where: { id: req.user!.id } });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const meta = (user.metadata as Record<string, unknown>) ?? {};
    const creds = (meta.credentials as unknown[]) ?? [];
    creds.push({ ...credential, submittedAt: new Date().toISOString() });
    meta.credentials = creds;

    await prisma.walletUser.update({ where: { id: user.id }, data: { metadata: meta as object } });
    res.json({ success: true, credentialCount: creds.length });
  }),
);

// GET any address's public profile
authProfileRouter.get(
  '/:address/profile',
  asyncHandler(async (req: Request, res: Response) => {
    const user = await prisma.walletUser.findUnique({ where: { address: req.params.address } });
    if (!user) return res.status(404).json({ error: 'Profile not found' });

    const meta = user.metadata as Record<string, unknown>;
    res.json({
      address: user.address,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
      profileCid: meta.profileCid ?? null,
      profile: meta.profile ?? {},
      credentials: meta.credentials ?? [],
      tier: user.tier,
    });
  }),
);

// POST export profile as VC JSON
authProfileRouter.post(
  '/me/profile/export',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const user = await prisma.walletUser.findUnique({ where: { id: req.user!.id } });
    if (!user) return res.status(404).json({ error: 'User not found' });
    const meta = user.metadata as Record<string, unknown>;

    const vc = {
      '@context': ['https://www.w3.org/2018/credentials/v1'],
      type: ['VerifiableCredential', 'StellarIdentityCredential'],
      issuer: 'did:stellar:explorer',
      issuanceDate: new Date().toISOString(),
      credentialSubject: {
        id: `did:stellar:${user.address}`,
        address: user.address,
        displayName: user.displayName,
        tier: user.tier,
        role: user.role,
        profile: meta.profile ?? {},
        credentials: meta.credentials ?? [],
      },
    };
    res.json(vc);
  }),
);
