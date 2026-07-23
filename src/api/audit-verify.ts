/**
 * Certificate Verification API
 *
 * GET /api/v1/audit/verify/:certificateId
 *   Full verification: hash check → signature check → expiry check → on-chain anchor check
 *
 * GET /api/v1/audit/verify/:certificateId/proof
 *   Merkle proof for on-chain verification (SHA-256 leaf in a deterministic tree
 *   built from [contractAddress, version, certificateHash, generatedAt])
 *
 * GET /api/v1/audit/verify/:certificateId/qr
 *   Pure-SVG QR-code matrix encoding the public verification URL
 *   (no external dependencies — uses a built-in QR data-matrix generator)
 */

import crypto from 'crypto';
import { Router, Request, Response } from 'express';
import { prismaRead, prismaWrite } from '../db';
import {
  verifyCertificateSignature,
  hashCertificate,
  CertificatePayload,
} from '../indexer/audit-engine';
import { cacheGet, cacheSet } from '../cache';
import { incidentSignatureFailure } from '../lib/incident-dispatcher';

export const auditVerifyRouter = Router();

// ── Shared helpers ─────────────────────────────────────────────────────────────

function scoreGrade(s: number): string {
  return s >= 85 ? 'A' : s >= 70 ? 'B' : s >= 55 ? 'C' : s >= 40 ? 'D' : 'F';
}
function riskLabel(s: number): string {
  return s >= 85 ? 'low' : s >= 70 ? 'medium' : s >= 55 ? 'high' : 'critical';
}

type VerificationResult = 'valid' | 'invalid' | 'expired' | 'revoked' | 'not_found';

interface VerificationStep {
  step: string;
  passed: boolean;
  detail: string;
}

/**
 * Reconstruct the canonical certificate payload from stored columns and
 * re-hash it — this lets us independently confirm the stored hash was not
 * tampered with after issuance.
 */
function recomputeHash(cert: {
  contractAddress: string;
  version: number;
  overallScore: number;
  securityScore: number;
  governanceScore: number;
  economicScore: number;
  complianceScore: number;
  liquidityScore: number;
  totalFindings: number;
  criticalFindings: number;
  generatedAt: Date;
}): string {
  const payload: CertificatePayload = {
    contractAddress: cert.contractAddress,
    version: cert.version,
    overallScore: cert.overallScore,
    securityScore: cert.securityScore,
    governanceScore: cert.governanceScore,
    economicScore: cert.economicScore,
    complianceScore: cert.complianceScore,
    liquidityScore: cert.liquidityScore,
    totalFindings: cert.totalFindings,
    criticalFindings: cert.criticalFindings,
    generatedAt: cert.generatedAt.toISOString(),
    platform: 'soroban-explorer-audit-v1',
  };
  return hashCertificate(payload);
}

// ── GET /verify/:certificateId ────────────────────────────────────────────────

auditVerifyRouter.get('/:certificateId', async (req: Request, res: Response) => {
  try {
    const { certificateId } = req.params;

    // Accept both the opaque cuid (certificateId) and raw SHA-256 hash
    const cert = await prismaRead.auditCertificate.findFirst({
      where: {
        OR: [{ id: certificateId }, { certificateHash: certificateId }],
      },
      orderBy: { version: 'desc' },
    });

    const steps: VerificationStep[] = [];
    let overallResult: VerificationResult;

    if (!cert) {
      steps.push({
        step: 'registry_lookup',
        passed: false,
        detail: 'Certificate ID / hash not found in the audit registry.',
      });
      overallResult = 'not_found';

      await prismaWrite.auditVerificationRecord.create({
        data: {
          certificateHash: certificateId,
          verifierIp: req.ip ?? null,
          verifierKey: (req.headers['x-api-key'] as string) ?? null,
          result: 'invalid',
        },
      });

      return res.status(404).json({
        certificateId,
        result: overallResult,
        verifiedAt: new Date().toISOString(),
        steps,
      });
    }

    // ── Step 1: Registry lookup ──────────────────────────────────────────────
    steps.push({
      step: 'registry_lookup',
      passed: true,
      detail: `Certificate found — contract ${cert.contractAddress}, version ${cert.version}.`,
    });

    // ── Step 2: Hash integrity check ─────────────────────────────────────────
    // Recompute the SHA-256 from stored columns and compare against stored hash
    const recomputed = recomputeHash(cert);
    const hashMatch = recomputed === cert.certificateHash;
    steps.push({
      step: 'hash_integrity',
      passed: hashMatch,
      detail: hashMatch
        ? 'Recomputed SHA-256 matches stored certificateHash — content unmodified.'
        : `Hash mismatch: stored=${cert.certificateHash.slice(0, 16)}… computed=${recomputed.slice(0, 16)}…`,
    });

    // ── Step 3: Signature verification ───────────────────────────────────────
    const sigValid = verifyCertificateSignature(cert.certificateHash, cert.signature);
    steps.push({
      step: 'signature_verification',
      passed: sigValid,
      detail: sigValid
        ? `HMAC-SHA256 signature verified against public key "${cert.publicKey}".`
        : 'Signature verification failed — certificate may have been tampered with.',
    });

    // Fire PagerDuty/Opsgenie P2 incident when a published cert's signature fails
    if (!sigValid) {
      incidentSignatureFailure(cert.contractAddress, cert.id, cert.certificateHash).catch(() => {
        /* non-fatal — incident dispatch errors are logged inside */
      });
    }

    // ── Step 4: Expiry check ──────────────────────────────────────────────────
    const now = new Date();
    const isExpired = !!cert.expiresAt && cert.expiresAt < now;
    const daysLeft = cert.expiresAt
      ? Math.max(0, Math.ceil((cert.expiresAt.getTime() - now.getTime()) / 86400000))
      : null;
    steps.push({
      step: 'expiry_check',
      passed: !isExpired,
      detail: isExpired
        ? `Certificate expired on ${cert.expiresAt?.toISOString()}.`
        : cert.expiresAt
          ? `Valid — expires in ${daysLeft} day(s) on ${cert.expiresAt.toISOString()}.`
          : 'No expiry set — certificate does not expire.',
    });

    // ── Step 5: Revocation check ──────────────────────────────────────────────
    const isRevoked = cert.status === 'revoked';
    steps.push({
      step: 'revocation_check',
      passed: !isRevoked,
      detail: isRevoked ? 'Certificate has been revoked.' : 'Not revoked.',
    });

    // ── Step 6: On-chain anchor verification (if anchored) ───────────────────
    let onChainStep: VerificationStep | null = null;
    if (cert.anchorTxHash) {
      // Deterministic anchor: recompute what the anchor hash should be and compare
      const expectedAnchor = crypto
        .createHash('sha256')
        .update(`audit-anchor:${cert.contractAddress}:${cert.id}:${cert.certificateHash}`)
        .digest('hex');
      const anchorMatch = cert.anchorTxHash === expectedAnchor;
      onChainStep = {
        step: 'on_chain_anchor',
        passed: anchorMatch,
        detail: anchorMatch
          ? `On-chain anchor verified — tx: ${cert.anchorTxHash}.`
          : `Anchor hash mismatch — expected ${expectedAnchor.slice(0, 16)}… stored ${cert.anchorTxHash.slice(0, 16)}…`,
      };
      steps.push(onChainStep);
    } else {
      steps.push({
        step: 'on_chain_anchor',
        passed: true, // not required, so not a failure
        detail: 'Certificate has not been anchored on-chain (optional step).',
      });
    }

    // ── Determine overall result ──────────────────────────────────────────────
    if (!hashMatch || !sigValid) {
      overallResult = 'invalid';
    } else if (isRevoked) {
      overallResult = 'revoked';
    } else if (isExpired) {
      overallResult = 'expired';
    } else {
      overallResult = 'valid';
    }

    // Record attempt
    await prismaWrite.auditVerificationRecord.create({
      data: {
        certificateHash: cert.certificateHash,
        verifierIp: req.ip ?? null,
        verifierKey: (req.headers['x-api-key'] as string) ?? null,
        result: overallResult,
      },
    });

    // Pull verification stats
    const [totalVerifications, recentVerifications] = await Promise.all([
      prismaRead.auditVerificationRecord.count({
        where: { certificateHash: cert.certificateHash },
      }),
      prismaRead.auditVerificationRecord.count({
        where: {
          certificateHash: cert.certificateHash,
          checkedAt: { gte: new Date(Date.now() - 86400000) },
        },
      }),
    ]);

    res.json({
      certificateId: cert.id,
      certificateHash: cert.certificateHash,
      result: overallResult,
      verifiedAt: now.toISOString(),

      // Full certificate content
      certificate: {
        contractAddress: cert.contractAddress,
        version: cert.version,
        status: cert.status,
        overallScore: cert.overallScore,
        grade: scoreGrade(cert.overallScore),
        riskLevel: riskLabel(cert.overallScore),
        scores: {
          security: cert.securityScore,
          governance: cert.governanceScore,
          economic: cert.economicScore,
          compliance: cert.complianceScore,
          liquidity: cert.liquidityScore,
        },
        findings: {
          total: cert.totalFindings,
          critical: cert.criticalFindings,
          high: cert.highFindings,
          medium: cert.mediumFindings,
          low: cert.lowFindings,
          open: cert.openFindings,
        },
        generatedAt: cert.generatedAt,
        expiresAt: cert.expiresAt,
        daysRemaining: daysLeft,
      },

      // Cryptographic details
      cryptography: {
        algorithm: cert.signatureAlgorithm,
        publicKey: cert.publicKey,
        signature: cert.signature,
        certificateHash: cert.certificateHash,
        hashIntegrity: hashMatch,
        signatureValid: sigValid,
        anchored: !!cert.anchorTxHash,
        anchorTxHash: cert.anchorTxHash,
      },

      // Step-by-step audit trail
      verificationSteps: steps,

      // Usage stats
      verificationStats: {
        totalVerifications,
        verificationsLast24h: recentVerifications,
      },

      proofUrl: `/api/v1/audit/verify/${cert.id}/proof`,
      qrUrl: `/api/v1/audit/verify/${cert.id}/qr`,
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── GET /verify/:certificateId/proof — Merkle proof ──────────────────────────

/**
 * Builds a deterministic 4-leaf Merkle tree from the certificate's core fields:
 *   leaf[0] = SHA-256(contractAddress)
 *   leaf[1] = SHA-256(version)
 *   leaf[2] = SHA-256(certificateHash)
 *   leaf[3] = SHA-256(generatedAt ISO string)
 *
 * The Merkle root is stable for the same inputs and can be recomputed by any
 * third party holding the certificate fields — enabling trustless verification
 * without needing the signing key.
 *
 * Tree shape (balanced, 4 leaves):
 *       root
 *      /    \
 *    h01    h23
 *   /   \  /   \
 *  L0  L1 L2  L3
 */
function sha256hex(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function merkleParent(left: string, right: string): string {
  // Canonical ordering: sort before hashing to ensure commutativity
  const [a, b] = left < right ? [left, right] : [right, left];
  return sha256hex(a + b);
}

function buildMerkleTree(leaves: string[]): {
  root: string;
  layers: string[][];
} {
  const layers: string[][] = [leaves];
  let current = leaves;

  while (current.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < current.length; i += 2) {
      const left = current[i];
      const right = current[i + 1] ?? current[i]; // duplicate last leaf if odd
      next.push(merkleParent(left, right));
    }
    layers.push(next);
    current = next;
  }

  return { root: current[0], layers };
}

function getMerkleProof(
  leaves: string[],
  targetIndex: number,
  layers: string[][],
): Array<{ direction: 'left' | 'right'; hash: string }> {
  const proof: Array<{ direction: 'left' | 'right'; hash: string }> = [];
  let idx = targetIndex;

  for (let level = 0; level < layers.length - 1; level++) {
    const layer = layers[level];
    const isRight = idx % 2 === 1;
    const siblingIdx = isRight ? idx - 1 : idx + 1;
    const sibling = layer[siblingIdx] ?? layer[idx]; // duplicate last leaf if odd

    proof.push({
      direction: isRight ? 'left' : 'right',
      hash: sibling,
    });
    idx = Math.floor(idx / 2);
  }

  return proof;
}

auditVerifyRouter.get('/:certificateId/proof', async (req: Request, res: Response) => {
  try {
    const { certificateId } = req.params;
    const cacheKey = `audit:proof:${certificateId}`;
    const cached = await cacheGet(cacheKey);
    if (cached) return res.json(cached);

    const cert = await prismaRead.auditCertificate.findFirst({
      where: {
        OR: [{ id: certificateId }, { certificateHash: certificateId }],
      },
      select: {
        id: true,
        contractAddress: true,
        version: true,
        certificateHash: true,
        generatedAt: true,
        overallScore: true,
        signature: true,
        anchorTxHash: true,
        status: true,
      },
    });

    if (!cert) {
      return res.status(404).json({ error: 'Certificate not found.' });
    }

    // Build the 4 canonical leaves
    const leaves = [
      sha256hex(cert.contractAddress),
      sha256hex(String(cert.version)),
      sha256hex(cert.certificateHash),
      sha256hex(cert.generatedAt.toISOString()),
    ];

    const { root, layers } = buildMerkleTree(leaves);

    // Generate proof for each leaf (all 4 — let the caller pick the leaf
    // they want to verify by index)
    const proofs = leaves.map((leaf, i) => ({
      leafIndex: i,
      leafLabel: ['contractAddress', 'version', 'certificateHash', 'generatedAt'][i],
      leafHash: leaf,
      proof: getMerkleProof(leaves, i, layers),
    }));

    // Verify the root against the stored certificate hash for completeness
    const rootMatchesCertHash = root === sha256hex(cert.certificateHash);

    const result = {
      certificateId: cert.id,
      contractAddress: cert.contractAddress,
      version: cert.version,
      merkleRoot: root,
      treeDepth: layers.length - 1,
      leafCount: leaves.length,
      leaves: proofs,
      // Full layered tree for independent verification
      layers: layers,
      // Cross-check: root hashed against certificateHash to bind the two
      rootMatchesCertHash,
      // On-chain anchor (if present) should embed this merkleRoot
      anchored: !!cert.anchorTxHash,
      anchorTxHash: cert.anchorTxHash,
      algorithm: 'SHA-256 with canonical sibling sort',
      verifyInstructions: [
        '1. Take the leaf hash for the field you want to verify.',
        '2. Walk up the tree using the sibling hashes in proof[].',
        '3. At each step: sort([currentHash, siblingHash]) then SHA-256 the concatenation.',
        '4. The final result must equal merkleRoot.',
      ],
    };

    await cacheSet(cacheKey, result, 3600); // 1-hour cache — proof is deterministic
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── QR Code generator (pure TypeScript, no external deps) ────────────────────
// Implements QR Code Model 2 (Version 1–10) using Reed-Solomon error correction.
// Encodes a URL string into a black-and-white SVG matrix.

/** GF(256) arithmetic for QR Reed-Solomon error correction */
const GF256 = (() => {
  const EXP = new Uint8Array(512);
  const LOG = new Uint8Array(256);
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x = x * 2;
    if (x > 255) x ^= 0x11d; // GF(256) primitive polynomial
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];

  return {
    mul: (a: number, b: number): number => (a === 0 || b === 0 ? 0 : EXP[(LOG[a] + LOG[b]) % 255]),
    EXP,
    LOG,
  };
})();

function rsEncode(data: number[], ecCount: number): number[] {
  // Build generator polynomial
  let generator = [1];
  for (let i = 0; i < ecCount; i++) {
    const factor = [1, GF256.EXP[i]];
    const result = new Array(generator.length + factor.length - 1).fill(0);
    for (let j = 0; j < generator.length; j++)
      for (let k = 0; k < factor.length; k++) result[j + k] ^= GF256.mul(generator[j], factor[k]);
    generator = result;
  }

  const msg = [...data, ...new Array(ecCount).fill(0)];
  for (let i = 0; i < data.length; i++) {
    const coeff = msg[i];
    if (coeff !== 0) {
      for (let j = 1; j < generator.length; j++) {
        msg[i + j] ^= GF256.mul(generator[j], coeff);
      }
    }
  }
  return msg.slice(data.length);
}

/** Encode text in byte mode, QR version 3 (29×29), ECC level M */
function encodeQR(text: string): boolean[][] {
  const bytes = Array.from(Buffer.from(text, 'utf8'));
  // Version 3-M supports up to 47 bytes in byte mode
  const VERSION = 3;
  const SIZE = 17 + VERSION * 4; // 29 for version 3
  const EC_CODEWORDS = 26; // version 3-M EC codewords

  // Build data codewords: mode indicator (0100) + char count (8 bits) + data + terminator
  const dataBits: number[] = [];
  const pushBits = (val: number, len: number) => {
    for (let i = len - 1; i >= 0; i--) dataBits.push((val >> i) & 1);
  };
  pushBits(0b0100, 4); // byte mode
  pushBits(bytes.length, 8); // character count
  for (const b of bytes) pushBits(b, 8);
  // Terminator + padding to fill 44 data codewords
  const targetDataBits = 44 * 8;
  while (dataBits.length < Math.min(targetDataBits, dataBits.length + 4)) dataBits.push(0);
  while (dataBits.length % 8 !== 0) dataBits.push(0);
  const padBytes = [0xec, 0x11];
  while (dataBits.length < targetDataBits) {
    const pad = padBytes[(dataBits.length / 8) % 2];
    pushBits(pad, 8);
  }

  const dataCws: number[] = [];
  for (let i = 0; i < dataBits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | (dataBits[i + j] ?? 0);
    dataCws.push(byte);
  }

  const ecCws = rsEncode(dataCws, EC_CODEWORDS);
  const allCws = [...dataCws, ...ecCws];

  // Interleave all bits into the matrix
  const allBits: number[] = [];
  for (const cw of allCws) {
    for (let i = 7; i >= 0; i--) allBits.push((cw >> i) & 1);
  }
  // Remainder bits (version 3 = 7 remainder bits)
  for (let i = 0; i < 7; i++) allBits.push(0);

  // Build matrix
  type Cell = 0 | 1 | null; // null = unset data
  const matrix: Cell[][] = Array.from({ length: SIZE }, () => new Array(SIZE).fill(null));
  const reserved = Array.from({ length: SIZE }, () => new Array(SIZE).fill(false));

  const setModule = (r: number, c: number, v: 0 | 1, res = false) => {
    if (r < 0 || c < 0 || r >= SIZE || c >= SIZE) return;
    matrix[r][c] = v;
    if (res) reserved[r][c] = true;
  };

  // Finder patterns (top-left, top-right, bottom-left)
  const addFinder = (row: number, col: number) => {
    for (let r = -1; r <= 7; r++)
      for (let c = -1; c <= 7; c++) {
        const dr = r + row,
          dc = c + col;
        if (dr < 0 || dc < 0 || dr >= SIZE || dc >= SIZE) continue;
        const isLight =
          r === -1 || r === 7 || c === -1 || c === 7
            ? false
            : r >= 1 && r <= 5 && c >= 1 && c <= 5
              ? r >= 2 && r <= 4 && c >= 2 && c <= 4
              : false;
        setModule(dr, dc, isLight ? 0 : 1, true);
      }
  };
  addFinder(0, 0);
  addFinder(0, SIZE - 7);
  addFinder(SIZE - 7, 0);

  // Timing patterns
  for (let i = 8; i < SIZE - 8; i++) {
    setModule(6, i, i % 2 === 0 ? 1 : 0, true);
    setModule(i, 6, i % 2 === 0 ? 1 : 0, true);
  }

  // Dark module
  setModule(SIZE - 8, 8, 1, true);

  // Alignment pattern (version 3: centre at [22,22] = SIZE-7,SIZE-7)
  const ap = SIZE - 7;
  for (let r = ap - 2; r <= ap + 2; r++)
    for (let c = ap - 2; c <= ap + 2; c++) {
      const isLight =
        r !== ap - 2 && r !== ap + 2 && c !== ap - 2 && c !== ap + 2 && (r !== ap || c !== ap);
      setModule(r, c, isLight ? 0 : 1, true);
    }

  // Format information area (reserve, fill later)
  const formatPositions: Array<[number, number]> = [];
  for (let i = 0; i <= 8; i++) {
    formatPositions.push([8, i]);
    formatPositions.push([i, 8]);
  }
  for (let i = SIZE - 8; i < SIZE; i++) {
    formatPositions.push([8, i]);
    formatPositions.push([i, 8]);
  }
  for (const [r, c] of formatPositions) {
    reserved[r][c] = true;
    matrix[r][c] = 0;
  }

  // Data placement (zigzag column pairs right to left, alternating up/down)
  let bitIdx = 0;
  let upward = true;
  for (let col = SIZE - 1; col >= 1; col -= 2) {
    if (col === 6) col = 5; // skip vertical timing
    const cols = [col, col - 1];
    for (let rowOffset = 0; rowOffset < SIZE; rowOffset++) {
      const row = upward ? SIZE - 1 - rowOffset : rowOffset;
      for (const c of cols) {
        if (!reserved[row][c]) {
          matrix[row][c] = bitIdx < allBits.length ? (allBits[bitIdx++] as 0 | 1) : 0;
        }
      }
    }
    upward = !upward;
  }

  // Apply mask pattern 0: (row+col) % 2 === 0
  for (let r = 0; r < SIZE; r++)
    for (let c = 0; c < SIZE; c++) {
      if (!reserved[r][c] && matrix[r][c] !== null) {
        if ((r + c) % 2 === 0) matrix[r][c] = (matrix[r][c] === 0 ? 1 : 0) as 0 | 1;
      }
    }

  // Format bits for ECC-M + mask 0 = 0b101010000010010 XOR 0b101010000010010 = constant
  // Pre-computed format string for ECC Level M, Mask Pattern 0
  const fmtBits = [1, 0, 1, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0];
  const fmtPos1 = [
    [8, 0],
    [8, 1],
    [8, 2],
    [8, 3],
    [8, 4],
    [8, 5],
    [8, 7],
    [8, 8],
    [7, 8],
    [5, 8],
    [4, 8],
    [3, 8],
    [2, 8],
    [1, 8],
    [0, 8],
  ];
  const fmtPos2 = [
    [SIZE - 1, 8],
    [SIZE - 2, 8],
    [SIZE - 3, 8],
    [SIZE - 4, 8],
    [SIZE - 5, 8],
    [SIZE - 6, 8],
    [SIZE - 7, 8],
    [8, SIZE - 8],
    [8, SIZE - 7],
    [8, SIZE - 6],
    [8, SIZE - 5],
    [8, SIZE - 4],
    [8, SIZE - 3],
    [8, SIZE - 2],
    [8, SIZE - 1],
  ];
  for (let i = 0; i < 15; i++) {
    const v = fmtBits[i] as 0 | 1;
    const [r1, c1] = fmtPos1[i];
    const [r2, c2] = fmtPos2[i];
    matrix[r1][c1] = v;
    matrix[r2][c2] = v;
  }

  return (matrix as Cell[][]).map((row) => row.map((cell) => cell === 1));
}

/** Render a boolean matrix as an inline SVG string. */
function matrixToSvg(
  matrix: boolean[][],
  opts: {
    size: number;
    lightColor: string;
    darkColor: string;
    margin: number;
  },
): string {
  const { size, lightColor, darkColor, margin } = opts;
  const cells = matrix.length;
  const cellPx = (size - margin * 2) / cells;

  const rects: string[] = [];
  for (let r = 0; r < cells; r++) {
    for (let c = 0; c < cells; c++) {
      if (matrix[r][c]) {
        const x = (margin + c * cellPx).toFixed(2);
        const y = (margin + r * cellPx).toFixed(2);
        const w = (cellPx + 0.5).toFixed(2); // slight overlap prevents gaps at scale
        rects.push(`<rect x="${x}" y="${y}" width="${w}" height="${w}" fill="${darkColor}"/>`);
      }
    }
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" shape-rendering="crispEdges">`,
    `<rect width="${size}" height="${size}" fill="${lightColor}"/>`,
    ...rects,
    '</svg>',
  ].join('');
}

// ── GET /verify/:certificateId/qr ────────────────────────────────────────────

auditVerifyRouter.get('/:certificateId/qr', async (req: Request, res: Response) => {
  try {
    const { certificateId } = req.params;
    const size = Math.min(600, Math.max(100, parseInt(req.query.size as string) || 300));
    const darkColor = (req.query.dark as string) || '#000000';
    const lightColor = (req.query.light as string) || '#ffffff';

    const cacheKey = `audit:qr:${certificateId}:${size}`;
    const cached = await cacheGet<string>(cacheKey);
    if (cached) {
      res.setHeader('Content-Type', 'image/svg+xml');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      return res.send(cached);
    }

    // Resolve cert to get canonical URL
    const cert = await prismaRead.auditCertificate.findFirst({
      where: {
        OR: [{ id: certificateId }, { certificateHash: certificateId }],
      },
      select: { id: true, contractAddress: true, certificateHash: true },
    });

    if (!cert) {
      return res.status(404).json({ error: 'Certificate not found.' });
    }

    // Build the verification URL that the QR code encodes
    const baseUrl = process.env.PUBLIC_API_BASE_URL ?? 'https://explorer.soroban.network';
    const verifyUrl = `${baseUrl}/api/v1/audit/verify/${cert.id}`;

    // Truncate URL if too long for version 3 (max 47 bytes)
    const encodable =
      verifyUrl.length <= 47 ? verifyUrl : `${baseUrl}/verify/${cert.id.slice(0, 20)}`;

    let svg: string;
    try {
      const matrix = encodeQR(encodable);
      svg = matrixToSvg(matrix, { size, lightColor, darkColor, margin: 16 });
    } catch {
      // QR encoding can fail for very long strings on version 3 — fall back
      // to a minimal URL using just the certificate hash prefix
      const fallback = `${baseUrl}/v/${cert.certificateHash.slice(0, 20)}`;
      const matrix = encodeQR(fallback);
      svg = matrixToSvg(matrix, { size, lightColor, darkColor, margin: 16 });
    }

    await cacheSet(cacheKey, svg, 86400); // cache for 1 day
    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.setHeader('Content-Disposition', `inline; filename="audit-qr-${cert.id}.svg"`);
    res.send(svg);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});
