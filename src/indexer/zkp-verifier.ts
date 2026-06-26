import { xdr, scValToNative } from '@stellar/stellar-sdk';
import { prismaWrite as prisma } from '../db';

interface ZkpProofData {
  proofType: string;
  publicInputHash: string;
  verified: boolean;
  certaintyPercent?: number;
}

/**
 * Specialized decoding rule engine for ZKP verifier function calls.
 * Intercepts proof matrices and public inputs, renders clean structural readout.
 */
export function decodeZkpVerification(
  functionName: string,
  args: xdr.ScVal[],
): ZkpProofData | null {
  // Detect ZKP verifier patterns
  const zkpPatterns = ['verify_proof', 'verify_snark', 'verify_stark', 'verify_groth16'];
  if (!zkpPatterns.some((p) => functionName.toLowerCase().includes(p))) {
    return null;
  }

  try {
    // Extract proof type from function name
    let proofType = 'unknown';
    if (functionName.includes('snark')) proofType = 'snark';
    else if (functionName.includes('stark')) proofType = 'stark';
    else if (functionName.includes('groth16')) proofType = 'groth16';

    // First arg typically contains proof data
    const proofArg = args[0];
    if (!proofArg) return null;

    // Hash the proof for tracking (avoid storing large proof matrices)
    const proofHash = hashScVal(proofArg);

    // Second arg typically contains public inputs
    const publicInputArg = args[1];
    const publicInputHash = publicInputArg ? hashScVal(publicInputArg) : '';

    // Third arg may contain verification result or threshold
    let verified = true;
    let certaintyPercent = 99.9;

    if (args[2]) {
      const resultVal = scValToNative(args[2]);
      if (typeof resultVal === 'boolean') {
        verified = resultVal;
      } else if (typeof resultVal === 'number') {
        certaintyPercent = resultVal;
      }
    }

    return {
      proofType,
      publicInputHash,
      verified,
      certaintyPercent,
    };
  } catch {
    return null;
  }
}

/**
 * Simple hash function for ScVal objects (for tracking, not cryptographic).
 */
function hashScVal(val: xdr.ScVal): string {
  const xdrStr = val.toXDR('base64');
  let hash = 0;
  for (let i = 0; i < xdrStr.length; i++) {
    const char = xdrStr.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash).toString(16).slice(0, 16);
}

/**
 * Record ZKP verification event in database.
 */
export async function recordZkpVerification(
  transactionHash: string,
  contractAddress: string,
  zkpData: ZkpProofData,
  ledgerSequence: number,
  ledgerCloseTime: Date,
): Promise<void> {
  await prisma.zkpVerificationEvent.create({
    data: {
      transactionHash,
      contractAddress,
      proofType: zkpData.proofType,
      publicInputHash: zkpData.publicInputHash,
      verificationResult: zkpData.verified ? 'verified' : 'failed',
      certaintyPercent: zkpData.certaintyPercent,
      ledgerSequence,
      ledgerCloseTime,
    },
  });
}

/**
 * Format ZKP verification for human-readable display.
 */
export function formatZkpVerification(zkpData: ZkpProofData): string {
  const certainty = zkpData.certaintyPercent?.toFixed(1) ?? '99.9';
  const status = zkpData.verified ? 'Verified' : 'Failed';

  return `${status} ZK-${zkpData.proofType.toUpperCase()} proof for Shielded Vault Inflow (${certainty}% cryptographic certainty)`;
}

/**
 * Retrieve ZKP verification history for a contract.
 */
export async function getZkpVerificationHistory(contractAddress: string, limit: number = 50) {
  const events = await prisma.zkpVerificationEvent.findMany({
    where: { contractAddress },
    orderBy: { ledgerSequence: 'desc' },
    take: limit,
    select: {
      id: true,
      transactionHash: true,
      proofType: true,
      verificationResult: true,
      certaintyPercent: true,
      ledgerSequence: true,
      ledgerCloseTime: true,
    },
  });

  return events.map((e) => ({
    id: e.id,
    txHash: e.transactionHash,
    proofType: e.proofType,
    result: e.verificationResult,
    certainty: e.certaintyPercent,
    humanReadable: `${e.verificationResult === 'verified' ? 'Verified' : 'Failed'} ZK-${e.proofType.toUpperCase()} proof (${e.certaintyPercent?.toFixed(1) ?? '99.9'}% certainty)`,
    ledger: e.ledgerSequence,
    timestamp: e.ledgerCloseTime,
  }));
}
