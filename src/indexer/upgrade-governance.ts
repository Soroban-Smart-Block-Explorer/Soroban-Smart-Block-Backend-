/**
 * Contract Governance Intelligence — governance analysis, decentralisation
 * scoring, suspicious-activity detection, and persistence (Phases 2 & 4).
 *
 * Pure functions (`analyzeGovernance`, `computeDecentralizationScore`,
 * `detectSuspiciousActivity`) hold the methodology and are unit-tested in
 * isolation. The DB-backed gatherers and `recordUpgradeWithIntelligence`
 * orchestrator wire those into the live indexing path.
 */

import { prismaWrite, prismaRead } from '../db';
import { diffWasm, type WasmDiff } from './wasm-diff';

/** Approximate Stellar ledger close interval, used to convert ages → ledgers. */
const LEDGER_SECONDS = 5;
/** Upgraders younger than ~1 day of ledgers are treated as "newly created". */
const NEW_ACCOUNT_LEDGERS = Math.round((24 * 3600) / LEDGER_SECONDS); // 17,280
/** A vulnerability disclosed within this window before an upgrade is "same-day". */
const VULN_WINDOW_MS = 24 * 3600 * 1000;

export type GovernanceType = 'single_key' | 'multisig' | 'timelock' | 'dao' | 'unknown';
export type RiskLevel = 'none' | 'low' | 'medium' | 'high' | 'critical';

// ── Phase 2: governance analysis ──────────────────────────────────────────────

export interface GovernanceSignals {
  /** Number of signers on the authority that executed the upgrade. */
  signerCount?: number;
  /** Signature weight / threshold required to act. */
  threshold?: number;
  hasTimelock?: boolean;
  /** Enforced delay (seconds) before the upgrade could execute. */
  timelockSeconds?: number;
  /** Correlated on-chain governance proposal id, if the upgrade was voted on. */
  daoProposalId?: string | null;
  /** Number of votes recorded on the correlated proposal. */
  daoVotes?: number;
}

export interface GovernanceAnalysis {
  governanceType: GovernanceType;
  isMultisig: boolean;
  signerCount: number;
  threshold: number;
  hasTimelock: boolean;
  timelockSeconds: number;
  daoProposalId: string | null;
  daoVotes: number;
}

/**
 * Resolve the governance posture of an upgrade from raw signals. The primary
 * `governanceType` is the strongest decentralisation indicator present:
 * dao > timelock > multisig > single_key > unknown.
 */
export function analyzeGovernance(signals: GovernanceSignals): GovernanceAnalysis {
  const signerCount = signals.signerCount ?? 0;
  const threshold = signals.threshold ?? 0;
  const timelockSeconds = signals.timelockSeconds ?? 0;
  const hasTimelock = Boolean(signals.hasTimelock || timelockSeconds > 0);
  const daoProposalId = signals.daoProposalId ?? null;
  const daoVotes = signals.daoVotes ?? 0;
  const isMultisig = signerCount > 1;

  let governanceType: GovernanceType;
  if (daoProposalId) governanceType = 'dao';
  else if (hasTimelock) governanceType = 'timelock';
  else if (isMultisig) governanceType = 'multisig';
  else if (signerCount === 1) governanceType = 'single_key';
  else governanceType = 'unknown';

  return {
    governanceType,
    isMultisig,
    signerCount,
    threshold,
    hasTimelock,
    timelockSeconds,
    daoProposalId,
    daoVotes,
  };
}

// ── Decentralisation score (0-100) ────────────────────────────────────────────

/**
 * Human-readable description of how the decentralisation score is composed.
 * Surfaced verbatim by the API so consumers can audit the methodology.
 */
export const DECENTRALIZATION_METHODOLOGY = {
  scale:
    '0 (fully centralised single key) to 100 (broadly decentralised, vote-gated, time-delayed)',
  components: [
    {
      name: 'Authority distribution',
      max: 45,
      detail:
        'single key = 5; multisig = 15 + 5 per additional signer (cap 35) + 10 when threshold covers ≥50% of signers; unknown authority = 0.',
    },
    {
      name: 'Timelock delay',
      max: 25,
      detail: 'present = 10, plus 5 per day of enforced delay (cap 25).',
    },
    {
      name: 'DAO vote correlation',
      max: 30,
      detail: 'upgrade tied to a passed proposal = 15, plus 1 per 10 votes recorded (cap 30).',
    },
  ],
} as const;

/** Compute a 0-100 decentralisation score from a resolved governance analysis. */
export function computeDecentralizationScore(analysis: GovernanceAnalysis): number {
  let authority = 0;
  if (analysis.signerCount === 1) {
    authority = 5;
  } else if (analysis.signerCount > 1) {
    authority = 15 + Math.min(20, (analysis.signerCount - 1) * 5);
    const coverage = analysis.threshold > 0 ? analysis.threshold / analysis.signerCount : 0;
    if (coverage >= 0.5) authority += 10;
    authority = Math.min(45, authority);
  }

  let timelock = 0;
  if (analysis.hasTimelock) {
    const days = analysis.timelockSeconds / (24 * 3600);
    timelock = Math.min(25, 10 + Math.floor(days * 5));
  }

  let dao = 0;
  if (analysis.daoProposalId) {
    dao = Math.min(30, 15 + Math.floor(analysis.daoVotes / 10));
  }

  return Math.max(0, Math.min(100, authority + timelock + dao));
}

// ── Phase 4: suspicious activity ──────────────────────────────────────────────

/** Critical functions whose change is treated as an access-control change. */
const ACCESS_CONTROL_FUNCTIONS = new Set<string>([
  'set_admin',
  'set_administrator',
  'transfer_admin',
  'transfer_ownership',
  'set_owner',
  'set_authority',
  'renounce_ownership',
  'add_signer',
  'remove_signer',
  'set_threshold',
  'upgrade',
]);

export interface SuspiciousContext {
  /** When the upgrade executed. Used for midnight-timing detection. */
  upgradeTime: Date;
  /** Age (in ledgers) of the upgrader account at upgrade time, if known. */
  upgraderAccountAgeLedgers?: number | null;
  /** A vulnerability advisory for this contract disclosed shortly before the upgrade. */
  recentVulnerability?: { id: string; title: string; publishedAt: Date | null } | null;
  /** Critical functions changed by this upgrade (from the WASM diff). */
  criticalFnChanges: string[];
  governanceType: GovernanceType;
}

export interface SuspiciousResult {
  flags: string[];
  isSuspicious: boolean;
  riskLevel: RiskLevel;
}

const FLAG_WEIGHTS: Record<string, number> = {
  post_vuln_upgrade: 3,
  critical_acl_change: 3,
  new_account_upgrader: 2,
  single_key_critical: 2,
  midnight_upgrade: 1,
};

/**
 * Flag suspicious upgrade patterns and roll the flags up into a risk level.
 * Detects: same-day-after-vulnerability, newly-created upgrader account,
 * unusual (midnight UTC) timing, and critical access-control changes —
 * especially when pushed by a single key.
 */
export function detectSuspiciousActivity(ctx: SuspiciousContext): SuspiciousResult {
  const flags: string[] = [];

  if (ctx.recentVulnerability) flags.push('post_vuln_upgrade');

  if (
    ctx.upgraderAccountAgeLedgers != null &&
    ctx.upgraderAccountAgeLedgers >= 0 &&
    ctx.upgraderAccountAgeLedgers < NEW_ACCOUNT_LEDGERS
  ) {
    flags.push('new_account_upgrader');
  }

  const hourUtc = ctx.upgradeTime.getUTCHours();
  if (hourUtc >= 0 && hourUtc < 4) flags.push('midnight_upgrade');

  const aclChange = ctx.criticalFnChanges.some((fn) => ACCESS_CONTROL_FUNCTIONS.has(fn));
  if (aclChange) flags.push('critical_acl_change');

  if (aclChange && ctx.governanceType === 'single_key') flags.push('single_key_critical');

  const score = flags.reduce((sum, flag) => sum + (FLAG_WEIGHTS[flag] ?? 1), 0);
  let riskLevel: RiskLevel;
  if (score === 0) riskLevel = 'none';
  else if (score <= 1) riskLevel = 'low';
  else if (score <= 3) riskLevel = 'medium';
  else if (score <= 5) riskLevel = 'high';
  else riskLevel = 'critical';

  return { flags, isSuspicious: flags.length > 0, riskLevel };
}

// ── DB-backed signal gatherers ────────────────────────────────────────────────

/**
 * Gather governance signals for a contract upgrade from indexed on-chain data:
 * multisig configuration (SignerSnapshot / StellarAccount) and DAO vote
 * correlation (GovernanceProposal/Vote linked to the upgrade tx).
 */
export async function gatherGovernanceSignals(
  contractAddress: string,
  upgrader: string | undefined,
  transactionHash: string | undefined,
): Promise<GovernanceSignals> {
  const signals: GovernanceSignals = {};

  // Multisig: prefer the latest signer snapshot for the contract itself.
  const snapshot = await prismaRead.signerSnapshot.findFirst({
    where: { contractAddress },
    orderBy: { ledgerSequence: 'desc' },
    select: { signers: true, highThreshold: true },
  });
  if (snapshot) {
    const signers = Array.isArray(snapshot.signers) ? (snapshot.signers as unknown[]) : [];
    signals.signerCount = signers.length;
    signals.threshold = snapshot.highThreshold;
  } else if (upgrader) {
    // Fall back to the upgrader's account-level signer configuration.
    const account = await prismaRead.stellarAccount.findUnique({
      where: { address: upgrader },
      select: { numSigners: true, thresholds: true },
    });
    if (account) {
      signals.signerCount = account.numSigners;
      const thresholds = account.thresholds as Record<string, unknown> | null;
      const high = thresholds && typeof thresholds.high === 'number' ? thresholds.high : undefined;
      if (typeof high === 'number') signals.threshold = high;
    }
  }

  // DAO correlation: a governance proposal executed by this upgrade tx, or the
  // most recently executed proposal for the contract.
  const proposal = transactionHash
    ? await prismaRead.governanceProposal.findFirst({
        where: { contractAddress, executionTxHash: transactionHash },
        select: { proposalId: true },
      })
    : null;
  const correlated =
    proposal ??
    (await prismaRead.governanceProposal.findFirst({
      where: { contractAddress, status: 'executed' },
      orderBy: { updatedAt: 'desc' },
      select: { proposalId: true },
    }));
  if (correlated) {
    signals.daoProposalId = correlated.proposalId;
    signals.daoVotes = await prismaRead.governanceVote.count({
      where: { contractAddress, proposalId: correlated.proposalId },
    });
  }

  return signals;
}

/**
 * Gather suspicious-activity context: recent vulnerability disclosures for the
 * contract and the upgrader account's age.
 */
export async function gatherSuspiciousContext(
  contractAddress: string,
  upgrader: string | undefined,
  upgradeTime: Date,
): Promise<Pick<SuspiciousContext, 'recentVulnerability' | 'upgraderAccountAgeLedgers'>> {
  const windowStart = new Date(upgradeTime.getTime() - VULN_WINDOW_MS);

  const advisory = await prismaRead.threatAdvisory.findFirst({
    where: {
      affectedContracts: { has: contractAddress },
      createdAt: { gte: windowStart, lte: upgradeTime },
    },
    orderBy: { createdAt: 'desc' },
    select: { id: true, title: true, publishedAt: true },
  });

  let upgraderAccountAgeLedgers: number | null = null;
  if (upgrader) {
    const account = await prismaRead.stellarAccount.findUnique({
      where: { address: upgrader },
      select: { firstSeen: true, createdAt: true },
    });
    const since = account?.firstSeen ?? account?.createdAt ?? null;
    if (since) {
      const ageSeconds = Math.max(0, (upgradeTime.getTime() - since.getTime()) / 1000);
      upgraderAccountAgeLedgers = Math.floor(ageSeconds / LEDGER_SECONDS);
    }
  }

  return { recentVulnerability: advisory ?? null, upgraderAccountAgeLedgers };
}

// ── Orchestrator ──────────────────────────────────────────────────────────────

export interface RecordUpgradeInput {
  contractAddress: string;
  newWasmHash: string;
  ledgerSequence: number;
  ledgerCloseTime: Date;
  transactionHash?: string;
  upgrader?: string;
  /** Optional bytecode for the previous version (enables the WASM diff). */
  previousWasm?: Buffer | null;
  /** Optional bytecode for the new version (enables the WASM diff). */
  newWasm?: Buffer | null;
}

/**
 * Detect and record a WASM upgrade with the full governance-intelligence
 * layer: diff classification, governance analysis, decentralisation score, and
 * suspicious-activity flags. Idempotent — returns null when the hash is
 * unchanged (no real upgrade) or the contract is unknown.
 */
export async function recordUpgradeWithIntelligence(input: RecordUpgradeInput) {
  const {
    contractAddress,
    newWasmHash,
    ledgerSequence,
    ledgerCloseTime,
    transactionHash,
    upgrader,
  } = input;

  const contract = await prismaWrite.contract.findUnique({
    where: { address: contractAddress },
    select: { wasmHash: true },
  });
  // Contract must be known (FK target) and the hash must have actually changed.
  if (!contract) return null;
  const previousHash = contract.wasmHash ?? null;
  if (previousHash === newWasmHash) return null;

  // Phase 3: WASM diff (only when bytecode is available; otherwise hash-only).
  let diff: WasmDiff | null = null;
  if (input.newWasm) {
    diff = diffWasm(input.previousWasm ?? null, input.newWasm);
  }
  const criticalFnChanges = diff?.functions.criticalChanges ?? [];

  // Phase 2: governance analysis + decentralisation score.
  const signals = await gatherGovernanceSignals(contractAddress, upgrader, transactionHash);
  const governance = analyzeGovernance(signals);
  const decentralizationScore = computeDecentralizationScore(governance);

  // Phase 4: suspicious-activity detection.
  const suspiciousCtx = await gatherSuspiciousContext(contractAddress, upgrader, ledgerCloseTime);
  const suspicious = detectSuspiciousActivity({
    upgradeTime: ledgerCloseTime,
    criticalFnChanges,
    governanceType: governance.governanceType,
    ...suspiciousCtx,
  });

  const record = await prismaWrite.wasmUpgradeHistory.create({
    data: {
      contractAddress,
      previousHash,
      newHash: newWasmHash,
      ledgerSequence,
      ledgerCloseTime,
      transactionHash,
      upgrader,
      upgraderAccountAgeLedgers: suspiciousCtx.upgraderAccountAgeLedgers ?? undefined,
      changeClassification: diff?.severity,
      changeSummary: diff?.summary,
      diffStats: diff
        ? ({
            opcodeChurn: diff.opcodes.churn,
            previousInstructions: diff.opcodes.previousTotal,
            newInstructions: diff.opcodes.newTotal,
            addedOpcodes: diff.opcodes.addedOpcodes,
            removedOpcodes: diff.opcodes.removedOpcodes,
            addedFunctions: diff.functions.added,
            removedFunctions: diff.functions.removed,
            signatureChangedFunctions: diff.functions.signatureChanged,
          } as object)
        : undefined,
      criticalFnChanges,
      governanceType: governance.governanceType,
      signerCount: governance.signerCount || undefined,
      threshold: governance.threshold || undefined,
      timelockSeconds: governance.timelockSeconds || undefined,
      daoProposalId: governance.daoProposalId ?? undefined,
      decentralizationScore,
      suspiciousFlags: suspicious.flags,
      isSuspicious: suspicious.isSuspicious,
      riskLevel: suspicious.riskLevel,
    },
  });

  // Advance the contract's current WASM hash so the next change diffs cleanly.
  await prismaWrite.contract.update({
    where: { address: contractAddress },
    data: { wasmHash: newWasmHash },
  });

  if (suspicious.isSuspicious) {
    console.warn(
      `[upgrade-governance] suspicious upgrade on ${contractAddress} at ledger ${ledgerSequence}: ` +
        `${suspicious.riskLevel} risk [${suspicious.flags.join(', ')}]`,
    );
  }

  return record;
}
