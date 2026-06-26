import { prismaRead as prisma } from '../db';

export interface PrivacyScoreResult {
  privacyScore: number;
  riskScore: number;
  breakdown: {
    protocolDiversity: number;
    anonymitySetScore: number;
    cryptographicStrength: number;
    deAnonymizationVectors: number;
    historicalLinkage: number;
    baseRisk: number;
    graphRisk: number;
    contractRisk: number;
  };
}

const CRYPTO_STRENGTH: Record<string, number> = {
  ZK_SNARK: 15,
  ZK_STARK: 14,
  BULLETPROOF: 12,
  STEALTH_ADDRESS: 10,
  MIXER: 9,
  SHIELDED_TRANSFER: 8,
  PRIVATE_VOTING: 13,
  OFF_CHAIN_DATA: 6,
  ENCRYPTED_STATE: 7,
  DIFFERENTIAL_PRIVACY: 11,
};

function protocolDiversityScore(protocolCount: number): number {
  if (protocolCount >= 4) return 20;
  if (protocolCount === 3) return 15;
  if (protocolCount === 2) return 10;
  if (protocolCount === 1) return 5;
  return 0;
}

function anonymitySetScore(setSize: number | null): number {
  if (setSize === null || setSize === 0) return 0;
  if (setSize > 1000) return 25;
  if (setSize > 100) return 20;
  if (setSize > 50) return 15;
  if (setSize > 10) return 10;
  return 5;
}

function cryptographicStrengthScore(protocols: string[]): number {
  let maxStrength = 0;
  for (const p of protocols) {
    const s = CRYPTO_STRENGTH[p] || 0;
    if (s > maxStrength) maxStrength = s;
  }
  const extra = Math.max(0, protocols.length - 1) * 2;
  return Math.min(15, maxStrength + extra);
}

function baseRiskScore(protocols: string[]): number {
  let risk = 30;
  for (const p of protocols) {
    if (p === 'SHIELDED_TRANSFER') risk -= 5;
    if (p === 'ZK_SNARK' || p === 'ZK_STARK') risk -= 8;
    if (p === 'MIXER') risk -= 3;
    if (p === 'BULLETPROOF') risk -= 5;
  }
  return Math.max(5, Math.min(50, risk));
}

function contractRiskScore(protocols: string[]): number {
  let risk = 10;
  if (protocols.includes('SHIELDED_TRANSFER')) risk += 5;
  if (protocols.includes('MIXER')) risk += 10;
  if (protocols.includes('PRIVATE_VOTING')) risk += 3;
  return Math.min(30, risk);
}

function graphRiskScore(anonymitySetSize: number | null): number {
  if (anonymitySetSize === null) return 20;
  if (anonymitySetSize < 5) return 25;
  if (anonymitySetSize < 20) return 18;
  if (anonymitySetSize < 100) return 12;
  if (anonymitySetSize < 1000) return 6;
  return 2;
}

function deAnonymizationVectorDeduction(vectorCount: number): number {
  if (vectorCount >= 5) return -25;
  if (vectorCount >= 3) return -20;
  if (vectorCount >= 2) return -15;
  if (vectorCount >= 1) return -10;
  return 0;
}

function historicalLinkageDeduction(address: string | null, nonPrivateTxCount: number): number {
  if (!address || nonPrivateTxCount === 0) return 0;
  if (nonPrivateTxCount > 100) return -15;
  if (nonPrivateTxCount > 50) return -12;
  if (nonPrivateTxCount > 20) return -8;
  if (nonPrivateTxCount > 5) return -5;
  return -2;
}

export async function computePrivacyScore(
  protocols: string[],
  guarantees: string[],
  anonymitySetSize: number | null,
  sourceAccount: string | null,
  _contractAddresses: string[],
): Promise<PrivacyScoreResult> {
  let nonPrivateTxCount = 0;
  if (sourceAccount) {
    try {
      nonPrivateTxCount = await prisma.transaction.count({
        where: {
          sourceAccount,
          hash: {
            notIn: (
              await prisma.privacyTransaction.findMany({
                where: { participants: { has: sourceAccount } },
                select: { txHash: true },
              })
            ).map((p) => p.txHash),
          },
        },
      });
    } catch {
      nonPrivateTxCount = 0;
    }
  }

  const pd = protocolDiversityScore(protocols.length);
  const as = anonymitySetScore(anonymitySetSize);
  const cs = cryptographicStrengthScore(protocols);
  const dv = deAnonymizationVectorDeduction(0);
  const hl = historicalLinkageDeduction(sourceAccount, nonPrivateTxCount);

  let privacyScore = Math.max(0, Math.min(100, pd + as + cs + dv + hl));

  const br = baseRiskScore(protocols);
  const gr = graphRiskScore(anonymitySetSize);
  const cr = contractRiskScore(protocols);

  let riskScore = Math.max(0, Math.min(100, br + gr + cr));

  const nonPrivateFactor =
    nonPrivateTxCount > 50 ? 20 : nonPrivateTxCount > 20 ? 12 : nonPrivateTxCount > 5 ? 6 : 0;
  riskScore = Math.min(100, riskScore + nonPrivateFactor);

  privacyScore = Math.max(0, 100 - riskScore * (1 - anonymitySetScore(anonymitySetSize) / 25));

  return {
    privacyScore,
    riskScore,
    breakdown: {
      protocolDiversity: pd,
      anonymitySetScore: as,
      cryptographicStrength: cs,
      deAnonymizationVectors: dv,
      historicalLinkage: hl,
      baseRisk: br,
      graphRisk: gr,
      contractRisk: cr,
    },
  };
}

export async function scoreAndUpdatePrivacyTransaction(
  txHash: string,
  protocols: string[],
  guarantees: string[],
  anonymitySetSize: number | null,
  sourceAccount: string | null,
  contractAddresses: string[],
): Promise<PrivacyScoreResult | null> {
  const result = await computePrivacyScore(
    protocols,
    guarantees,
    anonymitySetSize,
    sourceAccount,
    contractAddresses,
  );

  const { prismaWrite } = await import('../db');

  await prismaWrite.privacyTransaction.update({
    where: { txHash },
    data: {
      privacyScore: result.privacyScore,
      riskScore: result.riskScore,
      effectiveAnonymitySet: anonymitySetSize
        ? Math.max(1, Math.round(anonymitySetSize * (1 - result.riskScore / 200)))
        : null,
    },
  });

  return result;
}
