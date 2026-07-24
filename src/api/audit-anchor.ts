/**
 * On-Chain Certificate Anchoring API
 *
 * POST /api/v1/contracts/:address/audit/:version/anchor
 *   Anchor a specific certificate version on Stellar.
 *   Returns tx hash, ledger, fee charged, and Merkle root.
 *
 * GET  /api/v1/contracts/:address/audit/:version/anchor
 *   Status: is this version anchored? tx hash, ledger, on-chain verification.
 *
 * GET  /api/v1/contracts/:address/audit/:version/anchor/proof
 *   Merkle proof for this certificate within the full contract cert tree.
 *
 * GET  /api/v1/contracts/:address/audit/:version/anchor/estimate
 *   Gas / fee estimate before anchoring (no funds consumed).
 *
 * POST /api/v1/audit/anchor/merkle — batch: anchor Merkle root for all certs
 * GET  /api/v1/audit/anchor/merkle — current Merkle tree info
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prismaRead } from '../db';
import { cacheGet, cacheSet } from '../cache';
import { validateAddressParam } from '../middleware/sanitize';
import {
  anchorCertificate,
  anchorMerkleRoot,
  estimateAnchorFee,
  buildMerkleTree,
  getMerkleProof,
  verifyMerkleProof,
  verifyOnChainAnchor,
} from '../lib/anchor-service';
import { logger } from '../logger';

export const contractAnchorRouter = Router({ mergeParams: true });
export const platformAnchorRouter = Router();

// ── Shared helper ──────────────────────────────────────────────────────────────

async function resolveCert(address: string, versionParam: string) {
  const version = parseInt(versionParam, 10);
  if (isNaN(version) || version < 1) return null;

  return prismaRead.auditCertificate.findFirst({
    where: { contractAddress: address, version },
    select: {
      id: true,
      version: true,
      status: true,
      certificateHash: true,
      anchorTxHash: true,
      overallScore: true,
      generatedAt: true,
      expiresAt: true,
      contractAddress: true,
    },
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Contract-scoped routes   /contracts/:address/audit/:version/anchor/*
// ═══════════════════════════════════════════════════════════════════════════

// ── GET /estimate — fee estimate before anchoring ─────────────────────────────

contractAnchorRouter.get(
  '/estimate',
  validateAddressParam('address'),
  async (req: Request, res: Response) => {
    try {
      const cert = await resolveCert(req.params.address, req.params.version);
      if (!cert) {
        return res.status(404).json({ error: 'Certificate version not found.' });
      }

      const estimate = await estimateAnchorFee(cert.certificateHash);

      res.json({
        contractAddress: req.params.address,
        version: cert.version,
        certificateHash: cert.certificateHash,
        alreadyAnchored: !!cert.anchorTxHash,
        feeEstimate: estimate,
        anchorMechanism: {
          primary: 'MEMO_HASH — SHA-256 of certificate payload embedded in tx memo',
          secondary: 'ManageData — key/value record on anchor account for searchability',
          noContract: true,
          sorobanCost: 0,
          note: 'Classic Stellar transaction. No smart contract execution fee.',
        },
      });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  },
);

// ── POST / — anchor a certificate on-chain ────────────────────────────────────

const anchorSchema = z.object({
  force: z.boolean().default(false),
});

contractAnchorRouter.post(
  '/',
  validateAddressParam('address'),
  async (req: Request, res: Response) => {
    try {
      const { address } = req.params;
      const { force } = anchorSchema.parse(req.body);

      const cert = await resolveCert(address, req.params.version);
      if (!cert) {
        return res.status(404).json({ error: 'Certificate version not found.' });
      }

      if (cert.status !== 'published') {
        return res.status(409).json({
          error: `Cannot anchor a ${cert.status} certificate. Only published certificates can be anchored.`,
        });
      }

      if (cert.anchorTxHash && !force) {
        return res.status(409).json({
          error: 'Certificate is already anchored.',
          anchorTxHash: cert.anchorTxHash,
          hint: 'Pass force=true to re-anchor.',
        });
      }

      // Estimate fee first for response metadata
      const estimate = await estimateAnchorFee(cert.certificateHash);

      // Build Merkle tree for this contract to include root in the anchor
      const allCerts = await prismaRead.auditCertificate.findMany({
        where: { contractAddress: address, status: 'published' },
        orderBy: [{ contractAddress: 'asc' }, { version: 'asc' }],
        select: { certificateHash: true },
      });
      const tree = buildMerkleTree(allCerts.map((c) => c.certificateHash));
      const merkleRoot = tree.root;

      logger.info('Anchoring certificate on-chain', {
        certId: cert.id,
        version: cert.version,
        address,
      });

      const result = await anchorCertificate(cert.id, cert.certificateHash, merkleRoot);

      res.status(result.simulated ? 200 : 201).json({
        contractAddress: address,
        version: cert.version,
        certificateId: cert.id,
        certificateHash: cert.certificateHash,
        txHash: result.txHash,
        ledgerSequence: result.ledgerSequence,
        feeCharged: result.feeCharged,
        merkleRoot,
        leafCount: allCerts.length,
        simulated: result.simulated,
        anchored: result.anchored,
        feeEstimate: estimate,
        verifyUrl: `/api/v1/contracts/${address}/audit/${cert.version}/anchor`,
        proofUrl: `/api/v1/contracts/${address}/audit/${cert.version}/anchor/proof`,
        note: result.simulated
          ? 'Anchoring is in simulation mode. Set ANCHOR_ENABLED=true and ANCHOR_SECRET_KEY to submit real transactions.'
          : 'Certificate hash successfully anchored on Stellar mainnet/testnet.',
      });
    } catch (e) {
      if (e instanceof z.ZodError) return res.status(400).json({ error: e.errors });
      logger.error('Anchor endpoint error', { error: String(e) });
      res.status(500).json({ error: String(e) });
    }
  },
);

// ── GET / — anchor status ──────────────────────────────────────────────────────

contractAnchorRouter.get(
  '/',
  validateAddressParam('address'),
  async (req: Request, res: Response) => {
    try {
      const { address } = req.params;
      const cert = await resolveCert(address, req.params.version);
      if (!cert) {
        return res.status(404).json({ error: 'Certificate version not found.' });
      }

      const isAnchored = !!cert.anchorTxHash;

      if (!isAnchored) {
        return res.json({
          contractAddress: address,
          version: cert.version,
          certificateHash: cert.certificateHash,
          anchored: false,
          anchorTxHash: null,
          hint: `POST /api/v1/contracts/${address}/audit/${cert.version}/anchor to anchor.`,
          estimateUrl: `/api/v1/contracts/${address}/audit/${cert.version}/anchor/estimate`,
        });
      }

      // Verify the on-chain anchor
      const verification = await verifyOnChainAnchor(cert.id, cert.certificateHash);

      res.json({
        contractAddress: address,
        version: cert.version,
        certificateHash: cert.certificateHash,
        anchored: true,
        anchorTxHash: cert.anchorTxHash,
        onChainVerification: verification,
        proofUrl: `/api/v1/contracts/${address}/audit/${cert.version}/anchor/proof`,
      });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  },
);

// ── GET /proof — Merkle proof for this certificate ────────────────────────────

contractAnchorRouter.get(
  '/proof',
  validateAddressParam('address'),
  async (req: Request, res: Response) => {
    try {
      const { address } = req.params;
      const cacheKey = `anchor:proof:${address}:${req.params.version}`;

      const cached = await cacheGet(cacheKey);
      if (cached) return res.json(cached);

      const cert = await resolveCert(address, req.params.version);
      if (!cert) {
        return res.status(404).json({ error: 'Certificate version not found.' });
      }

      // Build Merkle tree from ALL published certs for this contract
      const allCerts = await prismaRead.auditCertificate.findMany({
        where: { contractAddress: address, status: 'published' },
        orderBy: [{ contractAddress: 'asc' }, { version: 'asc' }],
        select: { id: true, certificateHash: true, version: true },
      });

      const hashes = allCerts.map((c) => c.certificateHash);
      const tree = buildMerkleTree(hashes);
      const leafIdx = hashes.findIndex((h) => h === cert.certificateHash);

      if (leafIdx === -1) {
        return res.status(404).json({
          error: 'Certificate hash not found in the Merkle tree for this contract.',
        });
      }

      const proofData = getMerkleProof(tree, leafIdx);
      proofData.certHash = cert.certificateHash;

      // Self-verify before returning
      const selfValid = verifyMerkleProof(cert.certificateHash, proofData.proof, tree.root);

      const result = {
        contractAddress: address,
        version: cert.version,
        certificateId: cert.id,
        certificateHash: cert.certificateHash,
        merkleRoot: tree.root,
        treeDepth: tree.layers.length - 1,
        totalCertificates: allCerts.length,
        leafIndex: leafIdx,
        leafHash: proofData.leafHash,
        proof: proofData.proof,
        selfVerified: selfValid,
        anchorTxHash: cert.anchorTxHash,
        verifyInstructions: [
          '1. Compute: leafHash = SHA256(certificateHash)',
          '2. For each proof step: if direction="left"  → current = SHA256(sort(sibling, current))',
          '                         if direction="right" → current = SHA256(sort(current, sibling))',
          '   Note: "sort" = canonical lexicographic ordering of the two hex strings.',
          '3. Final current must equal merkleRoot.',
          '4. Cross-check merkleRoot against the anchorTxHash on Stellar (ManageData "audit_merkle_root" key on anchor account).',
        ],
        tree: {
          leaves: tree.leaves,
          layers: tree.layers,
        },
      };

      await cacheSet(cacheKey, result, 600); // 10-min cache — tree only changes when new certs added
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// Platform-level routes   /api/v1/audit/anchor/*
// ═══════════════════════════════════════════════════════════════════════════

// ── POST /merkle — anchor Merkle root for all published certs (or one contract)

const merkleAnchorSchema = z.object({
  contractAddress: z.string().optional(),
  adminKey: z.string().optional(),
});

platformAnchorRouter.post('/merkle', async (req: Request, res: Response) => {
  try {
    const { contractAddress, adminKey } = merkleAnchorSchema.parse(req.body);

    const envKey = process.env.AUDIT_ADMIN_KEY;
    if (envKey && adminKey !== envKey) {
      return res.status(403).json({ error: 'Invalid admin key.' });
    }

    const result = await anchorMerkleRoot(contractAddress);

    res.status(result.simulated ? 200 : 201).json({
      merkleRoot: result.merkleRoot,
      leafCount: result.leafCount,
      txHash: result.txHash,
      simulated: result.simulated,
      contractAddress: contractAddress ?? 'all',
      note: result.simulated
        ? 'Merkle root anchoring in simulation mode.'
        : `Merkle root anchored on-chain. ${result.leafCount} certificate(s) covered.`,
    });
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: e.errors });
    res.status(500).json({ error: String(e) });
  }
});

// ── GET /merkle — current global Merkle tree ──────────────────────────────────

platformAnchorRouter.get('/merkle', async (req: Request, res: Response) => {
  try {
    const contractAddress = req.query.contractAddress as string | undefined;
    const cacheKey = `anchor:merkle:${contractAddress ?? 'all'}`;

    const cached = await cacheGet(cacheKey);
    if (cached) return res.json(cached);

    const where: Record<string, unknown> = { status: 'published' };
    if (contractAddress) where.contractAddress = contractAddress;

    const certs = await prismaRead.auditCertificate.findMany({
      where,
      orderBy: [{ contractAddress: 'asc' }, { version: 'asc' }],
      select: {
        id: true,
        contractAddress: true,
        version: true,
        certificateHash: true,
        anchorTxHash: true,
      },
    });

    const tree = buildMerkleTree(certs.map((c) => c.certificateHash));

    const result = {
      merkleRoot: tree.root,
      treeDepth: tree.layers.length - 1,
      totalLeaves: certs.length,
      anchored: certs.filter((c) => !!c.anchorTxHash).length,
      unanchored: certs.filter((c) => !c.anchorTxHash).length,
      contractFilter: contractAddress ?? null,
      certificates: certs.map((c, i) => ({
        id: c.id,
        contractAddress: c.contractAddress,
        version: c.version,
        certificateHash: c.certificateHash,
        leafIndex: i,
        leafHash: tree.leaves[i],
        anchored: !!c.anchorTxHash,
        anchorTxHash: c.anchorTxHash,
      })),
    };

    await cacheSet(cacheKey, result, 300);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});
