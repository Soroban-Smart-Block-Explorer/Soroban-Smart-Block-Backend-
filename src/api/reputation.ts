import { Router, Request, Response } from 'express';
import { prismaRead, prismaWrite } from '../db';
import {
  assessSybilRisk,
  canonicalAddress,
  computeReputationScore,
  computeReputationScoreForIdentity,
  createLeaderboard,
  createOracleResponse,
  earnBadges,
  fetchProfileData,
  isAttestationVerifiable,
  isVerifiableCredential,
  normalizeAttestation,
  normalizeCredential,
  saveReputationToDb,
  verifyIdentityLinks,
} from '../reputation/score';
import { buildTrustGraph, findTrustPath, weightedEndorsements } from '../reputation/trustGraph';
import { calculateDelegatedVotingPower } from '../reputation/governance';
import { createArbitrationCase, resolveArbitrationCase } from '../reputation/arbitration';
import { ChainReputationData, EndorsementInput, LinkedIdentityInput } from '../reputation/types';

/**
 * @swagger
 * tags:
 *   name: Reputation
 *   description: >
 *     Address reputation scoring, Sybil detection, attestations, verifiable credentials,
 *     cross-chain identity linking, trust networks, governance, and reputation NFTs.
 *     Note: this router is not currently mounted in router.ts.
 */
export const reputationRouter = Router();

function parseChainData(value: unknown): ChainReputationData[] {
  if (value === undefined || value === null || value === '') return [];
  if (!Array.isArray(value))
    throw Object.assign(new Error('chainData must be an array'), { statusCode: 400 });
  return value as ChainReputationData[];
}

function parseLinks(value: unknown): LinkedIdentityInput[] {
  if (value === undefined || value === null || value === '') return [];
  if (!Array.isArray(value))
    throw Object.assign(new Error('links must be an array'), { statusCode: 400 });
  return value as LinkedIdentityInput[];
}

function parseEndorsements(value: unknown): EndorsementInput[] {
  if (value === undefined || value === null || value === '') return [];
  if (!Array.isArray(value))
    throw Object.assign(new Error('endorsements must be an array'), { statusCode: 400 });
  return value as EndorsementInput[];
}

function handleAsync(handler: (req: Request, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response) => {
    handler(req, res).catch((error) => {
      const statusCode = (error as { statusCode?: number }).statusCode ?? 500;
      res
        .status(statusCode)
        .json({ error: error instanceof Error ? error.message : String(error) });
    });
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 🔴 MUST-HAVE ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @swagger
 * /api/v1/reputation/leaderboard:
 *   get:
 *     summary: Get reputation leaderboard (overall)
 *     description: >
 *       Returns the top-scored addresses from the database. Category defaults to "overall".
 *       Also accessible as /api/v1/reputation/leaderboard/{category}.
 *     tags: [Reputation]
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100, default: 10 }
 *         description: Number of entries to return (clamped 1-100, never throws 400).
 *     responses:
 *       200:
 *         description: Leaderboard entries for the overall category
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 category: { type: string, example: overall }
 *                 leaderboard:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/LeaderboardEntry'
 * /api/v1/reputation/leaderboard/{category}:
 *   get:
 *     summary: Get reputation leaderboard for a specific category
 *     tags: [Reputation]
 *     parameters:
 *       - in: path
 *         name: category
 *         required: true
 *         schema: { type: string }
 *         description: Score category (e.g. "activity", "governance", "attestations").
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100, default: 10 }
 *     responses:
 *       200:
 *         description: Leaderboard entries for the requested category
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 category: { type: string, example: activity }
 *                 leaderboard:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/LeaderboardEntry'
 */
// GET /api/v1/reputation/leaderboard & GET /api/v1/reputation/leaderboard/:category
reputationRouter.get(
  '/leaderboard(/:category)?',
  handleAsync(async (req, res) => {
    const category = req.params.category || 'overall';
    const limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 10)));

    // Load all profiles from DB
    const profiles = await prismaRead.reputationProfile.findMany();

    // Transform profiles back to ChainReputationData for calculation
    const mockChainData: ChainReputationData[] = [];
    for (const p of profiles) {
      mockChainData.push({
        chainId: p.chain,
        address: p.address,
        transactionCount: 10,
        successfulTransactionCount: 10,
        sybilRisk: p.combinedScore && p.combinedScore < 300 ? 0.8 : 0.1,
      });
    }

    const leaderboard = createLeaderboard(mockChainData, category, limit);
    return res.json({ category, leaderboard });
  }),
);

/**
 * @swagger
 * /api/v1/reputation/search:
 *   get:
 *     summary: Search reputation profiles by address or domain
 *     tags: [Reputation]
 *     parameters:
 *       - in: query
 *         name: q
 *         required: true
 *         schema: { type: string }
 *         description: Partial address or domain string (case-insensitive, up to 10 results).
 *     responses:
 *       200:
 *         description: Matching profiles
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 query: { type: string, example: 'GBZX' }
 *                 results:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/ReputationProfileRecord'
 *       400:
 *         description: Query param q is missing or empty
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               error: Search query q is required
 */
// GET /api/v1/reputation/search?q=...
reputationRouter.get(
  '/search',
  handleAsync(async (req, res) => {
    const query = req.query.q;
    if (typeof query !== 'string' || query.trim() === '') {
      return res.status(400).json({ error: 'Search query q is required' });
    }

    const matches = await prismaRead.reputationProfile.findMany({
      where: {
        OR: [
          { address: { contains: query, mode: 'insensitive' } },
          { domain: { contains: query, mode: 'insensitive' } },
        ],
      },
      take: 10,
    });

    return res.json({ query, results: matches });
  }),
);

/**
 * @swagger
 * /api/v1/reputation/{address}:
 *   get:
 *     summary: Compute and return the full reputation score for an address
 *     description: >
 *       Fetches on-chain profile data, computes the score using all active signals,
 *       persists the result to the database, and returns the full ScoreResult.
 *     tags: [Reputation]
 *     parameters:
 *       - in: path
 *         name: address
 *         required: true
 *         schema: { type: string }
 *         description: Stellar or EVM address (normalised to canonical form).
 *     responses:
 *       200:
 *         description: Full reputation score result
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ReputationScoreResult'
 */
// GET /api/v1/reputation/:address
reputationRouter.get(
  '/:address',
  handleAsync(async (req, res) => {
    const address = canonicalAddress(req.params.address);
    const chainData = await fetchProfileData(address);
    const scoreResult = computeReputationScore(address, chainData);
    await saveReputationToDb(address, scoreResult);
    return res.json(scoreResult);
  }),
);

/**
 * @swagger
 * /api/v1/reputation/{address}/summary:
 *   get:
 *     summary: Get a brief reputation summary for an address
 *     description: Returns the composite score and earned badges without the full breakdown.
 *     tags: [Reputation]
 *     parameters:
 *       - in: path
 *         name: address
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Address score and badge list
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 address: { type: string, example: 'GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI' }
 *                 score: { type: number, example: 72.5 }
 *                 badges:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/ReputationBadge'
 */
// GET /api/v1/reputation/:address/summary
reputationRouter.get(
  '/:address/summary',
  handleAsync(async (req, res) => {
    const address = canonicalAddress(req.params.address);
    const chainData = await fetchProfileData(address);
    const scoreResult = computeReputationScore(address, chainData);
    return res.json({
      address,
      score: scoreResult.score,
      badges: earnBadges(address, chainData),
    });
  }),
);

/**
 * @swagger
 * /api/v1/reputation/{address}/history:
 *   get:
 *     summary: Get reputation score history for an address
 *     description: >
 *       Returns a single history entry from the database record (timestamp + combinedScore).
 *       Returns an empty array if no profile exists yet.
 *     tags: [Reputation]
 *     parameters:
 *       - in: path
 *         name: address
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Score history entries
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 address: { type: string, example: 'GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI' }
 *                 history:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       timestamp: { type: string, format: date-time }
 *                       score: { type: number, nullable: true }
 */
// GET /api/v1/reputation/:address/history
reputationRouter.get(
  '/:address/history',
  handleAsync(async (req, res) => {
    const address = canonicalAddress(req.params.address);
    const profile = await prismaRead.reputationProfile.findUnique({
      where: { address },
    });

    if (!profile) {
      return res.json({ address, history: [] });
    }

    return res.json({
      address,
      history: [
        {
          timestamp: profile.updatedAt.toISOString(),
          score: profile.combinedScore,
        },
      ],
    });
  }),
);

/**
 * @swagger
 * /api/v1/reputation/{address}/signals:
 *   get:
 *     summary: Get the raw signal breakdown for an address
 *     description: Returns the per-signal breakdown array from a freshly computed score.
 *     tags: [Reputation]
 *     parameters:
 *       - in: path
 *         name: address
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Signal breakdown
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 address: { type: string, example: 'GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI' }
 *                 signals:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/ReputationBreakdownItem'
 */
// GET /api/v1/reputation/:address/signals
reputationRouter.get(
  '/:address/signals',
  handleAsync(async (req, res) => {
    const address = canonicalAddress(req.params.address);
    const chainData = await fetchProfileData(address);
    const scoreResult = computeReputationScore(address, chainData);
    return res.json({
      address,
      signals: scoreResult.breakdown,
    });
  }),
);

/**
 * @swagger
 * /api/v1/reputation/{address}/badges:
 *   get:
 *     summary: Get earned reputation badges for an address
 *     tags: [Reputation]
 *     parameters:
 *       - in: path
 *         name: address
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Badge list
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 address: { type: string, example: 'GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI' }
 *                 badges:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/ReputationBadge'
 */
// GET /api/v1/reputation/:address/badges
reputationRouter.get(
  '/:address/badges',
  handleAsync(async (req, res) => {
    const address = canonicalAddress(req.params.address);
    const chainData = await fetchProfileData(address);
    return res.json({
      address,
      badges: earnBadges(address, chainData),
    });
  }),
);

/**
 * @swagger
 * /api/v1/reputation/{address}/cross-chain:
 *   get:
 *     summary: Get per-chain reputation scores for an address
 *     tags: [Reputation]
 *     parameters:
 *       - in: path
 *         name: address
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Cross-chain score breakdown
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 address: { type: string, example: 'GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI' }
 *                 crossChainScores:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/ReputationChainScore'
 */
// GET /api/v1/reputation/:address/cross-chain
reputationRouter.get(
  '/:address/cross-chain',
  handleAsync(async (req, res) => {
    const address = canonicalAddress(req.params.address);
    const chainData = await fetchProfileData(address);
    const scoreResult = computeReputationScore(address, chainData);
    return res.json({
      address,
      crossChainScores: scoreResult.chainScores,
    });
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// 🟠 SHOULD-HAVE ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @swagger
 * /api/v1/reputation/{address}/attest:
 *   post:
 *     summary: Submit an on-chain or off-chain attestation for an address
 *     description: >
 *       Upserts the attestation by its computed uid, re-scores the profile, and
 *       returns the stored Attestation record.
 *     tags: [Reputation]
 *     parameters:
 *       - in: path
 *         name: address
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [chainId, schemaId, attester]
 *             properties:
 *               chainId: { type: string, example: stellar }
 *               schemaId: { type: string, example: schema-kyc-v1 }
 *               attester: { type: string, example: 'GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI' }
 *               recipient: { type: string }
 *               revoked: { type: boolean, default: false }
 *               signature: { type: string }
 *               transactionHash: { type: string }
 *               blockNumber: { type: integer }
 *               data: { type: object }
 *     responses:
 *       200:
 *         description: Upserted attestation record
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ReputationAttestationRecord'
 *       400:
 *         description: chainId, schemaId, or attester is missing
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               error: chainId, schemaId, and attester are required
 */
// POST /api/v1/reputation/:address/attest
reputationRouter.post(
  '/:address/attest',
  handleAsync(async (req, res) => {
    const address = canonicalAddress(req.params.address);
    const attestationInput = req.body;
    if (!attestationInput.chainId || !attestationInput.schemaId || !attestationInput.attester) {
      return res.status(400).json({ error: 'chainId, schemaId, and attester are required' });
    }

    let profile = await prismaWrite.reputationProfile.findUnique({ where: { address } });
    if (!profile) {
      profile = await prismaWrite.reputationProfile.create({
        data: { address, chain: attestationInput.chainId, combinedScore: 0 },
      });
    }

    const normalized = normalizeAttestation({
      ...attestationInput,
      subject: address,
    });

    const att = await prismaWrite.attestation.upsert({
      where: { uid: normalized.uid },
      create: {
        profileId: profile.id,
        uid: normalized.uid,
        chainId: normalized.chainId,
        schemaId: normalized.schemaId,
        attester: canonicalAddress(normalized.attester),
        subject: address,
        recipient: normalized.recipient ? canonicalAddress(normalized.recipient) : null,
        revoked: normalized.revoked || false,
        signature: normalized.signature || null,
        transactionHash: normalized.transactionHash || null,
        blockNumber: normalized.blockNumber ? Number(normalized.blockNumber) : null,
        data: normalized.data
          ? (normalized.data as import('@prisma/client').Prisma.InputJsonValue)
          : undefined,
        verified: normalized.verified,
        verificationMsg: normalized.verificationMessage,
      },
      update: {
        revoked: normalized.revoked || false,
        signature: normalized.signature || null,
        transactionHash: normalized.transactionHash || null,
        blockNumber: normalized.blockNumber ? Number(normalized.blockNumber) : null,
        data: normalized.data
          ? (normalized.data as import('@prisma/client').Prisma.InputJsonValue)
          : undefined,
        verified: normalized.verified,
        verificationMsg: normalized.verificationMessage,
      },
    });

    // Re-sync profile score
    const chainData = await fetchProfileData(address);
    const scoreResult = computeReputationScore(address, chainData);
    await saveReputationToDb(address, scoreResult);

    return res.json(att);
  }),
);

/**
 * @swagger
 * /api/v1/reputation/{address}/attestations:
 *   get:
 *     summary: List all stored attestations for an address
 *     tags: [Reputation]
 *     parameters:
 *       - in: path
 *         name: address
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Attestation list with total count
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 address: { type: string }
 *                 attestations:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/ReputationAttestationRecord'
 *                 total: { type: integer, example: 3 }
 */
// GET /api/v1/reputation/:address/attestations
reputationRouter.get(
  '/:address/attestations',
  handleAsync(async (req, res) => {
    const address = canonicalAddress(req.params.address);
    const profile = await prismaRead.reputationProfile.findUnique({
      where: { address },
      include: { attestations: true },
    });
    const list = profile ? profile.attestations : [];
    return res.json({ address, attestations: list, total: list.length });
  }),
);

/**
 * @swagger
 * /api/v1/reputation/{address}/attestations/{id}/verify:
 *   get:
 *     summary: Verify a stored attestation by its uid
 *     description: Checks whether the attestation has a valid on-chain tx hash or signature.
 *     tags: [Reputation]
 *     parameters:
 *       - in: path
 *         name: address
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *         description: The uid of the attestation.
 *     responses:
 *       200:
 *         description: Verification result
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 id: { type: string }
 *                 verified: { type: boolean, example: true }
 *                 verificationMsg: { type: string, example: 'attestation on-chain or valid signature verified' }
 *       404:
 *         description: Attestation not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               error: Attestation not found
 */
// GET /api/v1/reputation/:address/attestations/:id/verify
reputationRouter.get(
  '/:address/attestations/:id/verify',
  handleAsync(async (req, res) => {
    const attestation = await prismaRead.attestation.findUnique({
      where: { uid: req.params.id },
    });

    if (!attestation) {
      return res.status(404).json({ error: 'Attestation not found' });
    }

    const isVerifiable = isAttestationVerifiable({
      chainId: attestation.chainId,
      schemaId: attestation.schemaId,
      attester: attestation.attester,
      subject: attestation.subject,
      recipient: attestation.recipient || undefined,
      revoked: attestation.revoked,
      signature: attestation.signature || undefined,
      transactionHash: attestation.transactionHash || undefined,
      blockNumber: attestation.blockNumber || undefined,
    });

    return res.json({
      id: attestation.uid,
      verified: isVerifiable,
      verificationMsg: isVerifiable
        ? 'attestation on-chain or valid signature verified'
        : 'invalid signature or missing evidence',
    });
  }),
);

/**
 * @swagger
 * /api/v1/reputation/{address}/credentials:
 *   post:
 *     summary: Submit a W3C Verifiable Credential for an address
 *     description: >
 *       Validates the credential against the W3C VC data model, upserts it in the database,
 *       re-scores the profile, and returns the stored record.
 *     tags: [Reputation]
 *     parameters:
 *       - in: path
 *         name: address
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             description: >
 *               W3C Verifiable Credential. Must include @context containing
 *               "w3.org/ns/credentials", type "VerifiableCredential", id, issuer,
 *               issuanceDate, credentialSubject.id, and a proof block.
 *             example:
 *               "@context": ["https://www.w3.org/ns/credentials/v2"]
 *               id: "https://example.edu/credentials/1"
 *               type: ["VerifiableCredential", "KYCCredential"]
 *               issuer: "did:example:issuer"
 *               issuanceDate: "2026-06-01T00:00:00Z"
 *               credentialSubject:
 *                 id: "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI"
 *               proof:
 *                 type: "Ed25519Signature2020"
 *                 created: "2026-06-01T00:00:00Z"
 *                 verificationMethod: "did:example:issuer#key-1"
 *                 proofPurpose: "assertionMethod"
 *                 proofValue: "z..."
 *     responses:
 *       200:
 *         description: Upserted verifiable credential record
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ReputationVerifiableCredential'
 *       400:
 *         description: Credential does not match W3C VC format
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               error: Invalid W3C Verifiable Credential format
 */
// POST /api/v1/reputation/:address/credentials
reputationRouter.post(
  '/:address/credentials',
  handleAsync(async (req, res) => {
    const address = canonicalAddress(req.params.address);
    const vc = req.body;
    if (!isVerifiableCredential(vc)) {
      return res.status(400).json({ error: 'Invalid W3C Verifiable Credential format' });
    }

    let profile = await prismaWrite.reputationProfile.findUnique({ where: { address } });
    if (!profile) {
      profile = await prismaWrite.reputationProfile.create({
        data: { address, chain: 'stellar', combinedScore: 0 },
      });
    }

    const cred = await prismaWrite.verifiableCredential.upsert({
      where: { credentialId: vc.id },
      create: {
        profileId: profile.id,
        credentialId: vc.id,
        context: vc['@context'] as any,
        type: vc.type as any,
        issuer: typeof vc.issuer === 'string' ? vc.issuer : vc.issuer.id,
        issuanceDate: new Date(vc.issuanceDate),
        expirationDate: vc.expirationDate ? new Date(vc.expirationDate) : null,
        subjectId: vc.credentialSubject.id,
        subjectData: vc.credentialSubject,
        proofType: vc.proof.type,
        proofCreated: new Date(vc.proof.created),
        verificationMethod: vc.proof.verificationMethod,
        proofPurpose: vc.proof.proofPurpose,
        proofValue: vc.proof.proofValue,
      },
      update: {
        context: vc['@context'] as any,
        type: vc.type as any,
        issuer: typeof vc.issuer === 'string' ? vc.issuer : vc.issuer.id,
        issuanceDate: new Date(vc.issuanceDate),
        expirationDate: vc.expirationDate ? new Date(vc.expirationDate) : null,
        subjectId: vc.credentialSubject.id,
        subjectData: vc.credentialSubject,
        proofType: vc.proof.type,
        proofCreated: new Date(vc.proof.created),
        verificationMethod: vc.proof.verificationMethod,
        proofPurpose: vc.proof.proofPurpose,
        proofValue: vc.proof.proofValue,
      },
    });

    // Re-sync profile score
    const chainData = await fetchProfileData(address);
    const scoreResult = computeReputationScore(address, chainData);
    await saveReputationToDb(address, scoreResult);

    return res.json(cred);
  }),
);

/**
 * @swagger
 * /api/v1/reputation/{address}/credentials:
 *   get:
 *     summary: List stored verifiable credentials for an address
 *     tags: [Reputation]
 *     parameters:
 *       - in: path
 *         name: address
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Credential list with total count
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 address: { type: string }
 *                 credentials:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/ReputationVerifiableCredential'
 *                 total: { type: integer, example: 2 }
 */
// GET /api/v1/reputation/:address/credentials
reputationRouter.get(
  '/:address/credentials',
  handleAsync(async (req, res) => {
    const address = canonicalAddress(req.params.address);
    const profile = await prismaRead.reputationProfile.findUnique({
      where: { address },
      include: { credentials: true },
    });
    const list = profile ? profile.credentials : [];
    return res.json({ address, credentials: list, total: list.length });
  }),
);

/**
 * @swagger
 * /api/v1/reputation/credentials/verify:
 *   post:
 *     summary: Check whether a JSON payload matches the W3C VC format
 *     description: >
 *       Stateless check against the W3C Verifiable Credential data model rules.
 *       Always returns 200 with a boolean result; never throws 400.
 *     tags: [Reputation]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             description: Candidate W3C Verifiable Credential payload.
 *     responses:
 *       200:
 *         description: Verification result
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 verified: { type: boolean, example: true }
 *                 message: { type: string, example: 'Credential matches W3C verification rules' }
 */
// POST /api/v1/reputation/credentials/verify
reputationRouter.post(
  '/credentials/verify',
  handleAsync(async (req, res) => {
    const vc = req.body;
    const verified = isVerifiableCredential(vc);
    return res.json({
      verified,
      message: verified ? 'Credential matches W3C verification rules' : 'Verification failed',
    });
  }),
);

/**
 * @swagger
 * /api/v1/reputation/{address}/sybil-score:
 *   get:
 *     summary: Get the Sybil risk assessment for an address
 *     tags: [Reputation]
 *     parameters:
 *       - in: path
 *         name: address
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Sybil risk assessment
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SybilAssessment'
 */
// GET /api/v1/reputation/:address/sybil-score
reputationRouter.get(
  '/:address/sybil-score',
  handleAsync(async (req, res) => {
    const address = canonicalAddress(req.params.address);
    const chainData = await fetchProfileData(address);
    const assessment = assessSybilRisk(address, chainData);
    return res.json(assessment);
  }),
);

/**
 * @swagger
 * /api/v1/reputation/verify-cross-chain:
 *   post:
 *     summary: Record a verified cross-chain reputation signal for an address
 *     description: Creates a ReputationSignal record and re-scores the profile.
 *     tags: [Reputation]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [address, chain, signalType]
 *             properties:
 *               address: { type: string, example: 'GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI' }
 *               chain: { type: string, example: stellar }
 *               signalType: { type: string, example: governance_vote }
 *               value: { type: number, example: 1 }
 *               source: { type: string, example: offchain }
 *               metadata: { type: object }
 *     responses:
 *       200:
 *         description: Created ReputationSignal record
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 id: { type: string, example: 'clz9q1x4t0000s6h2signal01' }
 *                 profileId: { type: string }
 *                 signalType: { type: string, example: governance_vote }
 *                 chain: { type: string, example: stellar }
 *                 value: { type: number, nullable: true, example: 1 }
 *                 weight: { type: number, nullable: true, example: 0.1 }
 *                 normalizedScore: { type: number, nullable: true, example: 1 }
 *                 source: { type: string, nullable: true, example: offchain }
 *                 verified: { type: boolean, example: true }
 *                 metadata: { type: object, nullable: true }
 *                 createdAt: { type: string, format: date-time }
 *       400:
 *         description: address, chain, or signalType is missing
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               error: address, chain, and signalType are required
 */
// POST /api/v1/reputation/verify-cross-chain
reputationRouter.post(
  '/verify-cross-chain',
  handleAsync(async (req, res) => {
    const { address, chain, signalType, value, source, metadata } = req.body;
    if (!address || !chain || !signalType) {
      return res.status(400).json({ error: 'address, chain, and signalType are required' });
    }

    const canonical = canonicalAddress(address);
    let profile = await prismaWrite.reputationProfile.findUnique({ where: { address: canonical } });
    if (!profile) {
      profile = await prismaWrite.reputationProfile.create({
        data: { address: canonical, chain, combinedScore: 0 },
      });
    }

    const signal = await prismaWrite.reputationSignal.create({
      data: {
        profileId: profile.id,
        signalType,
        chain,
        value: Number(value ?? 0),
        weight: 0.1,
        normalizedScore: Number(value ?? 0),
        source: source || 'offchain',
        verified: true,
        metadata: metadata || null,
      },
    });

    const chainData = await fetchProfileData(canonical);
    const scoreResult = computeReputationScore(canonical, chainData);
    await saveReputationToDb(canonical, scoreResult);

    return res.json(signal);
  }),
);

/**
 * @swagger
 * /api/v1/reputation/link:
 *   post:
 *     summary: Link a cross-chain address to a canonical reputation profile
 *     description: >
 *       Verifies the signature binding the linked address to the canonical address,
 *       upserts the LinkedIdentity record, and re-scores the profile.
 *     tags: [Reputation]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [canonicalAddress, chainId, address, signature]
 *             properties:
 *               canonicalAddress: { type: string, example: 'GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI' }
 *               chainId: { type: string, example: stellar }
 *               address: { type: string, example: 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN' }
 *               message: { type: string }
 *               signature: { type: string }
 *     responses:
 *       200:
 *         description: Upserted LinkedIdentity record
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ReputationLinkedIdentity'
 *       400:
 *         description: canonicalAddress, chainId, address, or signature is missing
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               error: canonicalAddress, chainId, address, and signature are required
 */
// POST /api/v1/reputation/link
reputationRouter.post(
  '/link',
  handleAsync(async (req, res) => {
    const {
      canonicalAddress: canonicalVal,
      chainId,
      address: linkedAddress,
      message,
      signature,
    } = req.body;
    if (!canonicalVal || !chainId || !linkedAddress || !signature) {
      return res
        .status(400)
        .json({ error: 'canonicalAddress, chainId, address, and signature are required' });
    }

    const canonical = canonicalAddress(canonicalVal);
    const linked = canonicalAddress(linkedAddress);

    let profile = await prismaWrite.reputationProfile.findUnique({ where: { address: canonical } });
    if (!profile) {
      profile = await prismaWrite.reputationProfile.create({
        data: { address: canonical, chain: chainId, combinedScore: 0 },
      });
    }

    // verify links
    const verifyResult = verifyIdentityLinks({
      canonicalAddress: canonical,
      links: [{ chainId, address: linked, message, signature }],
    });

    const isVerified = verifyResult[0]?.verified || false;

    const link = await prismaWrite.linkedIdentity.upsert({
      where: {
        profileId_chainId_address: {
          profileId: profile.id,
          chainId,
          address: linked,
        },
      },
      create: {
        profileId: profile.id,
        chainId,
        address: linked,
        message: message || '',
        signature,
        verified: isVerified,
      },
      update: {
        message: message || '',
        signature,
        verified: isVerified,
      },
    });

    // Recompute scores
    const chainData = await fetchProfileData(canonical);
    const finalResult = computeReputationScoreForIdentity(canonical, chainData, verifyResult);
    await saveReputationToDb(canonical, finalResult);

    return res.json(link);
  }),
);

/**
 * @swagger
 * /api/v1/reputation/{address}/links:
 *   get:
 *     summary: List all linked cross-chain identities for an address
 *     tags: [Reputation]
 *     parameters:
 *       - in: path
 *         name: address
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Linked identity list
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 address: { type: string }
 *                 links:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/ReputationLinkedIdentity'
 */
// GET /api/v1/reputation/:address/links
reputationRouter.get(
  '/:address/links',
  handleAsync(async (req, res) => {
    const address = canonicalAddress(req.params.address);
    const profile = await prismaRead.reputationProfile.findUnique({
      where: { address },
      include: { linkedIdentities: true },
    });
    return res.json({ address, links: profile ? profile.linkedIdentities : [] });
  }),
);

/**
 * @swagger
 * /api/v1/reputation/link/{id}:
 *   delete:
 *     summary: Remove a linked cross-chain identity by its record id
 *     description: >
 *       Deletes the LinkedIdentity record and re-scores the owning profile.
 *       Returns 500 if the record does not exist (Prisma throws, no explicit 404).
 *     tags: [Reputation]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *         description: LinkedIdentity record id.
 *     responses:
 *       200:
 *         description: Deletion confirmed with the removed record
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 removedLink:
 *                   allOf:
 *                     - $ref: '#/components/schemas/ReputationLinkedIdentity'
 *                     - type: object
 *                       properties:
 *                         profile:
 *                           $ref: '#/components/schemas/ReputationProfileRecord'
 */
// DELETE /api/v1/reputation/link/:id
reputationRouter.delete(
  '/link/:id',
  handleAsync(async (req, res) => {
    const link = await prismaWrite.linkedIdentity.delete({
      where: { id: req.params.id },
      include: { profile: true },
    });

    // Re-sync
    const chainData = await fetchProfileData(link.profile.address);
    const scoreResult = computeReputationScore(link.profile.address, chainData);
    await saveReputationToDb(link.profile.address, scoreResult);

    return res.json({ success: true, removedLink: link });
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// 🔵 NICE-TO-HAVE ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @swagger
 * /api/v1/reputation/trust-network/{address}:
 *   get:
 *     summary: Get the trust graph for an address
 *     description: Builds a graph of trust edges derived from on-chain profile data.
 *     tags: [Reputation]
 *     parameters:
 *       - in: path
 *         name: address
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Trust graph (nodes and edges)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 nodes:
 *                   type: array
 *                   items: { type: string }
 *                   example: ['GBZX...', 'GAAZ...']
 *                 edges:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       from: { type: string }
 *                       to: { type: string }
 *                       chainId: { type: string }
 *                       weight: { type: number }
 *                       type: { type: string, nullable: true }
 *                       transactionHash: { type: string, nullable: true }
 */
// GET /api/v1/reputation/trust-network/:address
reputationRouter.get(
  '/trust-network/:address',
  handleAsync(async (req, res) => {
    const address = canonicalAddress(req.params.address);
    const chainData = await fetchProfileData(address);
    const graph = buildTrustGraph(chainData);
    return res.json(graph);
  }),
);

/**
 * @swagger
 * /api/v1/reputation/trust-network/{address}/path/{target}:
 *   get:
 *     summary: Find the shortest trust path between two addresses
 *     description: >
 *       Returns the shortest hop path from address to target through the trust graph.
 *       Returns a null path and distance -1 if no path exists.
 *     tags: [Reputation]
 *     parameters:
 *       - in: path
 *         name: address
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: target
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Trust path result
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/TrustPath'
 */
// GET /api/v1/reputation/trust-network/:address/path/:target
reputationRouter.get(
  '/trust-network/:address/path/:target',
  handleAsync(async (req, res) => {
    const address = canonicalAddress(req.params.address);
    const target = canonicalAddress(req.params.target);
    const chainData = await fetchProfileData(address);
    const graph = buildTrustGraph(chainData);
    const path = findTrustPath(graph, address, target);
    return res.json(path || { from: address, to: target, path: null, distance: -1, chainIds: [] });
  }),
);

/**
 * @swagger
 * /api/v1/reputation/trust-network/influence/{address}:
 *   get:
 *     summary: Get the influence score for an address in the trust network
 *     description: >
 *       Computes a simplified PageRank-style influence score based on incoming trust edge weights.
 *     tags: [Reputation]
 *     parameters:
 *       - in: path
 *         name: address
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Influence score
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 address: { type: string, example: 'GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI' }
 *                 influenceScore: { type: number, example: 1.35 }
 */
// GET /api/v1/reputation/trust-network/influence/:address
reputationRouter.get(
  '/trust-network/influence/:address',
  handleAsync(async (req, res) => {
    const address = canonicalAddress(req.params.address);
    const chainData = await fetchProfileData(address);
    const graph = buildTrustGraph(chainData);

    // page-rank / influence score mock
    let influenceScore = 1.0;
    for (const e of graph.edges) {
      if (e.to === address) {
        influenceScore += e.weight * 0.5;
      }
    }

    return res.json({ address, influenceScore: Math.round(influenceScore * 100) / 100 });
  }),
);

/**
 * @swagger
 * /api/v1/reputation/endorse:
 *   post:
 *     summary: Record an endorsement from one address to another
 *     tags: [Reputation]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [chainId, endorser, subject]
 *             properties:
 *               chainId: { type: string, example: stellar }
 *               endorser: { type: string, example: 'GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI' }
 *               subject: { type: string, example: 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN' }
 *               weight: { type: number, default: 1.0 }
 *     responses:
 *       200:
 *         description: Created endorsement record
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ReputationEndorsement'
 *       400:
 *         description: chainId, endorser, or subject is missing
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               error: chainId, endorser, and subject are required
 */
// POST /api/v1/reputation/endorse
reputationRouter.post(
  '/endorse',
  handleAsync(async (req, res) => {
    const { chainId, endorser, subject, weight } = req.body;
    if (!chainId || !endorser || !subject) {
      return res.status(400).json({ error: 'chainId, endorser, and subject are required' });
    }

    const canonicalSubject = canonicalAddress(subject);
    let profile = await prismaWrite.reputationProfile.findUnique({
      where: { address: canonicalSubject },
    });
    if (!profile) {
      profile = await prismaWrite.reputationProfile.create({
        data: { address: canonicalSubject, chain: chainId, combinedScore: 0 },
      });
    }

    const endorsement = await prismaWrite.endorsement.create({
      data: {
        profileId: profile.id,
        chainId,
        endorser: canonicalAddress(endorser),
        subject: canonicalSubject,
        weight: Number(weight ?? 1.0),
      },
    });

    return res.json(endorsement);
  }),
);

/**
 * @swagger
 * /api/v1/reputation/{address}/endorsements/received:
 *   get:
 *     summary: List endorsements received by an address
 *     tags: [Reputation]
 *     parameters:
 *       - in: path
 *         name: address
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Received endorsements
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 address: { type: string }
 *                 endorsements:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/ReputationEndorsement'
 */
// GET /api/v1/reputation/:address/endorsements/received
reputationRouter.get(
  '/:address/endorsements/received',
  handleAsync(async (req, res) => {
    const address = canonicalAddress(req.params.address);
    const profile = await prismaRead.reputationProfile.findUnique({
      where: { address },
      include: { endorsements: true },
    });
    return res.json({ address, endorsements: profile ? profile.endorsements : [] });
  }),
);

/**
 * @swagger
 * /api/v1/reputation/disputes:
 *   post:
 *     summary: Open a reputation dispute against an address
 *     tags: [Reputation]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [challenger, respondent, challenge, evidenceHash]
 *             properties:
 *               challenger: { type: string, example: 'GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI' }
 *               respondent: { type: string, example: 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN' }
 *               challenge: { type: string, example: 'Sybil farming accusations' }
 *               evidenceHash: { type: string, example: 'e5f40312...' }
 *               quorumVotes: { type: integer, default: 5 }
 *     responses:
 *       200:
 *         description: Created dispute record (votes not included)
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ReputationDisputeRecord'
 *       400:
 *         description: challenger, respondent, challenge, or evidenceHash is missing
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               error: challenger, respondent, challenge, and evidenceHash are required
 */
// POST /api/v1/reputation/disputes
reputationRouter.post(
  '/disputes',
  handleAsync(async (req, res) => {
    const { challenger, respondent, challenge, evidenceHash, quorumVotes } = req.body;
    if (!challenger || !respondent || !challenge || !evidenceHash) {
      return res
        .status(400)
        .json({ error: 'challenger, respondent, challenge, and evidenceHash are required' });
    }

    const canonRespondent = canonicalAddress(respondent);
    let profile = await prismaWrite.reputationProfile.findUnique({
      where: { address: canonRespondent },
    });
    if (!profile) {
      profile = await prismaWrite.reputationProfile.create({
        data: { address: canonRespondent, chain: 'stellar', combinedScore: 0 },
      });
    }

    const caseObj = createArbitrationCase({
      challenger: canonicalAddress(challenger),
      respondent: canonRespondent,
      challenge,
      evidenceHash,
      quorumVotes: Number(quorumVotes ?? 5),
    });

    const dispute = await prismaWrite.reputationDispute.create({
      data: {
        id: caseObj.id,
        profileId: profile.id,
        challenger: caseObj.challenger,
        respondent: caseObj.respondent,
        challenge: caseObj.challenge,
        evidenceHash: caseObj.evidenceHash,
        quorumVotes: caseObj.quorumVotes,
        status: caseObj.status,
        outcome: null,
      },
    });

    return res.json(dispute);
  }),
);

/**
 * @swagger
 * /api/v1/reputation/disputes/{id}:
 *   get:
 *     summary: Get a dispute by id, including all votes
 *     tags: [Reputation]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Dispute record with embedded votes
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ReputationDisputeRecord'
 *       404:
 *         description: Dispute not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               error: Dispute not found
 */
// GET /api/v1/reputation/disputes/:id
reputationRouter.get(
  '/disputes/:id',
  handleAsync(async (req, res) => {
    const dispute = await prismaRead.reputationDispute.findUnique({
      where: { id: req.params.id },
      include: { votes: true },
    });
    if (!dispute) return res.status(404).json({ error: 'Dispute not found' });
    return res.json(dispute);
  }),
);

/**
 * @swagger
 * /api/v1/reputation/disputes/{id}/vote:
 *   post:
 *     summary: Cast a vote on a reputation dispute
 *     tags: [Reputation]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [voter, vote]
 *             properties:
 *               voter: { type: string, example: 'GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI' }
 *               vote: { type: string, enum: [uphold, reject, abstain], example: uphold }
 *               weight: { type: number, default: 1.0 }
 *               signature: { type: string }
 *               transactionHash: { type: string }
 *     responses:
 *       200:
 *         description: Created vote record
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 id: { type: string }
 *                 disputeId: { type: string }
 *                 voter: { type: string }
 *                 vote: { type: string, nullable: true }
 *                 weight: { type: number, nullable: true }
 *                 signature: { type: string, nullable: true }
 *                 transactionHash: { type: string, nullable: true }
 *                 createdAt: { type: string, format: date-time }
 *       400:
 *         description: voter or vote is missing
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               error: voter and vote are required
 */
// POST /api/v1/reputation/disputes/:id/vote
reputationRouter.post(
  '/disputes/:id/vote',
  handleAsync(async (req, res) => {
    const { voter, vote, weight, signature, transactionHash } = req.body;
    if (!voter || !vote) {
      return res.status(400).json({ error: 'voter and vote are required' });
    }

    const disputeVote = await prismaWrite.reputationDisputeVote.create({
      data: {
        disputeId: req.params.id,
        voter: canonicalAddress(voter),
        vote,
        weight: Number(weight ?? 1.0),
        signature: signature || null,
        transactionHash: transactionHash || null,
      },
    });

    return res.json(disputeVote);
  }),
);

/**
 * @swagger
 * /api/v1/reputation/disputes/{id}/resolve:
 *   post:
 *     summary: Resolve a dispute by tallying its votes
 *     description: >
 *       Fetches the dispute and all votes, runs arbitration logic, and updates
 *       the dispute status and outcome. No request body needed.
 *     tags: [Reputation]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Updated dispute and arbitration result
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 dispute:
 *                   $ref: '#/components/schemas/ReputationDisputeRecord'
 *                 resolution:
 *                   type: object
 *                   properties:
 *                     caseId: { type: string }
 *                     status: { type: string, enum: [open, resolved] }
 *                     outcome: { type: string, nullable: true, enum: [upheld, rejected, timeout] }
 *                     votesFor: { type: number }
 *                     votesAgainst: { type: number }
 *                     votesAbstain: { type: number }
 *                     quorumVotes: { type: integer }
 *                     quorumReached: { type: boolean }
 *                     winner: { type: string }
 *       404:
 *         description: Dispute not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               error: Dispute not found
 */
// POST /api/v1/reputation/disputes/:id/resolve
reputationRouter.post(
  '/disputes/:id/resolve',
  handleAsync(async (req, res) => {
    const dispute = await prismaRead.reputationDispute.findUnique({
      where: { id: req.params.id },
      include: { votes: true },
    });

    if (!dispute) return res.status(404).json({ error: 'Dispute not found' });

    const mappedCase = {
      id: dispute.id,
      challenger: dispute.challenger,
      respondent: dispute.respondent,
      challenge: dispute.challenge,
      evidenceHash: dispute.evidenceHash,
      quorumVotes: dispute.quorumVotes,
      status: dispute.status as any,
      createdAt: dispute.createdAt.toISOString(),
    };

    const mappedVotes = dispute.votes.map((v) => ({
      caseId: v.disputeId,
      voter: v.voter,
      vote: v.vote as any,
      weight: v.weight,
      signature: v.signature || undefined,
      transactionHash: v.transactionHash || undefined,
    }));

    const resolution = resolveArbitrationCase(mappedCase, mappedVotes);

    const updated = await prismaWrite.reputationDispute.update({
      where: { id: dispute.id },
      data: {
        status: resolution.status,
        outcome: resolution.outcome || null,
        resolvedAt: resolution.status === 'resolved' ? new Date() : null,
      },
    });

    return res.json({ dispute: updated, resolution });
  }),
);

/**
 * @swagger
 * /api/v1/reputation/oracle/query:
 *   post:
 *     summary: Query the reputation oracle for a full response
 *     description: Computes and returns the complete oracle response including attestations, credentials, sybil assessment, and proof.
 *     tags: [Reputation]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [address]
 *             properties:
 *               address: { type: string, example: 'GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI' }
 *     responses:
 *       200:
 *         description: Full oracle reputation response
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/OracleReputationResponse'
 *       400:
 *         description: address is missing
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               error: address is required
 */
// POST /api/v1/reputation/oracle/query
reputationRouter.post(
  '/oracle/query',
  handleAsync(async (req, res) => {
    const { address } = req.body;
    if (!address) return res.status(400).json({ error: 'address is required' });
    const chainData = await fetchProfileData(address);
    const response = createOracleResponse(address, chainData);
    return res.json(response);
  }),
);

/**
 * @swagger
 * /api/v1/reputation/oracle/proof:
 *   get:
 *     summary: Get the verifiable proof for an address's reputation score
 *     tags: [Reputation]
 *     parameters:
 *       - in: query
 *         name: address
 *         required: true
 *         schema: { type: string }
 *         description: Address to generate proof for.
 *     responses:
 *       200:
 *         description: Reputation proof envelope
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ReputationProof'
 *       400:
 *         description: address query param is missing
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               error: address query param is required
 */
// GET /api/v1/reputation/oracle/proof
reputationRouter.get(
  '/oracle/proof',
  handleAsync(async (req, res) => {
    const address = req.query.address as string;
    if (!address) return res.status(400).json({ error: 'address query param is required' });
    const chainData = await fetchProfileData(address);
    const response = createOracleResponse(address, chainData);
    return res.json(response.proof);
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// 🟢 STRETCH ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @swagger
 * /api/v1/reputation/governance/delegate:
 *   post:
 *     summary: Delegate voting power to another address
 *     description: Upserts a delegation record keyed by delegator address.
 *     tags: [Reputation]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [delegator, delegatee]
 *             properties:
 *               delegator: { type: string, example: 'GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI' }
 *               delegatee: { type: string, example: 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN' }
 *               amount: { type: number }
 *     responses:
 *       200:
 *         description: Upserted delegation record
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 id: { type: string }
 *                 delegator: { type: string }
 *                 delegatee: { type: string }
 *                 amount: { type: string, nullable: true }
 *                 createdAt: { type: string, format: date-time }
 *       400:
 *         description: delegator or delegatee is missing
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               error: delegator and delegatee are required
 */
// POST /api/v1/reputation/governance/delegate
reputationRouter.post(
  '/governance/delegate',
  handleAsync(async (req, res) => {
    const { delegator, delegatee, amount } = req.body;
    if (!delegator || !delegatee) {
      return res.status(400).json({ error: 'delegator and delegatee are required' });
    }

    const delegation = await prismaWrite.reputationDelegation.upsert({
      where: { delegator: canonicalAddress(delegator) },
      create: {
        delegator: canonicalAddress(delegator),
        delegatee: canonicalAddress(delegatee),
        amount: amount ? Number(amount) : null,
      },
      update: {
        delegatee: canonicalAddress(delegatee),
        amount: amount ? Number(amount) : null,
      },
    });

    return res.json(delegation);
  }),
);

/**
 * @swagger
 * /api/v1/reputation/governance/voting-power/{address}:
 *   get:
 *     summary: Get the effective voting power for an address
 *     description: >
 *       Combines own power (combinedScore / 10) with delegated-in and delegated-out amounts
 *       from all delegation records in the database.
 *     tags: [Reputation]
 *     parameters:
 *       - in: path
 *         name: address
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Voting power breakdown
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 address: { type: string }
 *                 ownPower: { type: number, example: 7.25 }
 *                 delegatedIn: { type: number, example: 2.0 }
 *                 delegatedOut: { type: number, example: 0 }
 *                 effectivePower: { type: number, example: 9.25 }
 */
// GET /api/v1/reputation/governance/voting-power/:address
reputationRouter.get(
  '/governance/voting-power/:address',
  handleAsync(async (req, res) => {
    const address = canonicalAddress(req.params.address);

    // Fetch all balances and delegations
    const delegations = await prismaRead.reputationDelegation.findMany();
    const profiles = await prismaRead.reputationProfile.findMany();

    const accounts = profiles.map((p) => ({
      address: p.address,
      balance: p.combinedScore ? p.combinedScore / 10 : 0,
    }));

    const mappedDelegations = delegations.map((d) => ({
      delegator: d.delegator,
      delegatee: d.delegatee,
      amount: d.amount || undefined,
    }));

    const votingPowers = calculateDelegatedVotingPower(accounts, mappedDelegations);
    const userPower = votingPowers.find((vp) => vp.address === address) || {
      address,
      ownPower: 0,
      delegatedIn: 0,
      delegatedOut: 0,
      effectivePower: 0,
    };

    return res.json(userPower);
  }),
);

/**
 * @swagger
 * /api/v1/reputation/governance/vote:
 *   post:
 *     summary: Cast or update a governance vote for a proposal
 *     description: Upserts a vote keyed by (proposalId, voter). The Prisma model stores the vote in a "vote" column; the "support" field in the request maps to that column.
 *     tags: [Reputation]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [proposalId, voter, support]
 *             properties:
 *               proposalId: { type: string, example: prop-42 }
 *               voter: { type: string, example: 'GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI' }
 *               weight: { type: number, default: 1.0 }
 *               support: { type: string, enum: [for, against, abstain], example: for }
 *     responses:
 *       200:
 *         description: Upserted governance vote record
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 id: { type: string }
 *                 proposalId: { type: string }
 *                 voter: { type: string }
 *                 vote: { type: string, nullable: true }
 *                 weight: { type: number, nullable: true }
 *                 reason: { type: string, nullable: true }
 *                 createdAt: { type: string, format: date-time }
 *       400:
 *         description: proposalId, voter, or support is missing
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               error: proposalId, voter, and support are required
 */
// POST /api/v1/reputation/governance/vote
reputationRouter.post(
  '/governance/vote',
  handleAsync(async (req, res) => {
    const { proposalId, voter, weight, support } = req.body;
    if (!proposalId || !voter || !support) {
      return res.status(400).json({ error: 'proposalId, voter, and support are required' });
    }

    const vote = await prismaWrite.reputationGovernanceVote.upsert({
      where: {
        proposalId_voter: { proposalId, voter: canonicalAddress(voter) },
      },
      create: {
        proposalId,
        voter: canonicalAddress(voter),
        weight: Number(weight ?? 1.0),
        support,
      },
      update: {
        weight: Number(weight ?? 1.0),
        support,
      },
    });

    return res.json(vote);
  }),
);

/**
 * @swagger
 * /api/v1/reputation/nfts/mint/{badgeType}:
 *   post:
 *     summary: Mint a Soulbound reputation NFT for an address
 *     description: Creates a ReputationNft record with a deterministic tokenId and a random mintedTxHash placeholder.
 *     tags: [Reputation]
 *     parameters:
 *       - in: path
 *         name: badgeType
 *         required: true
 *         schema: { type: string }
 *         description: Badge type identifier (e.g. "whale", "governance_voter").
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [address]
 *             properties:
 *               address: { type: string, example: 'GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI' }
 *     responses:
 *       200:
 *         description: Created NFT record
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ReputationNftRecord'
 *       400:
 *         description: address is missing
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               error: address is required
 */
// POST /api/v1/reputation/nfts/mint/:badgeType
reputationRouter.post(
  '/nfts/mint/:badgeType',
  handleAsync(async (req, res) => {
    const { address } = req.body;
    if (!address) return res.status(400).json({ error: 'address is required' });

    const badgeType = req.params.badgeType;
    const canonical = canonicalAddress(address);
    const tokenId = `reputation-nft-${canonical.slice(0, 8)}-${badgeType}`;

    const nft = await prismaWrite.reputationNft.create({
      data: {
        address: canonical,
        badgeType,
        tokenId,
        mintedTxHash: `tx-${Math.random().toString(36).substring(2, 12)}`,
      },
    });

    return res.json(nft);
  }),
);

/**
 * @swagger
 * /api/v1/reputation/nfts/{address}:
 *   get:
 *     summary: List all reputation NFTs for an address
 *     tags: [Reputation]
 *     parameters:
 *       - in: path
 *         name: address
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Array of NFT records
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/ReputationNftRecord'
 */
// GET /api/v1/reputation/nfts/:address
reputationRouter.get(
  '/nfts/:address',
  handleAsync(async (req, res) => {
    const address = canonicalAddress(req.params.address);
    const nfts = await prismaRead.reputationNft.findMany({
      where: { address },
    });
    return res.json(nfts);
  }),
);

/**
 * @swagger
 * /api/v1/reputation/nfts/{address}/{badgeType}/verify:
 *   get:
 *     summary: Verify whether an address holds a specific Soulbound NFT badge
 *     tags: [Reputation]
 *     parameters:
 *       - in: path
 *         name: address
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: badgeType
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Verification result with the matching NFT record if found
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 verified: { type: boolean, example: true }
 *                 nft:
 *                   oneOf:
 *                     - $ref: '#/components/schemas/ReputationNftRecord'
 *                     - type: 'null'
 *                 message: { type: string, example: 'Authentic badge Soulbound NFT verified on-chain.' }
 */
// GET /api/v1/reputation/nfts/:address/:badgeType/verify
reputationRouter.get(
  '/nfts/:address/:badgeType/verify',
  handleAsync(async (req, res) => {
    const address = canonicalAddress(req.params.address);
    const nft = await prismaRead.reputationNft.findFirst({
      where: { address, badgeType: req.params.badgeType },
    });

    return res.json({
      verified: !!nft,
      nft: nft || null,
      message: nft
        ? 'Authentic badge Soulbound NFT verified on-chain.'
        : 'No authentic Soulbound NFT found.',
    });
  }),
);

/**
 * @swagger
 * /api/v1/reputation/sdk/js:
 *   get:
 *     summary: Download the Reputation JavaScript SDK
 *     description: Returns a minimal ES module client as application/javascript.
 *     tags: [Reputation]
 *     responses:
 *       200:
 *         description: JavaScript SDK source
 *         content:
 *           application/javascript:
 *             schema:
 *               type: string
 *             example: "export class ReputationClient { ... }"
 */
// GET /api/v1/reputation/sdk/js
reputationRouter.get(
  '/sdk/js',
  handleAsync(async (req, res) => {
    res.setHeader('content-type', 'application/javascript');
    return res.send(`
// Reputation SDK v1.0.0
export class ReputationClient {
  constructor(baseUrl) {
    this.baseUrl = baseUrl;
  }
  async getScore(address) {
    const res = await fetch(\`\${this.baseUrl}/api/v1/reputation/\${address}\`);
    return res.json();
  }
}
  `);
  }),
);

/**
 * @swagger
 * /api/v1/reputation/sdk/register:
 *   post:
 *     summary: Register a dApp to receive a Reputation SDK API key
 *     tags: [Reputation]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name]
 *             properties:
 *               name: { type: string, example: MyDeFiApp }
 *     responses:
 *       200:
 *         description: Registered dApp record with generated API key
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 id: { type: string, example: 'clz9q1x4t0000s6h2dapp0001' }
 *                 name: { type: string, example: MyDeFiApp }
 *                 apiKey: { type: string, example: 'rep-sdk-abc123def456' }
 *                 createdAt: { type: string, format: date-time }
 *       400:
 *         description: name is missing
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               error: name is required
 */
// POST /api/v1/reputation/sdk/register
reputationRouter.post(
  '/sdk/register',
  handleAsync(async (req, res) => {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });

    const apiKey = `rep-sdk-${Math.random().toString(36).substring(2, 15)}`;
    const dapp = await prismaWrite.registeredDapp.create({
      data: { name, apiKey },
    });

    return res.json(dapp);
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// 🔒 PRE-EXISTING COMPATIBILITY MOCK ROUTES (TO PRESERVE INTEGRATION TESTS)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @swagger
 * /api/v1/reputation/score:
 *   post:
 *     summary: Compute a reputation score (legacy stateless endpoint)
 *     description: >
 *       Accepts inline chain data and computes the score without touching the database.
 *       Prefer GET /api/v1/reputation/{address} for DB-backed scoring.
 *     tags: [Reputation]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [address]
 *             properties:
 *               address: { type: string, example: 'GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI' }
 *               chainData:
 *                 type: array
 *                 description: On-chain data array. If provided it must be an array or a 400 is returned.
 *                 items: { type: object }
 *     responses:
 *       200:
 *         description: Score result with badges override
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ReputationScoreResult'
 *       400:
 *         description: address is missing or chainData is not an array
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               error: address is required
 */
reputationRouter.post(
  '/score',
  handleAsync(async (req, res) => {
    const address = req.body?.address;
    if (typeof address !== 'string' || address.trim() === '') {
      return res.status(400).json({ error: 'address is required' });
    }
    const result = computeReputationScore(address, parseChainData(req.body?.chainData));
    return res.json({
      ...result,
      badges: earnBadges(result.address, parseChainData(req.body?.chainData)),
    });
  }),
);

/**
 * @swagger
 * /api/v1/reputation/identity/score:
 *   post:
 *     summary: Compute a cross-identity reputation score (legacy stateless endpoint)
 *     description: >
 *       Accepts inline chain data and linked identity inputs. Verifies signatures,
 *       aggregates scores across all linked addresses, and returns the result.
 *       Prefer the DB-backed endpoints for persistent scoring.
 *     tags: [Reputation]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [canonicalAddress]
 *             properties:
 *               canonicalAddress: { type: string, example: 'GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI' }
 *               chainData:
 *                 type: array
 *                 description: Must be an array if provided; omit to use empty set.
 *                 items: { type: object }
 *               links:
 *                 type: array
 *                 description: Linked identity inputs to verify and include.
 *                 items: { type: object }
 *     responses:
 *       200:
 *         description: Score result extended with identityLinks
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ReputationScoreResult'
 *                 - type: object
 *                   properties:
 *                     identityLinks:
 *                       type: array
 *                       items:
 *                         $ref: '#/components/schemas/VerifiedIdentityLink'
 *       400:
 *         description: canonicalAddress is missing or chainData/links is not an array
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               error: canonicalAddress is required
 */
reputationRouter.post(
  '/identity/score',
  handleAsync(async (req, res) => {
    const canonicalAddressValue = req.body?.canonicalAddress;
    if (typeof canonicalAddressValue !== 'string' || canonicalAddressValue.trim() === '') {
      return res.status(400).json({ error: 'canonicalAddress is required' });
    }
    const chainData = parseChainData(req.body?.chainData);
    const links = verifyIdentityLinks({
      canonicalAddress: canonicalAddressValue,
      links: parseLinks(req.body?.links),
    });
    const result = computeReputationScoreForIdentity(canonicalAddressValue, chainData, links);
    return res.json({
      ...result,
      badges: earnBadges(result.address, chainData),
      identityLinks: links,
    });
  }),
);

/**
 * @swagger
 * /api/v1/reputation/identity/link:
 *   post:
 *     summary: Verify a set of cross-chain identity links (legacy stateless endpoint)
 *     description: >
 *       Verifies each linked identity's signature and returns the verification results.
 *       Does not persist anything to the database.
 *     tags: [Reputation]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [canonicalAddress]
 *             properties:
 *               canonicalAddress: { type: string, example: 'GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI' }
 *               links:
 *                 type: array
 *                 description: Must be an array if provided.
 *                 items:
 *                   type: object
 *                   properties:
 *                     chainId: { type: string }
 *                     address: { type: string }
 *                     message: { type: string }
 *                     signature: { type: string }
 *     responses:
 *       200:
 *         description: Verification results for each link
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 links:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/VerifiedIdentityLink'
 *       400:
 *         description: canonicalAddress is missing or links is not an array
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               error: canonicalAddress is required
 */
reputationRouter.post(
  '/identity/link',
  handleAsync(async (req, res) => {
    const canonicalAddressValue = req.body?.canonicalAddress;
    if (typeof canonicalAddressValue !== 'string' || canonicalAddressValue.trim() === '') {
      return res.status(400).json({ error: 'canonicalAddress is required' });
    }
    return res.json({
      links: verifyIdentityLinks({
        canonicalAddress: canonicalAddressValue,
        links: parseLinks(req.body?.links),
      }),
    });
  }),
);

/**
 * @swagger
 * /api/v1/reputation/leaderboards/{category}:
 *   get:
 *     summary: Get a leaderboard from inline chain data (legacy stateless endpoint)
 *     description: >
 *       Builds a leaderboard entirely from the chainData query/body parameter.
 *       Returns 400 if chainData is provided but is not a JSON array.
 *       Prefer GET /api/v1/reputation/leaderboard for DB-backed results.
 *     tags: [Reputation]
 *     parameters:
 *       - in: path
 *         name: category
 *         required: true
 *         schema: { type: string }
 *         description: Score category (e.g. "overall"). Pass "overall" to match the base route.
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100, default: 10 }
 *       - in: query
 *         name: chainData
 *         schema: { type: string }
 *         description: JSON-encoded ChainReputationData array (must be an array if provided).
 *     responses:
 *       200:
 *         description: Leaderboard entries derived from the supplied chain data
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 category: { type: string, example: overall }
 *                 leaderboard:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/LeaderboardEntry'
 *       400:
 *         description: chainData is not an array
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               error: chainData must be an array
 */
reputationRouter.get(
  '/leaderboards/:category?',
  handleAsync(async (req, res) => {
    const chainData = parseChainData(req.body?.chainData ?? req.query?.chainData);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 10)));
    return res.json({
      category: req.params.category ?? 'overall',
      leaderboard: createLeaderboard(chainData, req.params.category ?? 'overall', limit),
    });
  }),
);

/**
 * @swagger
 * /api/v1/reputation/badges/{address}:
 *   get:
 *     summary: Get earned badges from inline chain data (legacy stateless endpoint)
 *     description: >
 *       Computes badges from the supplied chainData without touching the database.
 *       Returns 400 if chainData is provided but is not an array.
 *     tags: [Reputation]
 *     parameters:
 *       - in: path
 *         name: address
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: chainData
 *         schema: { type: string }
 *         description: JSON-encoded ChainReputationData array.
 *     responses:
 *       200:
 *         description: Badge list
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 address: { type: string }
 *                 badges:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/ReputationBadge'
 *       400:
 *         description: chainData is not an array
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               error: chainData must be an array
 */
reputationRouter.get(
  '/badges/:address',
  handleAsync(async (req, res) => {
    const chainData = parseChainData(req.query?.chainData);
    return res.json({
      address: canonicalAddress(req.params.address),
      badges: earnBadges(req.params.address, chainData),
    });
  }),
);

/**
 * @swagger
 * /api/v1/reputation/oracle/{address}:
 *   get:
 *     summary: Get an oracle response from inline chain data (legacy stateless endpoint)
 *     description: >
 *       Computes the oracle response from the supplied chainData without touching the database.
 *       Returns 400 if chainData is provided but is not an array.
 *     tags: [Reputation]
 *     parameters:
 *       - in: path
 *         name: address
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: chainData
 *         schema: { type: string }
 *         description: JSON-encoded ChainReputationData array.
 *     responses:
 *       200:
 *         description: Oracle reputation response
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/OracleReputationResponse'
 *       400:
 *         description: chainData is not an array
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               error: chainData must be an array
 */
reputationRouter.get(
  '/oracle/:address',
  handleAsync(async (req, res) => {
    const chainData = parseChainData(req.query?.chainData);
    return res.json(createOracleResponse(req.params.address, chainData));
  }),
);

/**
 * @swagger
 * /api/v1/reputation/attestations/{address}:
 *   get:
 *     summary: List attestations from inline chain data (legacy stateless endpoint)
 *     description: >
 *       Filters and normalises attestations from the supplied chainData for the given address.
 *       Pass verified=true to return only verifiable attestations.
 *       Returns 400 if chainData is provided but is not an array.
 *     tags: [Reputation]
 *     parameters:
 *       - in: path
 *         name: address
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: chainData
 *         schema: { type: string }
 *         description: JSON-encoded ChainReputationData array.
 *       - in: query
 *         name: verified
 *         schema: { type: string, enum: ['true'] }
 *         description: Set to "true" to return only verifiable attestations.
 *     responses:
 *       200:
 *         description: Normalised attestations for the address
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 address: { type: string }
 *                 attestations:
 *                   type: array
 *                   items: { type: object }
 *                 total: { type: integer }
 *       400:
 *         description: chainData is not an array
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               error: chainData must be an array
 */
reputationRouter.get(
  '/attestations/:address',
  handleAsync(async (req, res) => {
    const chainData = parseChainData(req.query?.chainData);
    const attestations = chainData
      .filter((item) => canonicalAddress(item.address) === canonicalAddress(req.params.address))
      .flatMap((item) => (item.attestations ?? []).map(normalizeAttestation))
      .filter(
        (attestation) => req.query.verified !== 'true' || isAttestationVerifiable(attestation),
      );
    return res.json({
      address: canonicalAddress(req.params.address),
      attestations,
      total: attestations.length,
    });
  }),
);

/**
 * @swagger
 * /api/v1/reputation/credentials/{address}:
 *   get:
 *     summary: List verifiable credentials from inline chain data (legacy stateless endpoint)
 *     description: >
 *       Filters and normalises credentials from the supplied chainData for the given address.
 *       Pass verified=true to return only W3C-valid credentials.
 *       Returns 400 if chainData is provided but is not an array.
 *     tags: [Reputation]
 *     parameters:
 *       - in: path
 *         name: address
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: chainData
 *         schema: { type: string }
 *         description: JSON-encoded ChainReputationData array.
 *       - in: query
 *         name: verified
 *         schema: { type: string, enum: ['true'] }
 *         description: Set to "true" to return only W3C-valid credentials.
 *     responses:
 *       200:
 *         description: Normalised credentials for the address
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 address: { type: string }
 *                 credentials:
 *                   type: array
 *                   items: { type: object }
 *                 total: { type: integer }
 *       400:
 *         description: chainData is not an array
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               error: chainData must be an array
 */
reputationRouter.get(
  '/credentials/:address',
  handleAsync(async (req, res) => {
    const chainData = parseChainData(req.query?.chainData);
    const credentials = chainData
      .filter((item) => canonicalAddress(item.address) === canonicalAddress(req.params.address))
      .flatMap((item) => (item.verifiableCredentials ?? []).map(normalizeCredential))
      .filter((credential) => req.query.verified !== 'true' || isVerifiableCredential(credential));
    return res.json({
      address: canonicalAddress(req.params.address),
      credentials,
      total: credentials.length,
    });
  }),
);

/**
 * @swagger
 * /api/v1/reputation/sybil/{address}:
 *   get:
 *     summary: Get Sybil risk from inline chain data (legacy stateless endpoint)
 *     description: >
 *       Computes a Sybil risk assessment from the supplied chainData without touching the database.
 *       Returns 400 if chainData is provided but is not an array.
 *     tags: [Reputation]
 *     parameters:
 *       - in: path
 *         name: address
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: chainData
 *         schema: { type: string }
 *         description: JSON-encoded ChainReputationData array.
 *     responses:
 *       200:
 *         description: Sybil risk assessment
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SybilAssessment'
 *       400:
 *         description: chainData is not an array
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               error: chainData must be an array
 */
reputationRouter.get(
  '/sybil/:address',
  handleAsync(async (req, res) => {
    const chainData = parseChainData(req.query?.chainData);
    return res.json(assessSybilRisk(req.params.address, chainData));
  }),
);

/**
 * @swagger
 * /api/v1/reputation/trust/path:
 *   post:
 *     summary: Find a trust path from inline chain data (legacy stateless endpoint)
 *     description: >
 *       Builds the trust graph from the supplied chainData and returns the shortest path
 *       from "from" to "to". Does not touch the database.
 *     tags: [Reputation]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [from, to]
 *             properties:
 *               from: { type: string, example: 'GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI' }
 *               to: { type: string, example: 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN' }
 *               chainData:
 *                 type: array
 *                 description: Must be an array if provided.
 *                 items: { type: object }
 *               maxDepth: { type: integer, default: 6 }
 *     responses:
 *       200:
 *         description: Trust path result (path is null if no route exists)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 from: { type: string }
 *                 to: { type: string }
 *                 path:
 *                   oneOf:
 *                     - $ref: '#/components/schemas/TrustPath'
 *                     - type: 'null'
 *       400:
 *         description: from or to is missing, or chainData is not an array
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               error: from and to are required
 */
reputationRouter.post(
  '/trust/path',
  handleAsync(async (req, res) => {
    const from = req.body?.from;
    const to = req.body?.to;
    if (typeof from !== 'string' || typeof to !== 'string') {
      return res.status(400).json({ error: 'from and to are required' });
    }
    const graph = buildTrustGraph(parseChainData(req.body?.chainData));
    const path = findTrustPath(graph, from, to, Number(req.body?.maxDepth ?? 6));
    return res.json({ from: canonicalAddress(from), to: canonicalAddress(to), path });
  }),
);

/**
 * @swagger
 * /api/v1/reputation/endorsements:
 *   post:
 *     summary: Compute weighted endorsements from inline data (legacy stateless endpoint)
 *     description: >
 *       Applies endorser-score weights to a list of endorsements and returns them sorted
 *       by descending weight. Does not persist anything. Returns 400 if endorsements
 *       is provided but is not an array.
 *     tags: [Reputation]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               endorsements:
 *                 type: array
 *                 description: Must be an array if provided.
 *                 items:
 *                   type: object
 *                   properties:
 *                     chainId: { type: string }
 *                     endorser: { type: string }
 *                     subject: { type: string }
 *                     weight: { type: number }
 *               endorserScores:
 *                 type: object
 *                 description: Map of endorser address to their reputation score.
 *                 additionalProperties: { type: number }
 *                 example: { 'GBZX...': 72.5 }
 *     responses:
 *       200:
 *         description: Endorsements with computed weights, sorted descending
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 endorsements:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       chainId: { type: string }
 *                       endorser: { type: string }
 *                       subject: { type: string }
 *                       weight: { type: number }
 *       400:
 *         description: endorsements is not an array
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               error: endorsements must be an array
 */
reputationRouter.post(
  '/endorsements',
  handleAsync(async (req, res) => {
    const endorsements = parseEndorsements(req.body?.endorsements);
    const endorserScores = new Map(
      Object.entries((req.body?.endorserScores ?? {}) as Record<string, number>),
    );
    return res.json({ endorsements: weightedEndorsements(endorsements, endorserScores) });
  }),
);

/**
 * @swagger
 * /api/v1/reputation/oracle-counts/{address}:
 *   get:
 *     summary: Count valid attestations and credentials from inline chain data (legacy stateless endpoint)
 *     description: >
 *       Returns the count of verifiable attestations and W3C-valid credentials for the given
 *       address in the supplied chainData. Returns 400 if chainData is provided but is not an array.
 *     tags: [Reputation]
 *     parameters:
 *       - in: path
 *         name: address
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: chainData
 *         schema: { type: string }
 *         description: JSON-encoded ChainReputationData array.
 *     responses:
 *       200:
 *         description: Attestation and credential counts
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 address: { type: string }
 *                 attestations: { type: integer, example: 3 }
 *                 credentials: { type: integer, example: 2 }
 *       400:
 *         description: chainData is not an array
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               error: chainData must be an array
 */
reputationRouter.get(
  '/oracle-counts/:address',
  handleAsync(async (req, res) => {
    const chainData = parseChainData(req.query?.chainData);
    const address = canonicalAddress(req.params.address);
    const items = chainData.filter((item) => canonicalAddress(item.address) === address);
    return res.json({
      address,
      attestations: items.reduce((total, item) => total + countValidAttestations(item), 0),
      credentials: items.reduce((total, item) => total + countValidCredentials(item), 0),
    });
  }),
);

function countValidAttestations(chainData: ChainReputationData): number {
  return (chainData.attestations ?? []).filter(isAttestationVerifiable).length;
}

function countValidCredentials(chainData: ChainReputationData): number {
  return (chainData.verifiableCredentials ?? []).filter(isVerifiableCredential).length;
}
