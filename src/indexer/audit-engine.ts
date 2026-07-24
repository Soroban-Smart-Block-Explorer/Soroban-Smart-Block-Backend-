/**
 * Smart Contract Audit Engine
 *
 * Produces versioned AuditCertificate records with six composite scores
 * (security, governance, economic, compliance, liquidity, overall),
 * individual AuditFinding rows, an append-only AuditEvent trail, and
 * cryptographically signed certificate payloads.
 *
 * Continuous monitoring: startAuditMonitor() polls every hour for contracts
 * that need re-audit due to upgrades, new alerts, or schedule expiry.
 */
import crypto from 'crypto';
import { prismaWrite, prismaRead } from '../db';
import { logger } from '../logger';

// ── Scoring constants ─────────────────────────────────────────────────────────

const SCORE_MAX = 100;

/** Clamp a value to [0, 100] and round to integer. */
function clamp(v: number): number {
  return Math.round(Math.max(0, Math.min(SCORE_MAX, v)));
}

// ── Finding builder ───────────────────────────────────────────────────────────

type FindingSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';
type FindingCategory =
  | 'vulnerability'
  | 'code_quality'
  | 'governance'
  | 'economics'
  | 'compliance'
  | 'liquidity';

interface PendingFinding {
  category: FindingCategory;
  severity: FindingSeverity;
  title: string;
  description: string;
  detail?: string;
  recommendation?: string;
  cweId?: string;
  cvssScore?: number;
  txHash?: string;
}

// ── Dimension: Security ───────────────────────────────────────────────────────

async function scoreSecurityDimension(contractAddress: string): Promise<{
  score: number;
  findings: PendingFinding[];
  detail: Record<string, unknown>;
}> {
  const findings: PendingFinding[] = [];
  let deductions = 0;

  const [reentrancyAlerts, mevEvents, freezeViolations, threatAdvisories, verifyJob] =
    await Promise.all([
      prismaRead.reentrancyAlert.findMany({
        where: { contractAddress },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
      prismaRead.mevEvent.findMany({
        where: { protocolAddress: contractAddress },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
      prismaRead.freezeViolation.count({ where: { contractAddress } }),
      prismaRead.threatAdvisory.findMany({
        where: { affectedContracts: { has: contractAddress } },
        select: {
          id: true,
          title: true,
          severity: true,
          cvssScore: true,
          mitigations: true,
          cveId: true,
        },
      }),
      prismaRead.verificationJob.findFirst({
        where: { contractAddress, status: 'verified' },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

  // Reentrancy
  const highReentrancy = reentrancyAlerts.filter((a) => a.severity === 'high');
  const medReentrancy = reentrancyAlerts.filter((a) => a.severity === 'medium');
  if (highReentrancy.length > 0) {
    deductions += Math.min(40, highReentrancy.length * 15);
    findings.push({
      category: 'vulnerability',
      severity: 'high',
      title: `${highReentrancy.length} High-Severity Reentrancy Event(s) Detected`,
      description: 'Historical transactions show patterns consistent with reentrancy attacks.',
      detail: `Affected tx: ${highReentrancy[0]?.transactionHash}`,
      recommendation: 'Implement checks-effects-interactions pattern and reentrancy guards.',
      cweId: 'CWE-841',
    });
  }
  if (medReentrancy.length > 0) {
    deductions += Math.min(15, medReentrancy.length * 5);
    findings.push({
      category: 'vulnerability',
      severity: 'medium',
      title: `${medReentrancy.length} Medium-Severity Reentrancy Pattern(s)`,
      description: 'Moderate reentrancy signals observed in transaction history.',
      recommendation: 'Review withdrawal functions for reentrancy exposure.',
      cweId: 'CWE-841',
    });
  }

  // Flash loans
  const flashLoans = mevEvents.filter((e) => e.mevType === 'flash_loan_attack');
  if (flashLoans.length > 0) {
    deductions += Math.min(25, flashLoans.length * 10);
    findings.push({
      category: 'vulnerability',
      severity: 'high',
      title: `${flashLoans.length} Flash Loan Attack(s) Targeting This Contract`,
      description: 'MEV classifier detected flash-loan-enabled attacks against this contract.',
      recommendation: 'Add flash-loan guards; use TWAP oracles instead of spot prices.',
      txHash: flashLoans[0]?.txHash ?? undefined,
    });
  }

  // Threat advisories
  for (const adv of threatAdvisories) {
    const sev: FindingSeverity =
      adv.severity === 'critical' ||
      adv.severity === 'high' ||
      adv.severity === 'medium' ||
      adv.severity === 'low' ||
      adv.severity === 'info'
        ? (adv.severity as FindingSeverity)
        : 'medium';
    const sevWeight = { critical: 30, high: 20, medium: 10, low: 5, info: 0 };
    deductions += sevWeight[sev] ?? 10;
    findings.push({
      category: 'vulnerability',
      severity: sev,
      title: adv.title,
      description: `Threat advisory: ${adv.title}`,
      recommendation: (adv.mitigations ?? []).join('; ') || undefined,
      cvssScore: adv.cvssScore ?? undefined,
      cweId: adv.cveId ?? undefined,
    });
  }

  // Freeze violations
  if (freezeViolations > 0) {
    deductions += Math.min(20, freezeViolations * 7);
    findings.push({
      category: 'vulnerability',
      severity: 'medium',
      title: `${freezeViolations} CAP-0077 Consensus Freeze Violation(s)`,
      description: 'Contract touched consensus-frozen ledger keys.',
      recommendation: 'Audit ledger key access patterns for freeze compliance.',
    });
  }

  // Source verification
  if (!verifyJob?.matched) {
    deductions += 15;
    findings.push({
      category: 'code_quality',
      severity: 'medium',
      title: 'Source Code Not Verified',
      description: 'No reproducible build verification found for this contract.',
      recommendation: 'Submit source code for on-chain verification via /api/v1/verify.',
    });
  }

  const score = clamp(SCORE_MAX - deductions);
  return {
    score,
    findings,
    detail: {
      reentrancyAlertCount: reentrancyAlerts.length,
      flashLoanAttackCount: flashLoans.length,
      threatAdvisoryCount: threatAdvisories.length,
      freezeViolations,
      sourceVerified: !!verifyJob?.matched,
      wasmHash:
        (
          await prismaRead.contract.findUnique({
            where: { address: contractAddress },
            select: { wasmHash: true },
          })
        )?.wasmHash ?? null,
    },
  };
}

// ── Dimension: Governance ─────────────────────────────────────────────────────

async function scoreGovernanceDimension(contractAddress: string): Promise<{
  score: number;
  findings: PendingFinding[];
  detail: Record<string, unknown>;
}> {
  const findings: PendingFinding[] = [];
  let deductions = 0;

  const upgrades = await prismaRead.wasmUpgradeHistory.findMany({
    where: { contractAddress },
    orderBy: { ledgerSequence: 'desc' },
  });

  const latest = upgrades[0];
  const suspiciousCount = upgrades.filter((u) => u.isSuspicious).length;
  const criticalCount = upgrades.filter((u) => u.changeClassification === 'critical').length;

  // Single-key control
  if (latest?.governanceType === 'single_key') {
    deductions += 25;
    findings.push({
      category: 'governance',
      severity: 'high',
      title: 'Single-Key Upgrade Authority',
      description:
        'Contract upgrades are controlled by a single private key with no multisig or timelock.',
      recommendation: 'Migrate to multi-sig or DAO-controlled upgrades with a timelock.',
    });
  }

  // No timelock
  if (upgrades.length > 0 && (!latest?.timelockSeconds || latest.timelockSeconds === 0)) {
    deductions += 15;
    findings.push({
      category: 'governance',
      severity: 'medium',
      title: 'No Upgrade Timelock Detected',
      description:
        'Upgrades can be executed immediately with no enforced delay for community review.',
      recommendation: 'Implement a minimum 48-hour timelock for non-emergency upgrades.',
    });
  }

  // Suspicious upgrades
  if (suspiciousCount > 0) {
    deductions += Math.min(30, suspiciousCount * 12);
    findings.push({
      category: 'governance',
      severity: 'high',
      title: `${suspiciousCount} Suspicious Upgrade(s) Detected`,
      description: 'Upgrade history contains entries flagged by the upgrade-governance analyzer.',
      detail: `Flags: ${upgrades
        .filter((u) => u.isSuspicious)
        .flatMap((u) => u.suspiciousFlags)
        .join(', ')}`,
      recommendation: 'Investigate flagged upgrades and provide public post-mortems.',
    });
  }

  // Critical classification changes
  if (criticalCount > 0) {
    deductions += Math.min(20, criticalCount * 10);
    findings.push({
      category: 'governance',
      severity: 'high',
      title: `${criticalCount} Critical WASM Change(s) in Upgrade History`,
      description: 'One or more upgrades made critical changes to the contract logic.',
      recommendation: 'Publish changelogs and security reviews for all critical upgrades.',
    });
  }

  // High upgrade frequency
  if (upgrades.length > 10) {
    deductions += 10;
    findings.push({
      category: 'governance',
      severity: 'low',
      title: `High Upgrade Frequency (${upgrades.length} upgrades)`,
      description: 'Frequent upgrades indicate unstable code or active development risk.',
      recommendation: 'Aim for stable, audited releases with long intervals between changes.',
    });
  }

  const score = clamp(SCORE_MAX - deductions);
  return {
    score,
    findings,
    detail: {
      upgradeCount: upgrades.length,
      governanceType: latest?.governanceType ?? 'unknown',
      signerCount: latest?.signerCount ?? null,
      threshold: latest?.threshold ?? null,
      timelockSeconds: latest?.timelockSeconds ?? null,
      decentralizationScore: latest?.decentralizationScore ?? null,
      suspiciousUpgrades: suspiciousCount,
      lastUpgradeAt: latest?.ledgerCloseTime ?? null,
    },
  };
}

// ── Dimension: Economic ───────────────────────────────────────────────────────

async function scoreEconomicDimension(contractAddress: string): Promise<{
  score: number;
  findings: PendingFinding[];
  detail: Record<string, unknown>;
}> {
  const findings: PendingFinding[] = [];
  let deductions = 0;

  const since30d = new Date(Date.now() - 30 * 86400000);

  const [txStats, sandwichCount, yieldOpp, portfolio, prevPortfolio] = await Promise.all([
    prismaRead.transaction.aggregate({
      where: { contractAddress, ledgerCloseTime: { gte: since30d }, status: 'success' },
      _count: { id: true },
    }),
    prismaRead.mevEvent.count({
      where: { protocolAddress: contractAddress, mevType: 'sandwich' },
    }),
    prismaRead.yieldOpportunity.findFirst({
      where: { contractAddress },
      orderBy: { updatedAt: 'desc' },
    }),
    prismaRead.portfolioSnapshot.findFirst({
      where: { contractAddress },
      orderBy: { snapshotAt: 'desc' },
    }),
    prismaRead.portfolioSnapshot.findFirst({
      where: { contractAddress, snapshotAt: { lt: since30d } },
      orderBy: { snapshotAt: 'desc' },
    }),
  ]);

  const tvlCurrent = portfolio?.valueUsd ?? parseFloat(yieldOpp?.tvl ?? '0');
  const tvlPrev = prevPortfolio?.valueUsd ?? 0;
  const tvl30dTrend = tvlPrev > 0 ? ((tvlCurrent - tvlPrev) / tvlPrev) * 100 : 0;

  // TVL decline
  if (tvl30dTrend < -30) {
    deductions += 20;
    findings.push({
      category: 'economics',
      severity: 'high',
      title: `TVL Declined ${Math.abs(tvl30dTrend).toFixed(1)}% Over 30 Days`,
      description: 'Significant capital outflow detected over the past 30 days.',
      recommendation: 'Investigate withdrawal drivers; assess protocol health and user sentiment.',
    });
  } else if (tvl30dTrend < -15) {
    deductions += 10;
    findings.push({
      category: 'economics',
      severity: 'medium',
      title: `TVL Declined ${Math.abs(tvl30dTrend).toFixed(1)}% Over 30 Days`,
      description: 'Moderate capital outflow detected.',
      recommendation: 'Monitor for continued decline and evaluate incentive structures.',
    });
  }

  // MEV sandwich exposure
  if (sandwichCount > 10) {
    deductions += 15;
    findings.push({
      category: 'economics',
      severity: 'high',
      title: `${sandwichCount} MEV Sandwich Attacks Recorded`,
      description: 'High sandwich attack frequency indicates front-running vulnerability.',
      recommendation:
        'Implement slippage protection, use commit-reveal, or enable private mempool routing.',
    });
  } else if (sandwichCount > 3) {
    deductions += 7;
    findings.push({
      category: 'economics',
      severity: 'medium',
      title: `${sandwichCount} MEV Sandwich Attacks Recorded`,
      description: 'Moderate sandwich attack activity observed.',
      recommendation: 'Consider slippage limits and price impact warnings for users.',
    });
  }

  // Low user activity
  const uniqueUsers = await prismaRead.transaction.groupBy({
    by: ['sourceAccount'],
    where: { contractAddress, ledgerCloseTime: { gte: since30d } },
    _count: { id: true },
  });
  if (uniqueUsers.length < 10 && txStats._count.id > 0) {
    deductions += 10;
    findings.push({
      category: 'economics',
      severity: 'low',
      title: 'Low User Diversity (< 10 unique users in 30 days)',
      description: 'Contract activity is concentrated in very few addresses.',
      recommendation: 'Concentrated usage may indicate wash trading or test activity.',
    });
  }

  const score = clamp(SCORE_MAX - deductions);
  return {
    score,
    findings,
    detail: {
      tvlCurrent: tvlCurrent.toFixed(2),
      tvlPeak: Math.max(tvlCurrent, tvlPrev).toFixed(2),
      tvl30dTrend: tvl30dTrend.toFixed(2),
      transactions30d: txStats._count.id,
      uniqueUsers30d: uniqueUsers.length,
      sandwichAttacks: sandwichCount,
    },
  };
}

// ── Dimension: Compliance ─────────────────────────────────────────────────────

async function scoreComplianceDimension(contractAddress: string): Promise<{
  score: number;
  findings: PendingFinding[];
  detail: Record<string, unknown>;
}> {
  const findings: PendingFinding[] = [];
  let deductions = 0;

  // Collect all addresses to screen
  const [upgrades, deployer] = await Promise.all([
    prismaRead.wasmUpgradeHistory.findMany({
      where: { contractAddress },
      select: { upgrader: true },
    }),
    prismaRead.transaction.findFirst({
      where: { contractAddress },
      orderBy: { ledgerSequence: 'asc' },
      select: { sourceAccount: true },
    }),
  ]);

  const addressesToScreen = [
    contractAddress,
    deployer?.sourceAccount,
    ...upgrades.map((u) => u.upgrader).filter(Boolean),
  ].filter((a): a is string => !!a);

  const [sanctionHits, complianceFlags] = await Promise.all([
    prismaRead.sanctionedAddress.findMany({
      where: { address: { in: addressesToScreen } },
      select: { address: true, name: true, listSource: true, jurisdiction: true },
    }),
    prismaRead.complianceFlag.findMany({
      where: {
        OR: [
          { sourceAccount: { in: addressesToScreen } },
          { destinationAccount: { in: addressesToScreen } },
        ],
      },
      select: { severity: true, flagType: true, sourceAccount: true },
      take: 50,
    }),
  ]);

  // Sanction hits — immediate severe deduction
  if (sanctionHits.length > 0) {
    deductions += 60;
    for (const hit of sanctionHits) {
      const role =
        hit.address === contractAddress
          ? 'contract'
          : hit.address === deployer?.sourceAccount
            ? 'deployer'
            : 'admin key';
      findings.push({
        category: 'compliance',
        severity: 'critical',
        title: `SANCTIONS HIT: ${role} address on ${hit.listSource}`,
        description: `Address ${hit.address} appears on ${hit.listSource} sanctions list (${hit.jurisdiction ?? 'unknown jurisdiction'}).`,
        recommendation: 'Immediately halt interactions. Seek legal counsel.',
      });
    }
  }

  // High-severity compliance flags
  const highFlags = complianceFlags.filter((f) => f.severity === 'high');
  if (highFlags.length > 0) {
    deductions += Math.min(30, highFlags.length * 10);
    findings.push({
      category: 'compliance',
      severity: 'high',
      title: `${highFlags.length} High-Severity Compliance Flag(s)`,
      description: 'Transactions involving this contract triggered high-severity compliance flags.',
      recommendation: 'Review flagged transactions and consult compliance officer.',
    });
  }

  const medFlags = complianceFlags.filter((f) => f.severity === 'medium');
  if (medFlags.length > 0) {
    deductions += Math.min(15, medFlags.length * 5);
    findings.push({
      category: 'compliance',
      severity: 'medium',
      title: `${medFlags.length} Medium-Severity Compliance Flag(s)`,
      description: 'Medium-severity compliance signals detected.',
    });
  }

  const score = clamp(SCORE_MAX - deductions);
  const status =
    sanctionHits.length > 0 ? 'restricted' : highFlags.length > 0 ? 'flagged' : 'clean';

  return {
    score,
    findings,
    detail: {
      addressesScreened: addressesToScreen.length,
      sanctionHits: sanctionHits.length,
      sanctionDetails: sanctionHits,
      totalFlags: complianceFlags.length,
      highSeverityFlags: highFlags.length,
      status,
    },
  };
}

// ── Dimension: Liquidity ──────────────────────────────────────────────────────

async function scoreLiquidityDimension(contractAddress: string): Promise<{
  score: number;
  findings: PendingFinding[];
  detail: Record<string, unknown>;
}> {
  const findings: PendingFinding[] = [];
  let deductions = 0;

  const [dexPool, ammPool, yieldOpp] = await Promise.all([
    prismaRead.dexPool.findFirst({
      where: { contractAddress },
      include: { poolPrices: { orderBy: { timestamp: 'desc' }, take: 3 } },
    }),
    prismaRead.ammPool.findFirst({ where: { poolAddress: contractAddress } }),
    prismaRead.yieldOpportunity.findFirst({
      where: { contractAddress },
      orderBy: { updatedAt: 'desc' },
    }),
  ]);

  const poolLiquidity = dexPool?.totalLiquidity
    ? Number(dexPool.totalLiquidity)
    : parseFloat(yieldOpp?.tvl ?? '0');

  // Near-zero liquidity
  if (poolLiquidity < 1000 && (dexPool || ammPool || yieldOpp)) {
    deductions += 30;
    findings.push({
      category: 'liquidity',
      severity: 'high',
      title: 'Critically Low Pool Liquidity',
      description: `Pool liquidity is ~$${poolLiquidity.toFixed(0)}, making large trades highly susceptible to manipulation.`,
      recommendation:
        'Bootstrap liquidity via incentive programs before enabling large-volume trading.',
    });
  } else if (poolLiquidity < 50000 && poolLiquidity > 0) {
    deductions += 15;
    findings.push({
      category: 'liquidity',
      severity: 'medium',
      title: 'Low Pool Liquidity',
      description: `Pool liquidity ($${poolLiquidity.toFixed(0)}) is below the $50k safe threshold.`,
      recommendation: 'Increase liquidity depth to reduce price impact and manipulation risk.',
    });
  }

  // Concentration risk — sparse price update history indicates few LPs
  if (dexPool?.poolPrices && dexPool.poolPrices.length < 2) {
    deductions += 20;
    findings.push({
      category: 'liquidity',
      severity: 'high',
      title: 'High Liquidity Concentration Risk',
      description:
        'Price feed history is sparse, suggesting liquidity is concentrated in very few providers.',
      recommendation: 'Incentivise a broader set of liquidity providers to reduce concentration.',
    });
  }

  // Impermanent loss indicator
  let ilIndicator = 0;
  if (dexPool?.poolPrices && dexPool.poolPrices.length >= 2) {
    const latest = Number(dexPool.poolPrices[0].spotPrice);
    const prev = Number(dexPool.poolPrices[1].spotPrice);
    if (prev > 0) {
      const r = latest / prev;
      ilIndicator = Math.abs((2 * Math.sqrt(r)) / (1 + r) - 1);
    }
    if (ilIndicator > 0.1) {
      deductions += 15;
      findings.push({
        category: 'liquidity',
        severity: 'medium',
        title: `Elevated Impermanent Loss Indicator (${(ilIndicator * 100).toFixed(1)}%)`,
        description:
          'Recent price volatility suggests LPs may be experiencing significant impermanent loss.',
        recommendation: 'Notify LPs and consider stable-asset pool variants to reduce IL exposure.',
      });
    }
  }

  // Yield risk score from optimizer
  if (yieldOpp && yieldOpp.riskScore > 70) {
    deductions += 10;
    findings.push({
      category: 'liquidity',
      severity: 'medium',
      title: `High Yield Risk Score (${yieldOpp.riskScore}/100)`,
      description: `Yield optimizer rates this opportunity as high-risk (label: ${yieldOpp.riskLabel}).`,
      recommendation: 'Review smart contract risks and token incentive sustainability.',
    });
  }

  const score = clamp(SCORE_MAX - deductions);
  return {
    score,
    findings,
    detail: {
      poolLiquidity: poolLiquidity.toFixed(2),
      concentrationRisk: dexPool?.poolPrices && dexPool.poolPrices.length < 2 ? 'high' : 'low',
      impermanentLossIndicator: ilIndicator.toFixed(4),
      yieldRiskScore: yieldOpp?.riskScore ?? null,
      yieldRiskLabel: yieldOpp?.riskLabel ?? null,
      hasDexPool: !!dexPool,
      hasAmmPool: !!ammPool,
    },
  };
}

// ── Certificate Cryptography ──────────────────────────────────────────────────

const SIGNING_KEY = () => process.env.AUDIT_SIGNING_KEY ?? 'soroban-explorer-audit-v1';
const PUBLIC_KEY_ID = 'soroban-explorer-audit-platform-v1';

export interface CertificatePayload {
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
  generatedAt: string;
  platform: string;
}

/** Compute SHA-256 over the canonical JSON payload. */
export function hashCertificate(payload: CertificatePayload): string {
  const canonical = JSON.stringify(payload, Object.keys(payload).sort());
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

/** Sign the certificate hash with HMAC-SHA256 → base64. */
export function signCertificate(hash: string): string {
  return crypto.createHmac('sha256', SIGNING_KEY()).update(hash).digest('base64');
}

/** Verify a certificate signature. Uses timing-safe comparison. */
export function verifyCertificateSignature(hash: string, signature: string): boolean {
  try {
    const expected = Buffer.from(signCertificate(hash), 'base64');
    const provided = Buffer.from(signature, 'base64');
    if (expected.length !== provided.length) return false;
    return crypto.timingSafeEqual(expected, provided);
  } catch {
    return false;
  }
}

/** Derive expiry: 90 days from issuance. */
function certExpiry(): Date {
  const d = new Date();
  d.setDate(d.getDate() + 90);
  return d;
}

// ── Regulatory Report Generator ───────────────────────────────────────────────

export function generateReportText(cert: {
  contractAddress: string;
  version: number;
  status: string;
  generatedAt: Date;
  expiresAt: Date | null;
  overallScore: number;
  securityScore: number;
  governanceScore: number;
  economicScore: number;
  complianceScore: number;
  liquidityScore: number;
  certificateHash: string;
  anchorTxHash: string | null;
  totalFindings: number;
  criticalFindings: number;
  highFindings: number;
  mediumFindings: number;
  lowFindings: number;
  openFindings: number;
  resolvedFindings: number;
  scores: unknown;
}): string {
  const grade =
    cert.overallScore >= 85
      ? 'A'
      : cert.overallScore >= 70
        ? 'B'
        : cert.overallScore >= 55
          ? 'C'
          : cert.overallScore >= 40
            ? 'D'
            : 'F';

  const riskLabel =
    cert.overallScore >= 85
      ? 'LOW'
      : cert.overallScore >= 70
        ? 'MEDIUM'
        : cert.overallScore >= 55
          ? 'HIGH'
          : 'CRITICAL';

  const scores = cert.scores as Record<string, unknown>;

  return [
    '═══════════════════════════════════════════════════════════════',
    '       SOROBAN SMART CONTRACT AUDIT CERTIFICATE REPORT         ',
    '═══════════════════════════════════════════════════════════════',
    '',
    `CONTRACT ADDRESS   : ${cert.contractAddress}`,
    `AUDIT VERSION      : v${cert.version}`,
    `STATUS             : ${cert.status.toUpperCase()}`,
    `GENERATED AT       : ${cert.generatedAt.toISOString()}`,
    `EXPIRES AT         : ${cert.expiresAt?.toISOString() ?? 'N/A'}`,
    '',
    '─────────────────── COMPOSITE SCORES ──────────────────────────',
    `OVERALL SCORE      : ${cert.overallScore}/100  [Grade: ${grade}]  [Risk: ${riskLabel}]`,
    `  Security         : ${cert.securityScore}/100`,
    `  Governance       : ${cert.governanceScore}/100`,
    `  Economic         : ${cert.economicScore}/100`,
    `  Compliance       : ${cert.complianceScore}/100`,
    `  Liquidity        : ${cert.liquidityScore}/100`,
    '',
    '─────────────────── FINDINGS SUMMARY ──────────────────────────',
    `TOTAL FINDINGS     : ${cert.totalFindings}`,
    `  Critical         : ${cert.criticalFindings}`,
    `  High             : ${cert.highFindings}`,
    `  Medium           : ${cert.mediumFindings}`,
    `  Low              : ${cert.lowFindings}`,
    `  Open             : ${cert.openFindings}`,
    `  Resolved         : ${cert.resolvedFindings}`,
    '',
    '─────────────────── DIMENSION DETAIL ──────────────────────────',
    `Security Detail    : ${JSON.stringify((scores?.security as Record<string, unknown>)?.detail ?? {})}`,
    `Governance Detail  : ${JSON.stringify((scores?.governance as Record<string, unknown>)?.detail ?? {})}`,
    `Economic Detail    : ${JSON.stringify((scores?.economic as Record<string, unknown>)?.detail ?? {})}`,
    `Compliance Detail  : ${JSON.stringify((scores?.compliance as Record<string, unknown>)?.detail ?? {})}`,
    `Liquidity Detail   : ${JSON.stringify((scores?.liquidity as Record<string, unknown>)?.detail ?? {})}`,
    '',
    '─────────────────── CRYPTOGRAPHIC ATTESTATION ──────────────────',
    `CERTIFICATE HASH   : ${cert.certificateHash}`,
    `SIGNATURE ALG      : HMAC-SHA256`,
    `PUBLIC KEY         : ${PUBLIC_KEY_ID}`,
    `ANCHOR TX          : ${cert.anchorTxHash ?? 'Not yet anchored on-chain'}`,
    '',
    '─────────────────── VERIFICATION ───────────────────────────────',
    `Verify at          : GET /api/v1/audit/verify/${cert.certificateHash}`,
    '',
    'This report is auto-generated. For regulatory use, supplement',
    'with a manual expert review. Scores higher = healthier.',
    '═══════════════════════════════════════════════════════════════',
  ].join('\n');
}

// ── Main Audit Runner ─────────────────────────────────────────────────────────

export async function runAudit(
  contractAddress: string,
  triggerSource: 'scheduled' | 'automatic' | 'manual' | 'external' = 'scheduled',
): Promise<string> {
  logger.info('Audit started', { contractAddress, triggerSource });

  // Verify the contract exists in the index
  const contract = await prismaRead.contract.findUnique({
    where: { address: contractAddress },
    select: { address: true },
  });
  if (!contract) {
    throw new Error(`Contract ${contractAddress} not found in explorer index`);
  }

  // Determine next version number
  const lastCert = await prismaRead.auditCertificate.findFirst({
    where: { contractAddress },
    orderBy: { version: 'desc' },
    select: { version: true, overallScore: true },
  });
  const version = (lastCert?.version ?? 0) + 1;
  const previousScore = lastCert?.overallScore ?? null;

  // Log the audit start event
  await prismaWrite.auditEvent.create({
    data: {
      contractAddress,
      eventType: version === 1 ? 'initial_audit' : 're_audit',
      triggerSource,
      timestamp: new Date(),
      details: { version, previousScore } as import('@prisma/client').Prisma.InputJsonValue,
    },
  });

  try {
    // Run all 5 scoring dimensions in parallel
    const [security, governance, economic, compliance, liquidity] = await Promise.all([
      scoreSecurityDimension(contractAddress),
      scoreGovernanceDimension(contractAddress),
      scoreEconomicDimension(contractAddress),
      scoreComplianceDimension(contractAddress),
      scoreLiquidityDimension(contractAddress),
    ]);

    // Weighted overall score: security 30%, governance 25%, economic 20%, compliance 15%, liquidity 10%
    const overallScore = clamp(
      security.score * 0.3 +
        governance.score * 0.25 +
        economic.score * 0.2 +
        compliance.score * 0.15 +
        liquidity.score * 0.1,
    );

    // Collect all findings
    const allFindings: PendingFinding[] = [
      ...security.findings,
      ...governance.findings,
      ...economic.findings,
      ...compliance.findings,
      ...liquidity.findings,
    ];

    const countBySeverity = (sev: string) => allFindings.filter((f) => f.severity === sev).length;

    const totalFindings = allFindings.length;
    const criticalFindings = countBySeverity('critical');
    const highFindings = countBySeverity('high');
    const mediumFindings = countBySeverity('medium');
    const lowFindings = countBySeverity('low');
    const openFindings = totalFindings; // all new findings start open

    // Build certificate payload for hashing
    const now = new Date();
    const payload: CertificatePayload = {
      contractAddress,
      version,
      overallScore,
      securityScore: security.score,
      governanceScore: governance.score,
      economicScore: economic.score,
      complianceScore: compliance.score,
      liquidityScore: liquidity.score,
      totalFindings,
      criticalFindings,
      generatedAt: now.toISOString(),
      platform: 'soroban-explorer-audit-v1',
    };

    const certificateHash = hashCertificate(payload);
    const signature = signCertificate(certificateHash);

    const scoresSnapshot = {
      security: { score: security.score, detail: security.detail },
      governance: { score: governance.score, detail: governance.detail },
      economic: { score: economic.score, detail: economic.detail },
      compliance: { score: compliance.score, detail: compliance.detail },
      liquidity: { score: liquidity.score, detail: liquidity.detail },
    };

    // Supersede the previous certificate if one exists
    if (lastCert) {
      await prismaWrite.auditCertificate.updateMany({
        where: { contractAddress, status: 'published' },
        data: { status: 'superseded' },
      });
    }

    // Create the new certificate
    const cert = await prismaWrite.auditCertificate.create({
      data: {
        contractAddress,
        version,
        status: 'published',
        generatedAt: now,
        expiresAt: certExpiry(),
        overallScore,
        securityScore: security.score,
        governanceScore: governance.score,
        economicScore: economic.score,
        complianceScore: compliance.score,
        liquidityScore: liquidity.score,
        signatureAlgorithm: 'hmac-sha256',
        signature,
        publicKey: PUBLIC_KEY_ID,
        certificateHash,
        totalFindings,
        openFindings,
        criticalFindings,
        highFindings,
        mediumFindings,
        lowFindings,
        resolvedFindings: 0,
        findings: allFindings as unknown as import('@prisma/client').Prisma.InputJsonValue,
        scores: scoresSnapshot as unknown as import('@prisma/client').Prisma.InputJsonValue,
        metadata: {
          triggerSource,
          engineVersion: '2.0.0',
          weightsUsed: {
            security: 0.3,
            governance: 0.25,
            economic: 0.2,
            compliance: 0.15,
            liquidity: 0.1,
          },
        } as import('@prisma/client').Prisma.InputJsonValue,
      },
    });

    // Persist individual findings as queryable rows
    if (allFindings.length > 0) {
      await prismaWrite.auditFinding.createMany({
        data: allFindings.map((f) => ({
          certificateId: cert.id,
          category: f.category,
          severity: f.severity,
          title: f.title,
          description: f.description,
          detail: f.detail ?? null,
          recommendation: f.recommendation ?? null,
          status: 'open',
          cweId: f.cweId ?? null,
          cvssScore: f.cvssScore ?? null,
          txHash: f.txHash ?? null,
        })),
      });
    }

    // Log certificate published + optional score change events
    const eventWrites: Promise<unknown>[] = [
      prismaWrite.auditEvent.create({
        data: {
          contractAddress,
          certificateId: cert.id,
          eventType: 'certificate_published',
          newScore: overallScore,
          triggerSource,
          timestamp: now,
          details: { version, certificateHash } as import('@prisma/client').Prisma.InputJsonValue,
        },
      }),
    ];

    if (previousScore !== null && Math.abs(overallScore - previousScore) >= 5) {
      eventWrites.push(
        prismaWrite.auditEvent.create({
          data: {
            contractAddress,
            certificateId: cert.id,
            eventType: 'score_change',
            previousScore,
            newScore: overallScore,
            triggerSource,
            timestamp: now,
            details: {
              delta: overallScore - previousScore,
              direction: overallScore > previousScore ? 'improved' : 'degraded',
            } as import('@prisma/client').Prisma.InputJsonValue,
          },
        }),
      );
    }

    // Alert subscriptions for score drops
    if (previousScore !== null && previousScore > overallScore) {
      const drop = previousScore - overallScore;
      const subs = await prismaRead.auditSubscription.findMany({
        where: {
          contractAddress,
          isActive: true,
          alertTypes: { has: 'score_drop' },
        },
      });
      for (const sub of subs) {
        if (!sub.threshold || drop >= sub.threshold) {
          eventWrites.push(
            prismaWrite.auditEvent.create({
              data: {
                contractAddress,
                certificateId: cert.id,
                eventType: 'score_change',
                previousScore,
                newScore: overallScore,
                triggerSource: 'automatic',
                timestamp: now,
                details: {
                  alertSentToSubscription: sub.id,
                  drop,
                } as import('@prisma/client').Prisma.InputJsonValue,
              },
            }),
          );
        }
      }
    }

    await Promise.all(eventWrites);

    logger.info('Audit complete', {
      contractAddress,
      certId: cert.id,
      version,
      overallScore,
      findings: totalFindings,
    });

    return cert.id;
  } catch (err) {
    // Log failure event
    await prismaWrite.auditEvent.create({
      data: {
        contractAddress,
        eventType: 're_audit',
        triggerSource,
        timestamp: new Date(),
        details: { error: String(err), version } as import('@prisma/client').Prisma.InputJsonValue,
      },
    });
    logger.error('Audit failed', { contractAddress, error: String(err) });
    throw err;
  }
}

// ── Re-Audit Trigger Detection ────────────────────────────────────────────────

export async function needsReaudit(contractAddress: string): Promise<boolean> {
  const latest = await prismaRead.auditCertificate.findFirst({
    where: { contractAddress, status: 'published' },
    orderBy: { version: 'desc' },
    select: { generatedAt: true, expiresAt: true, overallScore: true },
  });

  // Never audited
  if (!latest) return true;

  // Certificate expired
  if (latest.expiresAt && latest.expiresAt < new Date()) return true;

  // New WASM upgrade since last audit
  const newUpgrade = await prismaRead.wasmUpgradeHistory.findFirst({
    where: { contractAddress, ledgerCloseTime: { gt: latest.generatedAt } },
    select: { id: true },
  });
  if (newUpgrade) return true;

  // New high-severity reentrancy alert
  const newAlert = await prismaRead.reentrancyAlert.findFirst({
    where: {
      contractAddress,
      severity: 'high',
      createdAt: { gt: latest.generatedAt },
    },
    select: { id: true },
  });
  if (newAlert) return true;

  // New sanction hit on associated addresses
  const deployer = await prismaRead.transaction.findFirst({
    where: { contractAddress },
    orderBy: { ledgerSequence: 'asc' },
    select: { sourceAccount: true },
  });
  if (deployer?.sourceAccount) {
    const hit = await prismaRead.sanctionedAddress.findUnique({
      where: { address: deployer.sourceAccount },
      select: { id: true },
    });
    if (hit) return true;
  }

  return false;
}

// ── Background Monitor ────────────────────────────────────────────────────────

/**
 * @deprecated Use startAuditPipeline() + startAuditScheduler() instead.
 * Kept for backward compatibility only. The full pipeline (audit-pipeline.ts +
 * audit-scheduler.ts) supersedes this simple hourly poller.
 */
export function startAuditMonitor(): void {
  logger.warn(
    'startAuditMonitor() is deprecated. ' +
      'startAuditPipeline() and startAuditScheduler() are now used instead.',
  );
}
