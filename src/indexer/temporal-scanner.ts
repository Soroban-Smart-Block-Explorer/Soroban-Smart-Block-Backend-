/**
 * Temporal Scanner — Multi-Pattern Timer Detection Engine
 *
 * Scans transactions and contract ABIs to detect time-dependent operations
 * and creates/updates ScheduledOperation, VestingSchedule, and
 * GovernanceTimelock records.
 */
import { prismaWrite as prisma } from '../db';

// ── Timer-type heuristics ─────────────────────────────────────────────────────

const TIMELOCK_FUNCTIONS = ['execute', 'queue', 'cancel', 'schedule', 'timelock'];
const VESTING_FUNCTIONS = ['vest', 'vesting', 'claim', 'release', 'unlock', 'cliff'];
const DEADLINE_FUNCTIONS = ['bid', 'buy', 'expire', 'settle', 'end', 'close_auction'];
const COOLDOWN_FUNCTIONS = ['withdraw', 'unstake', 'redeem', 'cooldown'];
const RECURRING_FUNCTIONS = ['distribute', 'rebase', 'harvest', 'drip', 'emit'];

/** Detect timer type from function name heuristics. */
export function detectTimerType(
  functionName: string,
): 'TIMELOCK' | 'VESTING' | 'DEADLINE' | 'COOLDOWN' | 'RECURRING' | 'ABSOLUTE' | null {
  const fn = functionName.toLowerCase();
  if (TIMELOCK_FUNCTIONS.some((k) => fn.includes(k))) return 'TIMELOCK';
  if (RECURRING_FUNCTIONS.some((k) => fn.includes(k))) return 'RECURRING';
  if (VESTING_FUNCTIONS.some((k) => fn.includes(k))) return 'VESTING';
  if (DEADLINE_FUNCTIONS.some((k) => fn.includes(k))) return 'DEADLINE';
  if (COOLDOWN_FUNCTIONS.some((k) => fn.includes(k))) return 'COOLDOWN';
  return null;
}

/** Detect timer type from ABI parameter names. */
export function detectTimerTypeFromAbi(
  params: Array<{ name?: string; type?: string }>,
): 'VESTING' | 'TIMELOCK' | 'DEADLINE' | 'ABSOLUTE' | null {
  for (const p of params) {
    const n = (p.name ?? '').toLowerCase();
    const t = (p.type ?? '').toLowerCase();
    if (t === 'timestamp' || n.includes('timestamp') || n.includes('unlock_time'))
      return 'ABSOLUTE';
    if (n.includes('cliff')) return 'VESTING';
    if (n.includes('delay') || n.includes('timelock')) return 'TIMELOCK';
    if (n.includes('deadline') || n.includes('expiry')) return 'DEADLINE';
  }
  return null;
}

// ── Transaction processing ────────────────────────────────────────────────────

interface TxEvent {
  contractAddress: string;
  functionName: string;
  args?: Record<string, unknown>;
  txHash?: string;
  ledgerCloseTime: Date;
}

/** Extract a timestamp value from transaction args if present. */
function extractTimestamp(args: Record<string, unknown> | undefined): Date | null {
  if (!args) return null;
  for (const key of Object.keys(args)) {
    const k = key.toLowerCase();
    if (
      k.includes('timestamp') ||
      k.includes('unlock_time') ||
      k.includes('execute_time') ||
      k.includes('deadline')
    ) {
      const val = args[key];
      if (typeof val === 'number' || typeof val === 'string') {
        const ts = Number(val);
        // Soroban timestamps are Unix seconds
        if (ts > 1_000_000_000 && ts < 9_999_999_999) {
          return new Date(ts * 1000);
        }
      }
    }
  }
  return null;
}

/** Extract interval in seconds from args for recurring operations. */
function extractInterval(args: Record<string, unknown> | undefined): number | null {
  if (!args) return null;
  for (const key of Object.keys(args)) {
    const k = key.toLowerCase();
    if (k.includes('interval') || k.includes('period') || k.includes('frequency')) {
      const val = Number(args[key]);
      if (val > 0) return val;
    }
  }
  return null;
}

/**
 * Process a single transaction event and upsert a ScheduledOperation if
 * the function looks time-dependent.
 */
export async function processTxForTimers(event: TxEvent): Promise<void> {
  const timerType = detectTimerType(event.functionName);
  if (!timerType) return;

  const triggerTime = extractTimestamp(event.args) ?? event.ledgerCloseTime;
  const intervalSeconds = timerType === 'RECURRING' ? extractInterval(event.args) : null;
  const now = event.ledgerCloseTime;

  // Deduplicate by contract + function + source tx
  const existing = event.txHash
    ? await prisma.scheduledOperation.findFirst({
        where: {
          contractAddress: event.contractAddress,
          functionName: event.functionName,
          sourceTx: event.txHash,
        },
      })
    : null;

  if (existing) return;

  await prisma.scheduledOperation.create({
    data: {
      contractAddress: event.contractAddress,
      timerType,
      status: triggerTime > now ? 'PENDING' : 'ACTIVE',
      functionName: event.functionName,
      triggerTime,
      intervalSeconds,
      parameters: (event.args as object) ?? null,
      sourceTx: event.txHash ?? null,
      detectedAt: now,
      nextTriggerAt: triggerTime,
    },
  });
}

// ── Vesting schedule detection ────────────────────────────────────────────────

interface VestingArgs {
  contractAddress: string;
  tokenAddress?: string;
  beneficiary?: string;
  totalAmount?: string;
  startTime?: number;
  endTime?: number;
  cliffTime?: number;
  sourceTx?: string;
}

export async function processVestingEvent(args: VestingArgs): Promise<void> {
  if (!args.beneficiary || !args.startTime || !args.endTime) return;

  const existing = args.sourceTx
    ? await prisma.vestingSchedule.findFirst({ where: { sourceTx: args.sourceTx } })
    : null;
  if (existing) return;

  const startDate = new Date(args.startTime * 1000);
  const endDate = new Date(args.endTime * 1000);
  const cliffDate = args.cliffTime ? new Date(args.cliffTime * 1000) : null;

  await prisma.vestingSchedule.create({
    data: {
      contractAddress: args.contractAddress,
      tokenAddress: args.tokenAddress ?? args.contractAddress,
      beneficiary: args.beneficiary,
      totalAmount: args.totalAmount ?? '0',
      startDate,
      endDate,
      cliffDate,
      vestingType: cliffDate ? 'cliff' : 'linear',
      nextUnlockDate: cliffDate ?? startDate,
      status: 'active',
      sourceTx: args.sourceTx ?? null,
      detectedAt: new Date(),
    },
  });
}

// ── Governance timelock detection ─────────────────────────────────────────────

interface TimelockArgs {
  contractAddress: string;
  proposalId?: string;
  proposer?: string;
  minDelay?: number;
  targets?: unknown[];
  sourceTx?: string;
}

export async function processTimelockEvent(args: TimelockArgs): Promise<void> {
  if (!args.proposer) return;

  const existing = args.sourceTx
    ? await prisma.governanceTimelock.findFirst({
        where: { contractAddress: args.contractAddress, executedTx: args.sourceTx },
      })
    : null;
  if (existing) return;

  const minDelay = args.minDelay ?? 86400; // default 1 day
  const queuedAt = new Date();
  const executionTime = new Date(queuedAt.getTime() + minDelay * 1000);
  const expiryTime = new Date(executionTime.getTime() + 30 * 24 * 3600 * 1000); // 30d grace

  await prisma.governanceTimelock.create({
    data: {
      contractAddress: args.contractAddress,
      proposalId: args.proposalId ?? null,
      proposer: args.proposer,
      targets: (args.targets as object[]) ?? [],
      values: [],
      calldatas: [],
      queuedAt,
      minDelay,
      executionTime,
      expiryTime,
      gracePeriod: 30 * 24 * 3600,
      status: 'queued',
    },
  });
}

// ── Periodic re-scan ──────────────────────────────────────────────────────────

/**
 * Mark overdue ScheduledOperations as EXPIRED or update RECURRING next trigger.
 * Call this periodically (e.g. every minute).
 */
export async function reconcileScheduledOperations(): Promise<void> {
  const now = new Date();

  // Expire overdue pending operations
  await prisma.scheduledOperation.updateMany({
    where: {
      status: { in: ['PENDING', 'ACTIVE'] },
      timerType: { notIn: ['RECURRING'] },
      triggerTime: { lt: new Date(now.getTime() - 7 * 24 * 3600 * 1000) },
    },
    data: { status: 'EXPIRED' },
  });

  // Advance recurring operations
  const recurring = await prisma.scheduledOperation.findMany({
    where: {
      status: 'ACTIVE',
      timerType: 'RECURRING',
      nextTriggerAt: { lt: now },
      intervalSeconds: { not: null },
    },
  });

  for (const op of recurring) {
    const next = new Date(
      (op.nextTriggerAt ?? now).getTime() + (op.intervalSeconds ?? 86400) * 1000,
    );
    const shouldStop = op.recurrenceCount !== null && op.eventsExecuted >= op.recurrenceCount;
    await prisma.scheduledOperation.update({
      where: { id: op.id },
      data: {
        eventsExecuted: { increment: 1 },
        lastExecutedAt: now,
        nextTriggerAt: shouldStop ? null : next,
        status: shouldStop ? 'EXECUTED' : 'ACTIVE',
      },
    });
  }

  // Mark expired governance timelocks
  await prisma.governanceTimelock.updateMany({
    where: { status: { in: ['queued', 'executable'] }, expiryTime: { lt: now } },
    data: { status: 'expired' },
  });

  // Mark queued timelocks ready to execute
  await prisma.governanceTimelock.updateMany({
    where: { status: 'queued', executionTime: { lte: now } },
    data: { status: 'executable' },
  });

  // Update vesting statuses
  await prisma.vestingSchedule.updateMany({
    where: { status: 'active', endDate: { lt: now } },
    data: { status: 'completed' },
  });
}
