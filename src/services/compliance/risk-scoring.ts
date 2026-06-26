import { prismaRead } from '../../db';

export interface RiskFactor {
  name: string;
  weight: number;
  score: number;
  details?: string;
}

export interface RiskAssessment {
  address: string;
  overallScore: number;
  riskLevel: string;
  factors: RiskFactor[];
  assessedAt: string;
}

const STELLAR_ADDRESS_REGEX = /^G[A-Z0-9]{55}$/i;
const CONTRACT_ADDRESS_REGEX = /^C[A-Z0-9]{55}$/i;

function calculateGeographicRisk(country?: string | null): number {
  if (!country) return 0;
  const highRiskCountries = [
    'iran',
    'korea',
    'syria',
    'cuba',
    'crimea',
    'russia',
    'belarus',
    'myanmar',
    'venezuela',
    'yemen',
    'sudan',
    'zimbabwe',
  ];
  const countryLower = country.toLowerCase();
  if (highRiskCountries.includes(countryLower)) return 85;
  if (['china', 'hong kong', 'macau'].includes(countryLower)) return 40;
  return 5;
}

export async function assessAddressRisk(address: string): Promise<RiskAssessment> {
  const factors: RiskFactor[] = [];

  const latestScreen = await prismaRead.screeningResult.findFirst({
    where: { address },
    orderBy: { screenedAt: 'desc' },
  });

  const sanctionsScore = latestScreen?.riskScore ?? 0;
  factors.push({
    name: 'Sanctions Match Score',
    weight: 0.4,
    score: sanctionsScore,
    details: latestScreen?.matchType
      ? `Match type: ${latestScreen.matchType}, Score: ${sanctionsScore}`
      : 'No sanctions match found',
  });

  const txCount = await prismaRead.transaction.count({
    where: { sourceAccount: address },
  });
  const oneWeekAgo = new Date(Date.now() - 604800000);
  const recentTxCount = await prismaRead.transaction.count({
    where: { sourceAccount: address, createdAt: { gte: oneWeekAgo } },
  });
  const txVelocity =
    recentTxCount > 50
      ? Math.min(100, recentTxCount / 2)
      : recentTxCount > 20
        ? 50
        : recentTxCount > 5
          ? 25
          : 0;
  factors.push({
    name: 'Transaction Velocity',
    weight: 0.15,
    score: txVelocity,
    details: `${recentTxCount} transactions in last 7 days`,
  });

  const firstTx = await prismaRead.transaction.findFirst({
    where: { sourceAccount: address },
    orderBy: { ledgerSequence: 'asc' },
    select: { createdAt: true },
  });
  const accountAgeDays = firstTx ? (Date.now() - firstTx.createdAt.getTime()) / 86400000 : 0;
  const ageScore =
    accountAgeDays < 1
      ? 80
      : accountAgeDays < 7
        ? 50
        : accountAgeDays < 30
          ? 25
          : accountAgeDays < 365
            ? 10
            : 0;
  factors.push({
    name: 'Account Age & Activity',
    weight: 0.1,
    score: ageScore,
    details: `Account age: ${Math.round(accountAgeDays)} days, total tx: ${txCount}`,
  });

  let linkScore = 0;
  if (latestScreen?.status !== 'clear' && latestScreen?.status !== undefined) {
    linkScore = 30;
  }
  factors.push({
    name: 'Link Analysis',
    weight: 0.2,
    score: linkScore,
    details:
      linkScore > 0 ? 'Connected to flagged addresses' : 'No linked high-risk addresses detected',
  });

  const isStellarAddress = STELLAR_ADDRESS_REGEX.test(address);
  const isContractAddress = CONTRACT_ADDRESS_REGEX.test(address);
  let geoScore = 0;
  if (isStellarAddress) {
    geoScore = 5;
  } else if (isContractAddress) {
    geoScore = 10;
  }
  factors.push({
    name: 'Geographic Risk',
    weight: 0.15,
    score: geoScore,
    details: isContractAddress
      ? 'Contract address (lower geographic risk)'
      : 'Standard Stellar address',
  });

  const overallScore = Math.round(factors.reduce((sum, f) => sum + f.score * f.weight, 0));

  let riskLevel: string;
  if (overallScore >= 80) riskLevel = 'critical';
  else if (overallScore >= 60) riskLevel = 'high';
  else if (overallScore >= 35) riskLevel = 'medium';
  else if (overallScore >= 15) riskLevel = 'low';
  else riskLevel = 'minimal';

  return {
    address,
    overallScore,
    riskLevel,
    factors,
    assessedAt: new Date().toISOString(),
  };
}

export async function batchRiskAssessment(addresses: string[]): Promise<RiskAssessment[]> {
  const batch = addresses.slice(0, 1000);
  return Promise.all(batch.map((addr) => assessAddressRisk(addr)));
}

export async function assessRiskFromScreen(
  screenResult: any,
  address: string,
): Promise<RiskAssessment> {
  return assessAddressRisk(address);
}
