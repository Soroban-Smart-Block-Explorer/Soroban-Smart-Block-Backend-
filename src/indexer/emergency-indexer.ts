import { prismaWrite, prismaRead } from '../db';
import { broadcastEmergencyEvent } from '../ws/eventBroadcaster';
import { logger } from '../logger';

// Pause-related event topic symbols
const PAUSE_TOPICS = ['contract_paused', 'paused', 'emergency_stop', 'pause'];
const UNPAUSE_TOPICS = ['contract_unpaused', 'unpaused', 'unpause'];

// Recovery function patterns for WASM/ABI analysis
const RECOVERY_PATTERNS = {
  fund: ['emergency_withdraw', 'recover_funds', 'claim_stuck_tokens', 'drain', 'rescue'],
  upgrade: ['upgrade', 'set_implementation', 'update_contract', 'migrate_to'],
  migration: ['migrate', 'export_state', 'import_state', 'clone'],
  rollback: ['snapshot', 'rollback', 'revert_state', 'checkpoint'],
  admin: ['change_admin', 'transfer_ownership', 'renounce'],
};

function matchFunctions(fnNames: string[], patterns: string[]): string[] {
  return fnNames.filter((fn) => patterns.some((p) => fn.toLowerCase().includes(p)));
}

function computeRecoveryScore(analysis: {
  hasFundRecovery: boolean;
  hasUpgradeCapability: boolean;
  hasMigrationCapability: boolean;
  hasStateRollback: boolean;
  hasAdminRecovery: boolean;
}): number {
  let score = 0;
  if (analysis.hasFundRecovery) score += 30;
  if (analysis.hasUpgradeCapability) score += 25;
  if (analysis.hasMigrationCapability) score += 20;
  if (analysis.hasStateRollback) score += 15;
  if (analysis.hasAdminRecovery) score += 10;
  return score;
}

function computeDecentralizationScore(
  type: string,
  threshold?: number,
  total?: number,
  timelockDays?: number,
): number {
  switch (type) {
    case 'single_admin': return 10;
    case 'multi_sig': {
      const ratio = threshold && total ? threshold / total : 0.5;
      return Math.round(21 + ratio * 39); // 21–60
    }
    case 'timelock': return Math.min(100, 50 + (timelockDays ?? 0) * 10);
    case 'dao': return 75;
    case 'automatic': return 90;
    default: return 0;
  }
}

export function classifyRisk(score: number): string {
  if (score <= 20) return 'critical';
  if (score <= 40) return 'high';
  if (score <= 60) return 'medium';
  if (score <= 80) return 'low';
  return 'minimal';
}

/** Analyse a contract's ABI/function signatures to derive pauser + recovery info */
export async function analyzeContract(contractAddress: string): Promise<void> {
  const contract = await prismaRead.contract.findUnique({
    where: { address: contractAddress },
    select: { functionSignatures: true, abi: true },
  });

  const fns: string[] = [];
  if (contract?.functionSignatures) {
    const sigs = contract.functionSignatures as Array<{ name: string }>;
    fns.push(...sigs.map((s) => s.name));
  }
  if (contract?.abi) {
    const abi = contract.abi as { functions?: Array<{ name: string }> };
    if (abi.functions) fns.push(...abi.functions.map((f) => f.name));
  }

  // Pauser analysis
  const hasPause = fns.some((f) => PAUSE_TOPICS.some((p) => f.toLowerCase().includes(p)));
  if (hasPause) {
    const pauserType = fns.some((f) => f.includes('vote') || f.includes('proposal'))
      ? 'dao'
      : fns.some((f) => f.includes('timelock') || f.includes('delay'))
      ? 'timelock'
      : fns.some((f) => f.includes('multisig') || f.includes('multi_sig'))
      ? 'multi_sig'
      : 'single_admin';

    const score = computeDecentralizationScore(pauserType);

    await prismaWrite.pauserAnalysis.upsert({
      where: { contractAddress },
      create: {
        contractAddress,
        pauserType,
        pauserAddresses: [],
        unpauserAddresses: [],
        analysisMethod: 'abi_analysis',
      },
      update: { pauserType, analysisMethod: 'abi_analysis', lastAnalyzed: new Date() },
    });

    await prismaWrite.emergencyState.upsert({
      where: { contractAddress },
      create: { contractAddress, pauserType, decentralizationScore: score },
      update: { pauserType, decentralizationScore: score, updatedAt: new Date() },
    });
  }

  // Recovery analysis
  const fundFns = matchFunctions(fns, RECOVERY_PATTERNS.fund);
  const upgradeFns = matchFunctions(fns, RECOVERY_PATTERNS.upgrade);
  const migFns = matchFunctions(fns, RECOVERY_PATTERNS.migration);
  const rollFns = matchFunctions(fns, RECOVERY_PATTERNS.rollback);
  const adminFns = matchFunctions(fns, RECOVERY_PATTERNS.admin);

  const score = computeRecoveryScore({
    hasFundRecovery: fundFns.length > 0,
    hasUpgradeCapability: upgradeFns.length > 0,
    hasMigrationCapability: migFns.length > 0,
    hasStateRollback: rollFns.length > 0,
    hasAdminRecovery: adminFns.length > 0,
  });

  await prismaWrite.recoveryAnalysis.upsert({
    where: { contractAddress },
    create: {
      contractAddress,
      hasFundRecovery: fundFns.length > 0,
      fundRecoveryFunctions: fundFns,
      hasUpgradeCapability: upgradeFns.length > 0,
      upgradeFunctions: upgradeFns,
      hasMigrationCapability: migFns.length > 0,
      migrationFunctions: migFns,
      hasStateRollback: rollFns.length > 0,
      rollbackFunctions: rollFns,
      recoveryRobustnessScore: score,
    },
    update: {
      hasFundRecovery: fundFns.length > 0,
      fundRecoveryFunctions: fundFns,
      hasUpgradeCapability: upgradeFns.length > 0,
      upgradeFunctions: upgradeFns,
      hasMigrationCapability: migFns.length > 0,
      migrationFunctions: migFns,
      hasStateRollback: rollFns.length > 0,
      rollbackFunctions: rollFns,
      recoveryRobustnessScore: score,
      lastAnalyzed: new Date(),
    },
  });
}

/** Process a single event row for pause/unpause signals */
export async function processEventForPause(event: {
  id: string;
  contractAddress: string;
  topicSymbol: string | null;
  transactionHash: string;
  ledgerSequence: number;
  ledgerCloseTime: Date;
  decoded: unknown;
  data: unknown;
}): Promise<void> {
  const sym = (event.topicSymbol ?? '').toLowerCase();
  const isPause = PAUSE_TOPICS.some((t) => sym.includes(t));
  const isUnpause = UNPAUSE_TOPICS.some((t) => sym.includes(t));
  if (!isPause && !isUnpause) return;

  const eventType = isPause ? 'pause' : 'unpause';
  const decoded = event.decoded as Record<string, unknown> | null;
  const pauserAddress = (decoded?.pauser ?? decoded?.admin ?? decoded?.caller ?? null) as
    | string
    | null;
  const reason = (decoded?.reason ?? null) as string | null;

  // Get or create emergency state
  const state = await prismaWrite.emergencyState.upsert({
    where: { contractAddress: event.contractAddress },
    create: { contractAddress: event.contractAddress, isPaused: isPause },
    update: {},
  });

  let durationSeconds: bigint | null = null;

  if (isUnpause && state.currentPauseId) {
    // Find the matching pause event to compute duration
    const pauseEv = await prismaRead.pauseEvent.findUnique({
      where: { id: state.currentPauseId },
    });
    if (pauseEv) {
      durationSeconds = BigInt(
        Math.round((event.ledgerCloseTime.getTime() - pauseEv.timestamp.getTime()) / 1000),
      );
    }
  }

  const newPauseEvent = await prismaWrite.pauseEvent.create({
    data: {
      contractAddress: event.contractAddress,
      eventType,
      pauserAddress,
      reason,
      txHash: event.transactionHash,
      blockNumber: event.ledgerSequence,
      timestamp: event.ledgerCloseTime,
      durationSeconds,
      metadata: (event.decoded ?? event.data) as object,
    },
  });

  // Update emergency state
  if (isPause) {
    await prismaWrite.emergencyState.update({
      where: { contractAddress: event.contractAddress },
      data: {
        isPaused: true,
        currentPauseId: newPauseEvent.id,
        totalPauseCount: { increment: 1 },
        updatedAt: new Date(),
      },
    });
  } else {
    await prismaWrite.emergencyState.update({
      where: { contractAddress: event.contractAddress },
      data: {
        isPaused: false,
        currentPauseId: null,
        totalPausedSeconds: durationSeconds
          ? { increment: durationSeconds }
          : undefined,
        lastPauseDurationSeconds: durationSeconds,
        updatedAt: new Date(),
      },
    });
  }

  // Auto-create incident for pause events
  if (isPause) {
    const severity = state.decentralizationScore
      ? Number(state.decentralizationScore) <= 20
        ? 'critical'
        : Number(state.decentralizationScore) <= 40
        ? 'high'
        : 'medium'
      : 'high';

    const contract = await prismaRead.contract.findUnique({
      where: { address: event.contractAddress },
      select: { name: true },
    });

    await prismaWrite.incidentReport.create({
      data: {
        contractAddress: event.contractAddress,
        severity,
        status: 'open',
        pauseEventId: newPauseEvent.id,
        title: `${contract?.name ?? event.contractAddress} paused`,
        description: reason ?? 'Contract pause detected via event monitoring',
        timeline: [
          {
            timestamp: event.ledgerCloseTime.toISOString(),
            event: 'pause_detected',
            detail: `Paused by ${pauserAddress ?? 'unknown'} in tx ${event.transactionHash}`,
          },
        ],
      },
    });
  }

  // Broadcast WebSocket event
  try {
    broadcastEmergencyEvent({
      event: isPause ? 'contract.paused' : 'contract.unpaused',
      data: {
        contract: event.contractAddress,
        pauser: pauserAddress,
        timestamp: event.ledgerCloseTime.toISOString(),
        txHash: event.transactionHash,
        severity: isPause ? 'high' : 'info',
        reason,
      },
    });
  } catch {
    // non-fatal
  }

  logger.info('Emergency event processed', {
    contract: event.contractAddress,
    type: eventType,
    tx: event.transactionHash,
  });
}

/** Periodic scheduler: scan recent events for pause signals */
export async function startEmergencyIndexer(): Promise<void> {
  const INTERVAL_MS = 30_000;

  async function tick() {
    try {
      // Get the latest processed ledger from emergency state
      const lastState = await prismaRead.pauseEvent.findFirst({
        orderBy: { blockNumber: 'desc' },
        select: { blockNumber: true },
      });
      const fromLedger = lastState ? Number(lastState.blockNumber) : 0;

      const events = await prismaRead.event.findMany({
        where: {
          ledgerSequence: { gt: fromLedger },
          topicSymbol: {
            in: [...PAUSE_TOPICS, ...UNPAUSE_TOPICS],
          },
        },
        orderBy: { ledgerSequence: 'asc' },
        take: 500,
      });

      for (const ev of events) {
        await processEventForPause(ev).catch((err) =>
          logger.warn('Failed to process emergency event', { id: ev.id, error: String(err) }),
        );
      }

      // Also analyse any new contracts not yet analysed
      const unanalysed = await prismaRead.contract.findMany({
        where: {
          address: { notIn: (await prismaRead.recoveryAnalysis.findMany({ select: { contractAddress: true } })).map((r) => r.contractAddress) },
          functionSignatures: { not: undefined },
        },
        select: { address: true },
        take: 50,
      });
      for (const c of unanalysed) {
        await analyzeContract(c.address).catch(() => null);
      }
    } catch (err) {
      logger.error('Emergency indexer tick failed', { error: String(err) });
    }
  }

  await tick();
  setInterval(tick, INTERVAL_MS);
  logger.info('Emergency indexer started');
}

export { computeDecentralizationScore, computeRecoveryScore };
