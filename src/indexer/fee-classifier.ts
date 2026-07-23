/**
 * Fee Detection & Classification Engine
 *
 * Detects and classifies all 8 fee types across Soroban protocols by
 * inspecting decoded contract events. Writes FeeEvent rows and triggers
 * incremental ProtocolRevenue aggregation.
 */

import { prismaRead, prismaWrite } from '../db';

type FeeType = string;
type FeeDestination = string;
const feeRead = prismaRead as any;
const feeWrite = prismaWrite as any;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RawEvent {
  txHash: string;
  contractAddress: string;
  topics: string[];
  data: string;
  blockNumber: number;
  timestamp: Date;
  sender?: string;
  receiver?: string;
}

export interface ClassifiedFee {
  txHash: string;
  contractAddress: string;
  feeType: FeeType;
  destination: FeeDestination;
  amount: string;
  token: string;
  usdValue?: number;
  sender?: string;
  receiver?: string;
  blockNumber: number;
  timestamp: Date;
}

// ---------------------------------------------------------------------------
// Topic / function-name patterns for fee detection
// ---------------------------------------------------------------------------

const SWAP_PATTERNS = ['swap', 'exchange', 'trade', 'buy', 'sell'];
const WITHDRAW_PATTERNS = ['withdraw', 'redeem', 'remove_liquidity'];
const PERFORMANCE_PATTERNS = ['performance_fee', 'profit_fee', 'harvest_fee'];
const PROTOCOL_PATTERNS = ['protocol_fee', 'create_position', 'mint_fee', 'burn_fee'];
const LIQUIDATION_PATTERNS = ['liquidate', 'liquidation', 'seize'];
const INTEREST_PATTERNS = ['borrow', 'interest', 'accrue', 'interest_spread'];
const FLASH_LOAN_PATTERNS = ['flash_loan', 'flashloan', 'flash_borrow'];
const REFERRAL_PATTERNS = ['referral', 'referrer', 'referral_fee'];
const INSURANCE_PATTERNS = ['insurance', 'reserve_fund', 'safety_module'];

// Destination detection — applied to receiver address patterns and event topics
const LP_RECEIVER_SUFFIX = ['_pool', '_lp', '_pair'];
const TREASURY_PATTERNS = ['treasury', 'multisig', 'fee_collector'];
const BURN_PATTERNS = ['burn', 'buyback', 'zero'];
const STAKER_PATTERNS = ['staking', 'stake', 'stktoken'];
const INSURANCE_DEST_PATTERNS = ['insurance', 'reserve', 'safety'];
const ECOSYSTEM_PATTERNS = ['ecosystem', 'grants', 'community'];
const TEAM_PATTERNS = ['team', 'vesting', 'founder'];

function matchesAny(value: string, patterns: string[]): boolean {
  const lower = value.toLowerCase();
  return patterns.some((p) => lower.includes(p));
}

// ---------------------------------------------------------------------------
// Classification logic
// ---------------------------------------------------------------------------

export function classifyFeeType(event: RawEvent): FeeType | null {
  const combined = [...event.topics, event.data].join(' ').toLowerCase();

  if (matchesAny(combined, FLASH_LOAN_PATTERNS)) return 'FLASH_LOAN';
  if (matchesAny(combined, REFERRAL_PATTERNS)) return 'REFERRAL';
  if (matchesAny(combined, INSURANCE_PATTERNS)) return 'INSURANCE_CONTRIBUTION';
  if (matchesAny(combined, PERFORMANCE_PATTERNS)) return 'PERFORMANCE';
  if (matchesAny(combined, LIQUIDATION_PATTERNS)) return 'LIQUIDATION';
  if (matchesAny(combined, INTEREST_PATTERNS)) return 'INTEREST_SPREAD';
  if (matchesAny(combined, WITHDRAW_PATTERNS)) return 'WITHDRAWAL';
  if (matchesAny(combined, PROTOCOL_PATTERNS)) return 'PROTOCOL';
  if (matchesAny(combined, SWAP_PATTERNS)) return 'SWAP';

  return null;
}

export function classifyDestination(event: RawEvent): FeeDestination {
  const receiver = (event.receiver ?? '').toLowerCase();
  const combined = [...event.topics, event.data, receiver].join(' ').toLowerCase();

  if (matchesAny(combined, BURN_PATTERNS)) return 'BUYBACK_BURN';
  if (matchesAny(combined, INSURANCE_DEST_PATTERNS)) return 'INSURANCE_FUND';
  if (matchesAny(combined, ECOSYSTEM_PATTERNS)) return 'ECOSYSTEM_FUND';
  if (matchesAny(combined, TEAM_PATTERNS)) return 'TEAM_VESTING';
  if (matchesAny(combined, STAKER_PATTERNS)) return 'STAKER_REWARDS';
  if (matchesAny(combined, TREASURY_PATTERNS)) return 'TREASURY';
  if (LP_RECEIVER_SUFFIX.some((s) => receiver.endsWith(s))) return 'LP_REWARDS';

  // Default: treat unknown distribution as LP rewards
  return 'LP_REWARDS';
}

export function extractAmount(event: RawEvent): string {
  // Best-effort: look for a numeric value in event data
  const match = event.data.match(/(\d+(?:\.\d+)?)/);
  return match ? match[1] : '0';
}

export function extractToken(event: RawEvent): string {
  const match = event.data.match(/([A-Z]{2,12})/);
  return match ? match[1] : 'XLM';
}

// ---------------------------------------------------------------------------
// Store a classified fee event
// ---------------------------------------------------------------------------

export async function classifyAndStore(events: RawEvent[]): Promise<ClassifiedFee[]> {
  const classified: ClassifiedFee[] = [];

  for (const event of events) {
    const feeType = classifyFeeType(event);
    if (!feeType) continue;

    const fee: ClassifiedFee = {
      txHash: event.txHash,
      contractAddress: event.contractAddress,
      feeType,
      destination: classifyDestination(event),
      amount: extractAmount(event),
      token: extractToken(event),
      sender: event.sender,
      receiver: event.receiver,
      blockNumber: event.blockNumber,
      timestamp: event.timestamp,
    };

    classified.push(fee);
  }

  if (classified.length > 0) {
    await feeWrite.feeEvent.createMany({
      data: classified.map((f) => ({
        txHash: f.txHash,
        contractAddress: f.contractAddress,
        feeType: f.feeType,
        destination: f.destination,
        amount: f.amount,
        usdValue: f.usdValue,
        token: f.token,
        sender: f.sender,
        receiver: f.receiver,
        blockNumber: f.blockNumber,
        timestamp: f.timestamp,
      })),
      skipDuplicates: true,
    });
  }

  return classified;
}

// ---------------------------------------------------------------------------
// Protocol discovery — find contracts emitting fee events not yet profiled
// ---------------------------------------------------------------------------

export async function discoverFeeContracts(): Promise<string[]> {
  const knownProfiles: any[] = await feeRead.protocolProfile.findMany({
    select: { contractAddress: true },
  });
  const known = new Set(knownProfiles.map((p) => p.contractAddress));

  const recentEvents: any[] = await feeRead.feeEvent.findMany({
    select: { contractAddress: true },
    distinct: ['contractAddress'],
    orderBy: { timestamp: 'desc' },
    take: 500,
  });

  return recentEvents.map((e) => e.contractAddress).filter((addr) => !known.has(addr));
}

// ---------------------------------------------------------------------------
// APR / APY computation helpers
// ---------------------------------------------------------------------------

export function computeLpApr(
  lpRewardsPerPeriod: number,
  tvl: number,
  periodsPerYear: number,
): number {
  if (tvl <= 0) return 0;
  return (lpRewardsPerPeriod / tvl) * periodsPerYear * 100;
}

export function computeStakingApr(
  stakerRewardsPerPeriod: number,
  stakedTvl: number,
  periodsPerYear: number,
): number {
  if (stakedTvl <= 0) return 0;
  return (stakerRewardsPerPeriod / stakedTvl) * periodsPerYear * 100;
}

export function computeApy(apr: number, compoundsPerYear: number = 365): number {
  if (apr <= 0) return 0;
  return (Math.pow(1 + apr / 100 / compoundsPerYear, compoundsPerYear) - 1) * 100;
}

// ---------------------------------------------------------------------------
// Anomaly detection — flag spikes or drops vs recent average
// ---------------------------------------------------------------------------

export async function detectAnomalies(contractAddress: string): Promise<void> {
  const recent: any[] = await feeRead.protocolRevenue.findMany({
    where: { contractAddress, period: 'DAY' },
    orderBy: { timestamp: 'desc' },
    take: 31,
  });

  if (recent.length < 7) return;

  const latest = recent[0];
  const baseline = recent.slice(1, 8);
  const avgBaseline = baseline.reduce((s, r) => s + Number(r.totalFees), 0) / baseline.length;
  const latestFees = Number(latest.totalFees);

  if (avgBaseline === 0) return;

  const ratio = latestFees / avgBaseline;

  if (ratio > 3) {
    await feeWrite.revenueAlert.create({
      data: {
        contractAddress,
        alertType: 'revenue_spike',
        severity: ratio > 10 ? 'critical' : 'warning',
        message: `Revenue spike: ${(ratio * 100).toFixed(0)}% of 7d average`,
        metadata: { ratio, latestFees, avgBaseline },
        detectedAt: new Date(),
      },
    });
  } else if (ratio < 0.2) {
    await feeWrite.revenueAlert.create({
      data: {
        contractAddress,
        alertType: 'revenue_drop',
        severity: 'warning',
        message: `Revenue drop: only ${(ratio * 100).toFixed(0)}% of 7d average`,
        metadata: { ratio, latestFees, avgBaseline },
        detectedAt: new Date(),
      },
    });
  }
}
