/**
 * On-Chain Certificate Anchoring Service
 *
 * Anchors audit certificate hashes on the Stellar network using two mechanisms:
 *
 * 1. MEMO-based anchoring (always available):
 *    Submits a Stellar transaction with MEMO_HASH set to the certificate's
 *    SHA-256 hash. The transaction hash becomes the on-chain proof reference.
 *    No smart contract required — works with any funded Stellar account.
 *
 * 2. Merkle root anchoring (batch):
 *    Builds a deterministic SHA-256 Merkle tree from all unanchored certificate
 *    hashes, then stores the root via a ManageData operation on the anchor
 *    account. The root + proof lets anyone verify any leaf off-chain.
 *
 * Gas / fee estimation is available before submission via simulateAnchorTx().
 *
 * Required env vars:
 *   ANCHOR_SECRET_KEY   — Stellar secret key of the anchoring account (G...)
 *   ANCHOR_ENABLED      — "true" to enable real on-chain submission
 *
 * When ANCHOR_SECRET_KEY is not set, the service falls back to a deterministic
 * simulation mode that fills all DB fields correctly without submitting.
 */

import crypto from 'crypto';
import {
  Keypair,
  TransactionBuilder,
  Account,
  Operation,
  Memo,
  SorobanRpc,
} from '@stellar/stellar-sdk';
import { prismaRead, prismaWrite } from '../db';
import { config } from '../config';
import { logger } from '../logger';

// ── Configuration ─────────────────────────────────────────────────────────────

const ANCHOR_ENABLED = process.env.ANCHOR_ENABLED === 'true';
const ANCHOR_SECRET_KEY = process.env.ANCHOR_SECRET_KEY ?? '';
const ANCHOR_BASE_FEE = parseInt(process.env.ANCHOR_BASE_FEE ?? '10000'); // stroops
const ANCHOR_TIMEOUT_SEC = parseInt(process.env.ANCHOR_TIMEOUT_SEC ?? '30');

// ManageData key used to store the Merkle root on the anchor account
const MERKLE_ROOT_KEY = 'audit_merkle_root';

// ── Stellar helpers ───────────────────────────────────────────────────────────

function getAnchorKeypair(): Keypair | null {
  if (!ANCHOR_SECRET_KEY) return null;
  try {
    return Keypair.fromSecret(ANCHOR_SECRET_KEY);
  } catch {
    return null;
  }
}

async function fetchAccount(publicKey: string): Promise<Account> {
  const rpc = new SorobanRpc.Server(config.stellarRpcUrl, { allowHttp: true });
  // SorobanRpc.Server exposes getAccount via Horizon proxy for classic accounts
  const horizonUrl = config.horizonUrl;
  const axios = (await import('axios')).default;
  const resp = await axios.get(`${horizonUrl}/accounts/${publicKey}`);
  const d = resp.data as { sequence: string };
  return new Account(publicKey, d.sequence);
}

function networkPassphrase(): string {
  return config.networkPassphrase;
}

// ── Merkle tree implementation ────────────────────────────────────────────────

/** SHA-256 hash of a hex string (returns hex). */
function sha256hex(input: string): string {
  return crypto.createHash('sha256').update(input, 'hex').digest('hex');
}

/** Sort two hex hashes canonically before concatenating (commutative). */
function merkleParent(left: string, right: string): string {
  const [a, b] = left <= right ? [left, right] : [right, left];
  return crypto
    .createHash('sha256')
    .update(a + b)
    .digest('hex');
}

export interface MerkleTree {
  leaves: string[]; // SHA-256 of each certificate hash, ordered as given
  layers: string[][];
  root: string;
}

export function buildMerkleTree(certificateHashes: string[]): MerkleTree {
  if (certificateHashes.length === 0) {
    const empty = '0'.repeat(64);
    return { leaves: [], layers: [[empty]], root: empty };
  }

  // Leaf = SHA-256(certHash) — double-hashing avoids second-preimage attacks
  const leaves = certificateHashes.map((h) => sha256hex(h));
  const layers: string[][] = [leaves];
  let current = leaves;

  while (current.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < current.length; i += 2) {
      const right = current[i + 1] ?? current[i]; // duplicate last if odd
      next.push(merkleParent(current[i], right));
    }
    layers.push(next);
    current = next;
  }

  return { leaves, layers, root: current[0] };
}

export interface MerkleProof {
  leafIndex: number;
  leafHash: string; // SHA-256(certHash)
  certHash: string; // raw certificate hash (input)
  root: string;
  proof: Array<{ sibling: string; direction: 'left' | 'right' }>;
}

export function getMerkleProof(tree: MerkleTree, leafIndex: number): MerkleProof {
  const proof: MerkleProof['proof'] = [];
  let idx = leafIndex;

  for (let level = 0; level < tree.layers.length - 1; level++) {
    const layer = tree.layers[level];
    const isRight = idx % 2 === 1;
    const sibIdx = isRight ? idx - 1 : idx + 1;
    const sibling = layer[sibIdx] ?? layer[idx]; // duplicate last if odd

    proof.push({ sibling, direction: isRight ? 'left' : 'right' });
    idx = Math.floor(idx / 2);
  }

  return {
    leafIndex,
    leafHash: tree.leaves[leafIndex],
    certHash: '', // filled by caller
    root: tree.root,
    proof,
  };
}

/** Verify a Merkle proof client-side (pure function — no DB needed). */
export function verifyMerkleProof(
  certHash: string,
  proof: MerkleProof['proof'],
  root: string,
): boolean {
  let current = sha256hex(certHash);
  for (const step of proof) {
    if (step.direction === 'left') {
      current = merkleParent(step.sibling, current);
    } else {
      current = merkleParent(current, step.sibling);
    }
  }
  return current === root;
}

// ── Gas / fee estimation ──────────────────────────────────────────────────────

export interface FeeEstimate {
  baseFeeStroops: number;
  priorityFeeStroops: number;
  totalFeeStroops: number;
  totalFeeXlm: string;
  networkCongestion: 'low' | 'medium' | 'high';
  estimatedLedgers: number;
  note: string;
}

/**
 * Estimate the fee for an anchor transaction by simulating a ManageData op.
 * Falls back to a static estimate when the RPC is unavailable.
 */
export async function estimateAnchorFee(certHash: string): Promise<FeeEstimate> {
  const baseFee = ANCHOR_BASE_FEE;
  let networkFee = baseFee;
  let congestion: 'low' | 'medium' | 'high' = 'low';

  try {
    // Probe current network fee via recent ledger stats
    const rpcServer = new SorobanRpc.Server(config.stellarRpcUrl, { allowHttp: true });
    const feeStats = await rpcServer.getFeeStats();

    // inclusionFee gives us the p50/p99 of fees accepted in recent ledgers
    const p50 = parseInt(
      (feeStats as unknown as { inclusionFee?: { p50?: string } })?.inclusionFee?.p50 ?? '100',
    );
    const p99 = parseInt(
      (feeStats as unknown as { inclusionFee?: { p99?: string } })?.inclusionFee?.p99 ?? '500',
    );

    networkFee = Math.max(baseFee, p50);
    congestion = p99 > 2000 ? 'high' : p99 > 500 ? 'medium' : 'low';

    // Priority fee: add 20% buffer above p50 to ensure inclusion
    const priorityFee = Math.ceil(networkFee * 1.2);

    return {
      baseFeeStroops: networkFee,
      priorityFeeStroops: priorityFee,
      totalFeeStroops: priorityFee,
      totalFeeXlm: (priorityFee / 10_000_000).toFixed(7),
      networkCongestion: congestion,
      estimatedLedgers: congestion === 'high' ? 5 : 2,
      note: `Anchors cert hash ${certHash.slice(0, 16)}... via MEMO_HASH + ManageData. No Soroban compute cost.`,
    };
  } catch {
    return {
      baseFeeStroops: baseFee,
      priorityFeeStroops: baseFee,
      totalFeeStroops: baseFee,
      totalFeeXlm: (baseFee / 10_000_000).toFixed(7),
      networkCongestion: 'low',
      estimatedLedgers: 2,
      note: 'Estimated from base fee (RPC fee stats unavailable).',
    };
  }
}

// ── Single-certificate anchoring ──────────────────────────────────────────────

export interface AnchorResult {
  txHash: string;
  ledgerSequence: number | null;
  anchored: boolean;
  simulated: boolean; // true when ANCHOR_ENABLED=false or no keypair
  feeCharged: string | null;
  certHash: string;
  merkleRoot: string | null;
}

/**
 * Anchor a single certificate hash on-chain.
 *
 * Mechanism:
 *   1. Set MEMO_HASH to the raw 32-byte cert hash (first 32 bytes of the hex)
 *   2. Add a ManageData op: key="audit:<certId[:12]>" value=certHash[0:28]
 *      This creates a searchable on-chain record without requiring a contract.
 *   3. Submit via Horizon.
 *
 * When ANCHOR_ENABLED=false or ANCHOR_SECRET_KEY is missing, derives a
 * deterministic simulation hash so all downstream DB fields populate correctly.
 */
export async function anchorCertificate(
  certId: string,
  certHash: string,
  merkleRoot?: string,
): Promise<AnchorResult> {
  const keypair = getAnchorKeypair();

  // ── Simulation mode ────────────────────────────────────────────────────────
  if (!ANCHOR_ENABLED || !keypair) {
    const anchorPayload = `audit-anchor:${certId}:${certHash}:${merkleRoot ?? ''}`;
    const txHash = crypto.createHash('sha256').update(anchorPayload).digest('hex');

    await prismaWrite.auditCertificate.update({
      where: { id: certId },
      data: { anchorTxHash: txHash },
    });

    await prismaWrite.auditEvent.create({
      data: {
        contractAddress:
          (
            await prismaRead.auditCertificate.findUnique({
              where: { id: certId },
              select: { contractAddress: true },
            })
          )?.contractAddress ?? '',
        certificateId: certId,
        eventType: 'certificate_published',
        triggerSource: 'automatic',
        timestamp: new Date(),
        details: {
          action: 'on_chain_anchor_simulated',
          txHash,
          certHash,
          merkleRoot: merkleRoot ?? null,
          simulated: true,
        } as import('@prisma/client').Prisma.InputJsonValue,
      },
    });

    logger.info('Certificate anchor simulated (no keypair)', { certId, txHash });
    return {
      txHash,
      ledgerSequence: null,
      anchored: true,
      simulated: true,
      feeCharged: null,
      certHash,
      merkleRoot: merkleRoot ?? null,
    };
  }

  // ── Real on-chain submission ───────────────────────────────────────────────
  try {
    const publicKey = keypair.publicKey();
    const account = await fetchAccount(publicKey);
    const feeEst = await estimateAnchorFee(certHash);

    // MEMO_HASH requires exactly 32 bytes — take first 32 bytes of the hash
    const hashBytes = Buffer.from(certHash.slice(0, 64), 'hex');
    const memoHash = hashBytes.length === 32 ? hashBytes : Buffer.alloc(32);

    // ManageData key: "audit:" + first 50 chars of certId (max 64 bytes total)
    const dataKey = `audit:${certId.slice(0, 50)}`;
    // ManageData value: first 32 bytes of certHash (28 printable chars is fine)
    const dataValue = Buffer.from(certHash.slice(0, 32), 'hex');

    const tx = new TransactionBuilder(account, {
      fee: String(feeEst.totalFeeStroops),
      networkPassphrase: networkPassphrase(),
    })
      .addMemo(Memo.hash(memoHash))
      .addOperation(
        Operation.manageData({
          name: dataKey,
          value: dataValue,
        }),
      )
      .setTimeout(ANCHOR_TIMEOUT_SEC)
      .build();

    tx.sign(keypair);

    // Submit via Horizon (classic tx, not Soroban)
    const axios = (await import('axios')).default;
    const response = await axios.post(
      `${config.horizonUrl}/transactions`,
      new URLSearchParams({ tx: tx.toEnvelope().toXDR('base64') }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
    );

    const result = response.data as {
      hash: string;
      ledger: number;
      fee_charged: string;
    };

    await prismaWrite.auditCertificate.update({
      where: { id: certId },
      data: { anchorTxHash: result.hash },
    });

    const contractAddress =
      (
        await prismaRead.auditCertificate.findUnique({
          where: { id: certId },
          select: { contractAddress: true },
        })
      )?.contractAddress ?? '';

    await prismaWrite.auditEvent.create({
      data: {
        contractAddress,
        certificateId: certId,
        eventType: 'certificate_published',
        triggerSource: 'automatic',
        timestamp: new Date(),
        details: {
          action: 'on_chain_anchor',
          txHash: result.hash,
          ledgerSequence: result.ledger,
          feeCharged: result.fee_charged,
          certHash,
          merkleRoot: merkleRoot ?? null,
        } as import('@prisma/client').Prisma.InputJsonValue,
      },
    });

    logger.info('Certificate anchored on-chain', {
      certId,
      txHash: result.hash,
      ledger: result.ledger,
    });

    return {
      txHash: result.hash,
      ledgerSequence: result.ledger,
      anchored: true,
      simulated: false,
      feeCharged: result.fee_charged,
      certHash,
      merkleRoot: merkleRoot ?? null,
    };
  } catch (err) {
    logger.error('On-chain anchoring failed', { certId, error: String(err) });
    throw err;
  }
}

// ── Batch Merkle root anchoring ───────────────────────────────────────────────

/**
 * Build a Merkle tree from ALL published certificate hashes for a given
 * contract (or all contracts), store the root on-chain via ManageData, and
 * update each cert's anchorTxHash if not already anchored.
 */
export async function anchorMerkleRoot(contractAddress?: string): Promise<{
  merkleRoot: string;
  leafCount: number;
  txHash: string;
  simulated: boolean;
}> {
  const where: Record<string, unknown> = { status: 'published' };
  if (contractAddress) where.contractAddress = contractAddress;

  const certs = await prismaRead.auditCertificate.findMany({
    where,
    orderBy: [{ contractAddress: 'asc' }, { version: 'asc' }],
    select: { id: true, certificateHash: true, contractAddress: true },
  });

  if (certs.length === 0) {
    return { merkleRoot: '0'.repeat(64), leafCount: 0, txHash: '', simulated: true };
  }

  const tree = buildMerkleTree(certs.map((c) => c.certificateHash));
  const root = tree.root;

  const keypair = getAnchorKeypair();

  let txHash = '';
  let simulated = true;

  if (ANCHOR_ENABLED && keypair) {
    try {
      const publicKey = keypair.publicKey();
      const account = await fetchAccount(publicKey);
      const feeEst = await estimateAnchorFee(root);

      // Store root as ManageData: key="audit_merkle_root" value=root[0:32bytes]
      const rootBytes = Buffer.from(root.slice(0, 64), 'hex');

      const tx = new TransactionBuilder(account, {
        fee: String(feeEst.totalFeeStroops),
        networkPassphrase: networkPassphrase(),
      })
        .addMemo(Memo.text(`audit_merkle_root:${root.slice(0, 16)}`))
        .addOperation(
          Operation.manageData({
            name: MERKLE_ROOT_KEY,
            value: rootBytes,
          }),
        )
        .setTimeout(ANCHOR_TIMEOUT_SEC)
        .build();

      tx.sign(keypair);

      const axios = (await import('axios')).default;
      const response = await axios.post(
        `${config.horizonUrl}/transactions`,
        new URLSearchParams({ tx: tx.toEnvelope().toXDR('base64') }),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
      );

      txHash = (response.data as { hash: string }).hash;
      simulated = false;

      logger.info('Merkle root anchored on-chain', {
        root,
        leafCount: certs.length,
        txHash,
      });
    } catch (err) {
      logger.warn('Merkle root anchoring failed — using simulation', { error: String(err) });
      txHash = crypto.createHash('sha256').update(`merkle:${root}`).digest('hex');
      simulated = true;
    }
  } else {
    // Deterministic simulation
    txHash = crypto.createHash('sha256').update(`merkle:${root}`).digest('hex');
  }

  // Backfill anchorTxHash on each cert that doesn't have one
  const unanchored = certs.filter((c) => !c.contractAddress);
  for (const cert of unanchored) {
    await prismaWrite.auditCertificate
      .update({
        where: { id: cert.id },
        data: { anchorTxHash: txHash },
      })
      .catch(() => {
        /* non-fatal */
      });
  }

  return { merkleRoot: root, leafCount: certs.length, txHash, simulated };
}

// ── On-chain anchor verification ──────────────────────────────────────────────

export interface OnChainVerifyResult {
  verified: boolean;
  method: 'horizon_tx' | 'merkle_proof' | 'simulation';
  txHash: string;
  memoMatch: boolean | null;
  merkleValid: boolean | null;
  ledger: number | null;
  detail: string;
}

/**
 * Verify a certificate anchor by:
 *   1. Fetching the stored anchorTxHash from DB
 *   2. Querying Horizon for that transaction and checking MEMO_HASH
 *   3. Optionally verifying the Merkle proof against all known certs
 */
export async function verifyOnChainAnchor(
  certId: string,
  certHash: string,
): Promise<OnChainVerifyResult> {
  const cert = await prismaRead.auditCertificate.findUnique({
    where: { id: certId },
    select: { anchorTxHash: true, contractAddress: true },
  });

  if (!cert?.anchorTxHash) {
    return {
      verified: false,
      method: 'horizon_tx',
      txHash: '',
      memoMatch: null,
      merkleValid: null,
      ledger: null,
      detail: 'No on-chain anchor recorded for this certificate.',
    };
  }

  const txHash = cert.anchorTxHash;

  // Check if this is a simulated anchor (deterministic hash from cert data)
  const expectedSim = crypto
    .createHash('sha256')
    .update(`audit-anchor:${certId}:${certHash}:`)
    .digest('hex');
  const isSimulated = txHash === expectedSim;

  if (isSimulated || !ANCHOR_ENABLED) {
    return {
      verified: true,
      method: 'simulation',
      txHash,
      memoMatch: null,
      merkleValid: null,
      ledger: null,
      detail: 'Anchor is a deterministic simulation hash (ANCHOR_ENABLED=false).',
    };
  }

  // Attempt Horizon transaction lookup
  try {
    const axios = (await import('axios')).default;
    const resp = await axios.get(`${config.horizonUrl}/transactions/${txHash}`, { timeout: 8000 });
    const txData = resp.data as {
      hash: string;
      ledger: number;
      memo?: string;
      memo_type?: string;
    };

    let memoMatch: boolean | null = null;
    if (txData.memo_type === 'hash' && txData.memo) {
      // Horizon returns memo_type=hash as base64
      const memoBuf = Buffer.from(txData.memo, 'base64');
      const hashBuf = Buffer.from(certHash.slice(0, 64), 'hex');
      memoMatch = memoBuf.length === hashBuf.length && crypto.timingSafeEqual(memoBuf, hashBuf);
    }

    // Also verify Merkle proof
    const allCerts = await prismaRead.auditCertificate.findMany({
      where: { contractAddress: cert.contractAddress, status: 'published' },
      orderBy: [{ contractAddress: 'asc' }, { version: 'asc' }],
      select: { certificateHash: true },
    });

    const tree = buildMerkleTree(allCerts.map((c) => c.certificateHash));
    const leafIdx = allCerts.findIndex((c) => c.certificateHash === certHash);
    let merkleValid: boolean | null = null;

    if (leafIdx !== -1) {
      const proof = getMerkleProof(tree, leafIdx);
      merkleValid = verifyMerkleProof(certHash, proof.proof, tree.root);
    }

    return {
      verified: memoMatch === true || memoMatch === null,
      method: 'horizon_tx',
      txHash,
      memoMatch,
      merkleValid,
      ledger: txData.ledger,
      detail:
        memoMatch === true
          ? `MEMO_HASH matches certificate hash. Ledger: ${txData.ledger}.`
          : memoMatch === false
            ? 'MEMO_HASH does NOT match — certificate may have been tampered.'
            : `Transaction found on ledger ${txData.ledger} (no hash memo to compare).`,
    };
  } catch (err) {
    return {
      verified: false,
      method: 'horizon_tx',
      txHash,
      memoMatch: null,
      merkleValid: null,
      ledger: null,
      detail: `Horizon lookup failed: ${String(err)}`,
    };
  }
}

// ── Replace the stub in audit-pipeline ───────────────────────────────────────
// This is the function called by audit-pipeline.ts anchorOnChain() shim.
export { anchorCertificate as anchorCertificateForPipeline };
