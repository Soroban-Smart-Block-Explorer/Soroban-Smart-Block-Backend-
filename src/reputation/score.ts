import { createHash } from 'crypto';
import { prismaRead, prismaWrite } from '../db';
import {
  Address,
  AttestationInput,
  Badge,
  ChainId,
  ChainReputationData,
  ChainScore,
  EndorsementInput,
  LeaderboardEntry,
  LinkedIdentityInput,
  OracleReputationResponse,
  ReputationBreakdownItem,
  ReputationProof,
  ScoreResult,
  SybilAssessment,
  TrustEdgeInput,
  VerifiedIdentityLink,
  VerifiableCredential,
  OnChainAttestation,
} from './types';

const ALGORITHM_VERSION = 'reputation-oracle-v1';
const MAX_SCORE = 100;

export function canonicalAddress(address: Address): Address {
  const trimmed = address.trim();
  if (/^0x[a-fA-F0-9]{40}$/.test(trimmed)) return trimmed.toLowerCase();
  return trimmed;
}

export function deterministicHash(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`;
}

export function toNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string' && value.trim() !== '') {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
  }
  return fallback;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function normalizeAttestation(attestation: AttestationInput): OnChainAttestation {
  const uid = deterministicHash({
    chainId: attestation.chainId,
    schemaId: attestation.schemaId,
    attester: canonicalAddress(attestation.attester),
    subject: canonicalAddress(attestation.subject),
    recipient: attestation.recipient ? canonicalAddress(attestation.recipient) : null,
    transactionHash: attestation.transactionHash ?? null,
    blockNumber: attestation.blockNumber ?? null,
    data: attestation.data ?? null,
  });
  const verified = isAttestationVerifiable(attestation);
  return {
    ...attestation,
    uid,
    verified,
    verificationMessage: verified
      ? 'attestation has on-chain transaction evidence or valid signature'
      : 'attestation missing transaction evidence and signature',
  };
}

export function isAttestationVerifiable(attestation: AttestationInput): boolean {
  if (attestation.revoked) return false;
  if (
    !attestation.chainId ||
    !attestation.schemaId ||
    !attestation.attester ||
    !attestation.subject
  )
    return false;
  if (
    attestation.transactionHash &&
    attestation.blockNumber !== undefined &&
    attestation.blockNumber !== null
  )
    return true;
  return !!attestation.signature;
}

export function normalizeCredential(credential: VerifiableCredential): VerifiableCredential {
  return credential;
}

export function isVerifiableCredential(credential: VerifiableCredential): boolean {
  const context = Array.isArray(credential['@context'])
    ? credential['@context']
    : [credential['@context']];
  const types = Array.isArray(credential.type) ? credential.type : [credential.type];
  const issuer = typeof credential.issuer === 'string' ? credential.issuer : credential.issuer?.id;
  return (
    context.some((item) => item.includes('w3.org/ns/credentials')) &&
    types.includes('VerifiableCredential') &&
    Boolean(credential.id) &&
    Boolean(issuer) &&
    !Number.isNaN(Date.parse(credential.issuanceDate)) &&
    Boolean(credential.credentialSubject?.id) &&
    Boolean(credential.proof?.type) &&
    Boolean(credential.proof?.created) &&
    Boolean(credential.proof?.verificationMethod) &&
    Boolean(credential.proof?.proofPurpose) &&
    Boolean(credential.proof?.proofValue)
  );
}

export function countValidAttestations(chainData: ChainReputationData): number {
  return (chainData.attestations ?? []).filter(isAttestationVerifiable).length;
}

export function countValidCredentials(chainData: ChainReputationData): number {
  return (chainData.verifiableCredentials ?? []).filter(isVerifiableCredential).length;
}

export function getActiveChains(chainData: ChainReputationData[]): ChainId[] {
  return Array.from(new Set(chainData.map((item) => item.chainId))).sort();
}

export function groupByAddress(
  chainData: ChainReputationData[],
  addresses: Address[] = [],
): Map<Address, ChainReputationData[]> {
  const wanted = new Set(addresses.map(canonicalAddress));
  const grouped = new Map<Address, ChainReputationData[]>();
  for (const item of [...chainData].sort(
    (a, b) =>
      a.chainId.localeCompare(b.chainId) ||
      canonicalAddress(a.address).localeCompare(canonicalAddress(b.address)),
  )) {
    const address = canonicalAddress(item.address);
    if (wanted.size > 0 && !wanted.has(address)) continue;
    if (!grouped.has(address)) grouped.set(address, []);
    grouped.get(address)?.push(item);
  }
  return grouped;
}

export function scoreSingleChain(chainData: ChainReputationData): ChainScore {
  const address = canonicalAddress(chainData.address);
  const breakdown: ReputationBreakdownItem[] = [];
  const successfulTx = Math.max(
    0,
    toNumber(chainData.successfulTransactionCount, toNumber(chainData.transactionCount, 0)),
  );
  const failedTx = Math.max(0, toNumber(chainData.failedTransactionCount, 0));
  const totalTx = successfulTx + failedTx;
  const uniqueContracts = Math.max(0, toNumber(chainData.uniqueContractsInteracted, 0));
  const governanceVotes = Math.max(0, toNumber(chainData.governanceVotes, 0));
  const governanceWins = Math.max(0, toNumber(chainData.governanceWins, 0));
  const validAttestations = countValidAttestations(chainData);
  const validCredentials = countValidCredentials(chainData);
  const trustMetrics = calculateTrustMetrics([chainData], address);
  const endorsements = (chainData.endorsements ?? []).filter(
    (item) => canonicalAddress(item.subject) === address,
  ).length;

  const activity = clamp(successfulTx * 2 + uniqueContracts * 3, 0, 25);
  breakdown.push({
    signal: 'on_chain_activity',
    category: 'activity',
    points: round(activity),
    maxPoints: 25,
    evidence: `${successfulTx} successful transactions across ${uniqueContracts} contracts`,
  });

  const longevity = calculateLongevityPoints(chainData);
  breakdown.push({
    signal: 'account_longevity',
    category: 'activity',
    points: round(longevity),
    maxPoints: 15,
    evidence:
      chainData.firstSeen && chainData.lastSeen
        ? `active for ${daysBetween(chainData.firstSeen, chainData.lastSeen).toFixed(1)} days`
        : `${totalTx} indexed transactions`,
  });

  const governance = clamp(governanceVotes * 5 + governanceWins * 8, 0, 15);
  breakdown.push({
    signal: 'governance_participation',
    category: 'governance',
    points: round(governance),
    maxPoints: 15,
    evidence: `${governanceVotes} votes and ${governanceWins} successful outcomes`,
  });

  const attestations = clamp(validAttestations * 8, 0, 20);
  breakdown.push({
    signal: 'on_chain_attestations',
    category: 'attestations',
    points: round(attestations),
    maxPoints: 20,
    evidence: `${validAttestations} verifiable attestations`,
  });

  const credentials = clamp(validCredentials * 8, 0, 15);
  breakdown.push({
    signal: 'verifiable_credentials',
    category: 'credentials',
    points: round(credentials),
    maxPoints: 15,
    evidence: `${validCredentials} W3C-compatible credentials`,
  });

  const trust = clamp(
    (trustMetrics.incoming + trustMetrics.outgoing) * 2 + endorsements * 3,
    0,
    15,
  );
  breakdown.push({
    signal: 'trust_graph',
    category: 'trust',
    points: round(trust),
    maxPoints: 15,
    evidence: `${trustMetrics.incoming} incoming, ${trustMetrics.outgoing} outgoing, ${endorsements} endorsements`,
  });

  const penalties: ReputationBreakdownItem[] = [];
  if (totalTx > 0) {
    const failedRatio = failedTx / totalTx;
    const failedPenalty = clamp(failedRatio * 12, 0, 12);
    if (failedPenalty > 0) {
      penalties.push({
        signal: 'failed_transaction_ratio',
        category: 'risk',
        points: -round(failedPenalty),
        maxPoints: 12,
        evidence: `${(failedRatio * 100).toFixed(1)}% failed transactions`,
      });
    }
  }

  const sybilRisk = clamp(toNumber(chainData.sybilRisk, chainData.sybilCluster ? 0.7 : 0), 0, 1);
  const sybilPenalty = sybilRisk >= 0.5 ? 15 : 0;
  if (sybilPenalty > 0) {
    penalties.push({
      signal: 'sybil_resistance',
      category: 'risk',
      points: -sybilPenalty,
      maxPoints: 15,
      evidence: chainData.sybilCluster
        ? `shared cluster ${chainData.sybilCluster}`
        : `sybil risk ${(sybilRisk * 100).toFixed(0)}%`,
    });
  }

  const score = clamp(sumPoints([...breakdown, ...penalties]), 0, MAX_SCORE);
  return {
    chainId: chainData.chainId,
    address,
    score: round(score),
    breakdown: [...breakdown, ...penalties],
  };
}

export function calculateLongevityPoints(chainData: ChainReputationData): number {
  if (chainData.firstSeen && chainData.lastSeen) {
    const days = daysBetween(chainData.firstSeen, chainData.lastSeen);
    return clamp(Math.sqrt(Math.max(days, 0)) * 3, 0, 15);
  }
  const txCount = toNumber(chainData.transactionCount, 0);
  return txCount > 0 ? 3 : 0;
}

export function daysBetween(start: string, end: string): number {
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) return 0;
  return Math.max(0, (endMs - startMs) / 86_400_000);
}

export function calculateTrustMetrics(
  chainData: ChainReputationData[],
  address: Address,
): { incoming: number; outgoing: number; endorsements: number } {
  const canonical = canonicalAddress(address);
  let incoming = 0;
  let outgoing = 0;
  for (const item of chainData) {
    for (const edge of item.trustEdges ?? []) {
      const from = canonicalAddress(edge.from);
      const to = canonicalAddress(edge.to);
      if (from === canonical) outgoing += 1;
      if (to === canonical) incoming += 1;
    }
  }
  const endorsements = chainData
    .flatMap((item) => item.endorsements ?? [])
    .filter((item) => canonicalAddress(item.subject) === canonical).length;
  return { incoming, outgoing, endorsements };
}

export function sumPoints(breakdown: ReputationBreakdownItem[]): number {
  return breakdown.reduce((total, item) => total + item.points, 0);
}

export function round(value: number): number {
  return Math.round(value * 100) / 100;
}

export function computeReputationScore(
  address: Address,
  chainData: ChainReputationData[],
): ScoreResult {
  const canonical = canonicalAddress(address);
  const grouped = groupByAddress(chainData, [canonical]);
  const items = grouped.get(canonical) ?? [];
  return buildScoreResult(canonical, items, []);
}

export function computeReputationScoreForIdentity(
  canonicalAddressInput: Address,
  chainData: ChainReputationData[],
  verifiedLinks: VerifiedIdentityLink[],
): ScoreResult {
  const canonical = canonicalAddress(canonicalAddressInput);
  const linked = Array.from(
    new Set(
      verifiedLinks.filter((link) => link.verified).map((link) => canonicalAddress(link.address)),
    ),
  );
  const grouped = groupByAddress(chainData, [canonical, ...linked]);
  const items = (grouped.get(canonical) ?? []).concat(
    linked.flatMap((item) => grouped.get(item) ?? []),
  );
  return buildScoreResult(canonical, items, linked);
}

export function buildScoreResult(
  address: Address,
  chainData: ChainReputationData[],
  linkedAddresses: Address[],
): ScoreResult {
  const canonical = canonicalAddress(address);
  const normalizedLinks = Array.from(new Set(linkedAddresses.map(canonicalAddress))).sort();
  const chainScores = chainData
    .map(scoreSingleChain)
    .sort((a, b) => a.chainId.localeCompare(b.chainId));
  const activeChains = getActiveChains(chainData);
  const breakdown: ReputationBreakdownItem[] = [];
  const positive = chainScores.flatMap((item) => item.breakdown.filter((part) => part.points >= 0));
  const negative = chainScores.flatMap((item) => item.breakdown.filter((part) => part.points < 0));
  const groupedSignals = new Map<string, ReputationBreakdownItem>();

  for (const part of positive) {
    const existing = groupedSignals.get(part.signal);
    if (!existing) {
      groupedSignals.set(part.signal, { ...part });
      continue;
    }
    existing.points = round(existing.points + part.points);
    existing.maxPoints = Math.min(MAX_SCORE, existing.maxPoints + part.maxPoints);
    existing.evidence = mergeEvidence(existing.evidence, part.evidence);
  }

  for (const part of negative) {
    const existing = groupedSignals.get(part.signal);
    if (!existing) {
      groupedSignals.set(part.signal, { ...part });
      continue;
    }
    existing.points = round(existing.points + part.points);
    existing.evidence = mergeEvidence(existing.evidence, part.evidence);
  }

  const crossChainPoints = activeChains.length >= 3 ? 10 : activeChains.length === 2 ? 4 : 0;
  if (crossChainPoints > 0) {
    groupedSignals.set('cross_chain_presence', {
      signal: 'cross_chain_presence',
      category: 'cross_chain',
      points: crossChainPoints,
      maxPoints: 10,
      evidence: `active on ${activeChains.join(', ')}`,
    });
  }

  const linkedBonus = normalizedLinks.length > 0 ? 3 : 0;
  if (linkedBonus > 0) {
    groupedSignals.set('verified_identity_links', {
      signal: 'verified_identity_links',
      category: 'identity',
      points: linkedBonus,
      maxPoints: 3,
      evidence: `${normalizedLinks.length} verified linked addresses`,
    });
  }

  const sybil = assessSybilRisk(canonical, chainData);
  if (sybil.isSuspicious) {
    groupedSignals.set('sybil_resistance', {
      signal: 'sybil_resistance',
      category: 'risk',
      points: -15,
      maxPoints: 15,
      evidence: sybil.reasons.join('; '),
    });
  }

  const sortedBreakdown = Array.from(groupedSignals.values()).sort((a, b) =>
    a.signal.localeCompare(b.signal),
  );
  const score = clamp(sumPoints(sortedBreakdown), 0, MAX_SCORE);
  const proof = buildReputationProof(canonical, normalizedLinks, chainData, sortedBreakdown, score);
  return {
    address: canonical,
    score: round(score),
    rankCategory: 'overall',
    activeChains,
    linkedAddresses: normalizedLinks,
    chainScores,
    breakdown: sortedBreakdown,
    badges: [],
    sybil,
    proof,
  };
}

export function mergeEvidence(existing: string, next: string): string {
  const values = Array.from(
    new Set(
      [existing, next].flatMap((item) =>
        item
          .split('; ')
          .map((part) => part.trim())
          .filter(Boolean),
      ),
    ),
  );
  return values.join('; ');
}

export function buildReputationProof(
  address: Address,
  linkedAddresses: Address[],
  chainData: ChainReputationData[],
  breakdown: ReputationBreakdownItem[],
  score: number,
): ReputationProof {
  const input = [...chainData].sort(
    (a, b) =>
      a.chainId.localeCompare(b.chainId) ||
      canonicalAddress(a.address).localeCompare(canonicalAddress(b.address)),
  );
  return {
    algorithmVersion: ALGORITHM_VERSION,
    address: canonicalAddress(address),
    linkedAddresses: linkedAddresses.map(canonicalAddress).sort(),
    chainIds: getActiveChains(input),
    score: round(score),
    inputHash: deterministicHash(input),
    breakdownHash: deterministicHash(breakdown),
    badgeHash: deterministicHash([]),
  };
}

export function createLeaderboard(
  chainData: ChainReputationData[],
  category = 'overall',
  limit = 10,
): LeaderboardEntry[] {
  const grouped = groupByAddress(chainData);
  const entries = Array.from(grouped.entries()).map(([address, items]) => {
    const result = buildScoreResult(address, items, []);
    return {
      address,
      score: result.score,
      activeChains: result.activeChains.length,
      linkedAddresses: result.linkedAddresses,
      badges: [],
      sybilRisk: result.sybil.risk,
    };
  });

  const filtered = entries.filter((entry) => {
    if (category === 'sybil_resistant') return entry.sybilRisk < 0.5;
    if (category === 'cross_chain') return entry.activeChains >= 2;
    return true;
  });

  filtered.sort((a, b) => b.score - a.score || a.address.localeCompare(b.address));
  return filtered.slice(0, limit).map((entry, index) => ({ rank: index + 1, ...entry }));
}

export function verifyIdentityLinks(
  request: { canonicalAddress: Address; links: LinkedIdentityInput[] },
  verifier?: (chainId: ChainId, address: Address, message: string, signature: string) => boolean,
): VerifiedIdentityLink[] {
  const canonical = canonicalAddress(request.canonicalAddress);
  return request.links
    .map((link) => {
      const verified = verifySignedMessage(
        link.chainId,
        link.address,
        link.message,
        link.signature,
        verifier,
      );
      return {
        chainId: link.chainId,
        address: canonicalAddress(link.address),
        canonicalAddress: canonical,
        verified,
        messageHash: deterministicHash(link.message || ''),
      };
    })
    .sort((a, b) => a.chainId.localeCompare(b.chainId) || a.address.localeCompare(b.address));
}

export function verifySignedMessage(
  chainId: ChainId,
  address: Address,
  message: string,
  signature: string,
  verifier?: (chainId: ChainId, address: Address, message: string, signature: string) => boolean,
): boolean {
  if (verifier) return verifier(chainId, canonicalAddress(address), message, signature);
  if (/^stellar/i.test(chainId) || /^G[A-Z0-9]{55}$/.test(address)) {
    return verifyStellarSignedMessage(address, message, signature);
  }
  return false;
}

export function verifyStellarSignedMessage(
  address: Address,
  message: string,
  signature: string,
): boolean {
  try {
    const { Keypair } = require('@stellar/stellar-sdk') as typeof import('@stellar/stellar-sdk');
    const signatureBuffer = decodeSignature(signature);
    return Keypair.fromPublicKey(address).verify(Buffer.from(message), signatureBuffer);
  } catch {
    return false;
  }
}

export function decodeSignature(signature: string): Buffer {
  if (/^[A-Za-z0-9+/=]+$/.test(signature) && signature.length % 4 === 0) {
    return Buffer.from(signature, 'base64');
  }
  return Buffer.from(signature.replace(/^0x/, ''), 'hex');
}

export function assessSybilRisk(
  address: Address,
  chainData: ChainReputationData[],
): SybilAssessment {
  const canonical = canonicalAddress(address);
  const items = chainData
    .filter((item) => canonicalAddress(item.address) === canonical)
    .sort((a, b) => a.chainId.localeCompare(b.chainId));
  const explicitRisk = items
    .map((item) => toNumber(item.sybilRisk, -1))
    .filter((value) => value >= 0);
  const risk =
    explicitRisk.length > 0 ? Math.max(...explicitRisk) : calculateSybilRiskFromSignals(items);
  const reasons: string[] = [];
  if (items.some((item) => item.sybilCluster))
    reasons.push('address belongs to a shared sybil cluster');
  if (explicitRisk.length > 0 && Math.max(...explicitRisk) >= 0.5)
    reasons.push('external sybil signal exceeds threshold');
  if (
    items.reduce((total, item) => total + toNumber(item.transactionCount, 0), 0) < 3 &&
    items.length >= 2
  )
    reasons.push('low activity across multiple chains');
  if (
    items.some((item) => (item.attestations ?? []).length > 0 && countValidAttestations(item) === 0)
  )
    reasons.push('attestations lack verifiable on-chain evidence');
  if (reasons.length === 0 && risk >= 0.5)
    reasons.push('behavioral signals exceed sybil threshold');

  return {
    address: canonical,
    isSuspicious: risk >= 0.5,
    risk: round(clamp(risk, 0, 1)),
    confidence: round(clamp(0.55 + reasons.length * 0.1, 0.55, 0.95)),
    reasons,
    cluster: items.find((item) => item.sybilCluster)?.sybilCluster,
  };
}

export function calculateSybilRiskFromSignals(chainData: ChainReputationData[]): number {
  const txCount = chainData.reduce(
    (total, item) =>
      total +
      Math.max(toNumber(item.successfulTransactionCount, 0), toNumber(item.transactionCount, 0)),
    0,
  );
  const validAttestations = chainData.reduce(
    (total, item) => total + countValidAttestations(item),
    0,
  );
  const validCredentials = chainData.reduce(
    (total, item) => total + countValidCredentials(item),
    0,
  );
  const uniqueContracts = chainData.reduce(
    (total, item) => total + toNumber(item.uniqueContractsInteracted, 0),
    0,
  );
  let risk = 0.15;
  if (chainData.length >= 2 && txCount < 5) risk += 0.25;
  if (chainData.length >= 3 && txCount < 8) risk += 0.2;
  if (validAttestations === 0 && validCredentials === 0 && txCount < 10) risk += 0.2;
  if (uniqueContracts < 2 && txCount > 0) risk += 0.15;
  return clamp(risk, 0, 1);
}

export function createOracleResponse(
  address: Address,
  chainData: ChainReputationData[],
): OracleReputationResponse {
  const result = computeReputationScore(address, chainData);
  const attestations = chainData.flatMap((item) =>
    (item.attestations ?? []).map(normalizeAttestation),
  );
  const credentials = chainData
    .flatMap((item) => (item.verifiableCredentials ?? []).map(normalizeCredential))
    .filter(isVerifiableCredential);
  const badges = earnBadges(address, chainData);
  return {
    address: result.address,
    score: result.score,
    breakdown: result.breakdown,
    badges,
    attestations,
    credentials,
    sybil: result.sybil,
    proof: {
      ...result.proof,
      badgeHash: deterministicHash(badges.map((badge) => badge.id).sort()),
    },
  };
}

export function earnBadges(address: Address, chainData: ChainReputationData[]): Badge[] {
  const canonical = canonicalAddress(address);
  const items = chainData.filter((item) => canonicalAddress(item.address) === canonical);
  const txCount = items.reduce(
    (total, item) =>
      total + toNumber(item.successfulTransactionCount, toNumber(item.transactionCount, 0)),
    0,
  );
  const uniqueContracts = items.reduce(
    (total, item) => total + toNumber(item.uniqueContractsInteracted, 0),
    0,
  );
  const governanceVotes = items.reduce(
    (total, item) => total + toNumber(item.governanceVotes, 0),
    0,
  );
  const validAttestations = items.reduce((total, item) => total + countValidAttestations(item), 0);
  const validCredentials = items.reduce((total, item) => total + countValidCredentials(item), 0);
  const activeChains = getActiveChains(items);
  const sybil = assessSybilRisk(canonical, items);
  const earned: Badge[] = [];

  if (txCount >= 10)
    earned.push(
      badge(
        'pioneer',
        'Pioneer',
        'Completed at least 10 successful on-chain transactions.',
        `${txCount} successful transactions`,
      ),
    );
  if (activeChains.length >= 3)
    earned.push(
      badge('multichain', 'Multichain', 'Active on three or more chains.', activeChains.join(', ')),
    );
  if (uniqueContracts >= 5)
    earned.push(
      badge(
        'builder',
        'Builder',
        'Interacted with at least five unique contracts.',
        `${uniqueContracts} contracts`,
      ),
    );
  if (governanceVotes >= 3)
    earned.push(
      badge(
        'governor',
        'Governor',
        'Cast at least three governance votes.',
        `${governanceVotes} votes`,
      ),
    );
  if (validAttestations >= 2 && validCredentials >= 1)
    earned.push(
      badge(
        'trusted',
        'Trusted',
        'Holds verifiable attestations and credentials.',
        `${validAttestations} attestations and ${validCredentials} credentials`,
      ),
    );
  if (!sybil.isSuspicious)
    earned.push(
      badge(
        'sybil_resistant',
        'Sybil Resistant',
        'Does not meet sybil resistance thresholds.',
        'risk below 0.5',
      ),
    );
  return earned.sort((a, b) => a.id.localeCompare(b.id));
}

function badge(id: string, name: string, description: string, criteria: string): Badge {
  return { id, name, description, criteria, verifiable: true };
}

export async function fetchProfileData(address: string): Promise<ChainReputationData[]> {
  const canonical = canonicalAddress(address);

  // 1. Fetch on-chain Stellar/Soroban activity from local tables
  const [totalTxCount, successTxCount, failedTxCount, govVotesCount, contractsInteracted] =
    await Promise.all([
      prismaRead.transaction.count({ where: { sourceAccount: canonical } }),
      prismaRead.transaction.count({ where: { sourceAccount: canonical, status: 'success' } }),
      prismaRead.transaction.count({ where: { sourceAccount: canonical, status: 'failed' } }),
      prismaRead.governanceVote.count({ where: { voter: canonical } }),
      prismaRead.transaction.groupBy({
        by: ['contractAddress'],
        where: { sourceAccount: canonical, contractAddress: { not: null } },
      }),
    ]);

  // Let's count wins by joining GovernanceVote and GovernanceProposal
  const voterVotes = await prismaRead.governanceVote.findMany({
    where: { voter: canonical },
    include: { proposal: true },
  });
  let govWins = 0;
  for (const vote of voterVotes) {
    const status = vote.proposal?.status;
    const support = vote.support;
    if (
      support === 'for' &&
      (status === 'executed' || status === 'queued' || status === 'passed')
    ) {
      govWins++;
    } else if (support === 'against' && status === 'defeated') {
      govWins++;
    }
  }

  // 2. Fetch records from our reputation tables
  const profile = await prismaRead.reputationProfile.findUnique({
    where: { address: canonical },
    include: {
      signals: true,
      badges: true,
      attestations: true,
      trustConnections: true,
      credentials: true,
      linkedIdentities: true,
      endorsements: true,
    },
  });

  // Build a map of chainId -> ChainReputationData
  const chainDataMap = new Map<string, ChainReputationData>();

  // Always initialize Stellar/Soroban chain data (even if 0 activity)
  const stellarData: ChainReputationData = {
    chainId: 'stellar',
    address: canonical,
    transactionCount: totalTxCount,
    successfulTransactionCount: successTxCount,
    failedTransactionCount: failedTxCount,
    uniqueContractsInteracted: contractsInteracted.length,
    governanceVotes: govVotesCount,
    governanceWins: govWins,
    attestations: [],
    verifiableCredentials: [],
    trustEdges: [],
    endorsements: [],
  };
  chainDataMap.set('stellar', stellarData);

  // Populate from DB profile records if profile exists
  if (profile) {
    // For each linked address, we extract signals grouped by chain
    for (const signal of profile.signals) {
      const chain = signal.chain || 'stellar';
      if (!chainDataMap.has(chain)) {
        chainDataMap.set(chain, {
          chainId: chain,
          address: canonical,
          transactionCount: 0,
          successfulTransactionCount: 0,
          failedTransactionCount: 0,
          uniqueContractsInteracted: 0,
          governanceVotes: 0,
          governanceWins: 0,
          attestations: [],
          verifiableCredentials: [],
          trustEdges: [],
          endorsements: [],
        });
      }
      const data = chainDataMap.get(chain)!;
      if (signal.signalType === 'tx_volume') {
        data.transactionCount = Number(data.transactionCount) + Number(signal.value);
        data.successfulTransactionCount =
          Number(data.successfulTransactionCount) + Number(signal.value);
      }
    }

    // Distribute attestations to their respective chains
    for (const att of profile.attestations) {
      const chain = att.chainId;
      if (!chainDataMap.has(chain)) {
        chainDataMap.set(chain, {
          chainId: chain,
          address: canonical,
          transactionCount: 0,
          successfulTransactionCount: 0,
          failedTransactionCount: 0,
          uniqueContractsInteracted: 0,
          governanceVotes: 0,
          governanceWins: 0,
          attestations: [],
          verifiableCredentials: [],
          trustEdges: [],
          endorsements: [],
        });
      }
      chainDataMap.get(chain)!.attestations?.push({
        chainId: att.chainId,
        schemaId: att.schemaId,
        attester: att.attester,
        subject: att.subject,
        recipient: att.recipient || undefined,
        issuedAt: att.issuedAt.toISOString(),
        expiresAt: att.expiresAt?.toISOString(),
        revoked: att.revoked,
        signature: att.signature || undefined,
        transactionHash: att.transactionHash || undefined,
        blockNumber: att.blockNumber || undefined,
        data: att.data ? (att.data as Record<string, unknown>) : undefined,
      });
    }

    // Distribute credentials
    for (const cred of profile.credentials) {
      const chain = 'stellar';
      const data = chainDataMap.get(chain)!;
      data.verifiableCredentials?.push({
        '@context': cred.context as string[],
        id: cred.credentialId,
        type: cred.type as string[],
        issuer: cred.issuer,
        issuanceDate: cred.issuanceDate.toISOString(),
        expirationDate: cred.expirationDate?.toISOString(),
        credentialSubject: {
          id: cred.subjectId,
          ...(cred.subjectData as Record<string, unknown>),
        },
        proof: {
          type: cred.proofType,
          created: cred.proofCreated.toISOString(),
          verificationMethod: cred.verificationMethod,
          proofPurpose: cred.proofPurpose,
          proofValue: cred.proofValue,
        },
      });
    }

    // Distribute trust edges
    for (const conn of profile.trustConnections) {
      const chain = conn.chainId;
      if (!chainDataMap.has(chain)) {
        chainDataMap.set(chain, {
          chainId: chain,
          address: canonical,
          transactionCount: 0,
          successfulTransactionCount: 0,
          failedTransactionCount: 0,
          uniqueContractsInteracted: 0,
          governanceVotes: 0,
          governanceWins: 0,
          attestations: [],
          verifiableCredentials: [],
          trustEdges: [],
          endorsements: [],
        });
      }
      chainDataMap.get(chain)!.trustEdges?.push({
        chainId: conn.chainId,
        from: conn.fromAddress,
        to: conn.toAddress,
        weight: conn.weight,
        type: conn.type || undefined,
        timestamp: conn.timestamp.toISOString(),
        transactionHash: conn.transactionHash || undefined,
      });
    }

    // Distribute endorsements
    for (const end of profile.endorsements) {
      const chain = end.chainId;
      if (!chainDataMap.has(chain)) {
        chainDataMap.set(chain, {
          chainId: chain,
          address: canonical,
          transactionCount: 0,
          successfulTransactionCount: 0,
          failedTransactionCount: 0,
          uniqueContractsInteracted: 0,
          governanceVotes: 0,
          governanceWins: 0,
          attestations: [],
          verifiableCredentials: [],
          trustEdges: [],
          endorsements: [],
        });
      }
      chainDataMap.get(chain)!.endorsements?.push({
        chainId: end.chainId,
        endorser: end.endorser,
        subject: end.subject,
        weight: end.weight,
        timestamp: end.timestamp.toISOString(),
        transactionHash: end.transactionHash || undefined,
      });
    }
  }

  return Array.from(chainDataMap.values());
}

export async function saveReputationToDb(address: string, scoreResult: ScoreResult): Promise<any> {
  const canonical = canonicalAddress(address);

  // Map active chain scores
  const sorobanScore = scoreResult.chainScores.find((c) => c.chainId === 'soroban')?.score || 0;
  const stellarScore = scoreResult.chainScores.find((c) => c.chainId === 'stellar')?.score || 0;
  const ethScore =
    scoreResult.chainScores.find((c) => c.chainId === 'ethereum' || c.chainId === 'eth')?.score ||
    0;
  const solScore =
    scoreResult.chainScores.find((c) => c.chainId === 'solana' || c.chainId === 'sol')?.score || 0;

  const combinedScore = Math.round(scoreResult.score * 10);

  const categoryScores = {
    defi_user: stellarScore > 50 ? Math.round(stellarScore * 10) : 0,
    developer: sorobanScore > 50 ? Math.round(sorobanScore * 10) : 0,
  };

  const signalBreakdown = scoreResult.breakdown.map((item) => ({
    signal: item.signal,
    weight: item.maxPoints / 100,
    score: item.points,
    evidence: item.evidence,
  }));

  const categories = scoreResult.activeChains;
  const badgeIds = scoreResult.badges.map((b) => b.id);

  const profile = await prismaWrite.reputationProfile.upsert({
    where: { address: canonical },
    create: {
      address: canonical,
      chain: 'stellar',
      combinedScore,
      sorobanScore: Math.round(sorobanScore * 10),
      stellarScore: Math.round(stellarScore * 10),
      ethScore: Math.round(ethScore * 10),
      solScore: Math.round(solScore * 10),
      categoryScores,
      signalBreakdown,
      categories,
      badgeIds,
    },
    update: {
      combinedScore,
      sorobanScore: Math.round(sorobanScore * 10),
      stellarScore: Math.round(stellarScore * 10),
      ethScore: Math.round(ethScore * 10),
      solScore: Math.round(solScore * 10),
      categoryScores,
      signalBreakdown,
      categories,
      badgeIds,
      lastUpdated: new Date(),
    },
  });

  // Sync badges
  await prismaWrite.reputationBadge.deleteMany({
    where: { profileId: profile.id },
  });

  const badgeTypeMap: Record<string, string> = {
    pioneer: 'high_volume_trader',
    builder: 'verified_developer',
    governor: 'governance_participant',
    multichain: 'bridge_operator',
    trusted: 'long_standing',
    sybil_resistant: 'community_contributor',
  };

  if (scoreResult.badges && scoreResult.badges.length > 0) {
    await prismaWrite.reputationBadge.createMany({
      data: scoreResult.badges.map((b) => ({
        profileId: profile.id,
        badgeType: (badgeTypeMap[b.id] || 'community_contributor') as any,
        title: b.name,
        description: b.description,
        metadata: { criteria: b.criteria },
      })),
    });
  }

  // Sync signals
  await prismaWrite.reputationSignal.deleteMany({
    where: { profileId: profile.id },
  });
  if (scoreResult.breakdown && scoreResult.breakdown.length > 0) {
    await prismaWrite.reputationSignal.createMany({
      data: scoreResult.breakdown.map((item) => ({
        profileId: profile.id,
        signalType: item.signal,
        value: item.points,
        weight: item.maxPoints / 100,
        normalizedScore: item.points,
        metadata: { evidence: item.evidence },
        source: 'onchain',
        verified: true,
      })),
    });
  }

  return profile;
}
