/**
 * BN254 ZK-Host Function Gas Exemption Tracker (CAP-0080)
 *
 * Detects Soroban transactions that invoke BN254 (alt_bn128) curve host
 * functions — bn254_add, bn254_mul, bn254_pairing_check, bn254_scalar_mul,
 * bn254_multiscalar_mul — and computes the gas savings versus equivalent
 * Wasm-side cryptographic computation.
 *
 * Native host functions are ~74% cheaper because they bypass Wasm
 * interpretation overhead and execute directly in the Rust VM.
 */

import { prismaWrite as prisma } from '../db';

// ── Constants ─────────────────────────────────────────────────────────────────

const BN254_OPERATIONS = [
  'bn254_add',
  'bn254_mul',
  'bn254_scalar_mul',
  'bn254_pairing_check',
  'bn254_multiscalar_mul',
] as const;

type Bn254Op = (typeof BN254_OPERATIONS)[number];

/**
 * Estimated Wasm-vs-host cost multipliers per operation type.
 * Derived from CAP-0080 benchmarks: Wasm bn254 curve ops consume
 * 3-5x more CPU instructions than native host function calls.
 */
const WASM_COST_MULTIPLIERS: Record<Bn254Op, number> = {
  bn254_add: 5.0,
  bn254_mul: 4.0,
  bn254_scalar_mul: 4.0,
  bn254_pairing_check: 3.2,
  bn254_multiscalar_mul: 3.6,
};

/**
 * Base resource cost (CPU instructions) per host function call.
 * These approximate the native cost of each operation in the Soroban host.
 */
const HOST_BASE_CPU: Record<Bn254Op, number> = {
  bn254_add: 1_000,
  bn254_mul: 15_000,
  bn254_scalar_mul: 15_000,
  bn254_pairing_check: 500_000,
  bn254_multiscalar_mul: 20_000,
};

// Function-name patterns that suggest BN254 / elliptic-curve usage
const BN254_NAME_PATTERNS = [
  'bn254',
  'alt_bn128',
  'ec_add',
  'ec_mul',
  'ec_pairing',
  'pairing_check',
  'verify_proof',
  'verify_snark',
  'verify_groth16',
  'multiscalar_mul',
  'msm',
  'scalar_mul',
  'point_add',
  'point_mul',
  'bn_add',
  'bn_mul',
  'bn_pair',
];

// ── Types ─────────────────────────────────────────────────────────────────────

export interface Bn254DetectionResult {
  detectedOps: Bn254Op[];
  opCount: number;
  // Complexity factor for MSM operations (number of scalar-point pairs)
  msmComplexity: number;
  // Estimated Wasm-equivalent CPU instructions
  estimatedWasmCpu: number;
  // Estimated Wasm-equivalent fee in stroops
  estimatedWasmFee: string;
  // Net stroop savings
  stroopSavings: string;
  // Savings as a percentage of the Wasm cost
  savingsPct: number;
}

export interface Bn254TrackerResult {
  bn254Ops: string[];
  opCount: number;
  feeCharged: string | null;
  estimatedWasmFee: string | null;
  stroopSavings: string | null;
  savingsPct: number | null;
  cpuInstructions: number;
  msmComplexity: number;
  humanReadable: string;
}

// ── Detection ─────────────────────────────────────────────────────────────────

/**
 * Detect BN254 operations from a function name and optional CPU instruction
 * count. Returns the list of detected BN254 operation types.
 */
export function detectBn254Ops(functionName: string | null): Bn254Op[] {
  if (!functionName) return [];

  const lower = functionName.toLowerCase();
  const detected: Bn254Op[] = [];

  for (const pattern of BN254_NAME_PATTERNS) {
    if (lower.includes(pattern)) {
      // Map generic patterns to the canonical BN254 operation types
      if (
        lower.includes('bn254_add') ||
        lower.includes('ec_add') ||
        lower.includes('point_add') ||
        lower.includes('bn_add')
      ) {
        if (!detected.includes('bn254_add')) detected.push('bn254_add');
      }
      if (
        lower.includes('bn254_mul') ||
        lower.includes('ec_mul') ||
        lower.includes('point_mul') ||
        lower.includes('bn_mul')
      ) {
        if (!detected.includes('bn254_mul')) detected.push('bn254_mul');
      }
      if (
        lower.includes('bn254_scalar_mul') ||
        (lower.includes('scalar_mul') && !lower.includes('multiscalar'))
      ) {
        if (!detected.includes('bn254_scalar_mul')) detected.push('bn254_scalar_mul');
      }
      if (
        lower.includes('bn254_pairing') ||
        lower.includes('pairing_check') ||
        lower.includes('ec_pairing') ||
        lower.includes('bn_pair')
      ) {
        if (!detected.includes('bn254_pairing_check')) detected.push('bn254_pairing_check');
      }
      if (
        lower.includes('bn254_multiscalar') ||
        lower.includes('multiscalar') ||
        lower.includes('msm')
      ) {
        if (!detected.includes('bn254_multiscalar_mul')) detected.push('bn254_multiscalar_mul');
      }
      // Direct matches for canonical names
      if (lower.includes('bn254_add') && !detected.includes('bn254_add'))
        detected.push('bn254_add');
      if (
        (lower.includes('bn254_mul') || lower.includes('bn254_scalar_mul')) &&
        !detected.includes('bn254_scalar_mul') &&
        !detected.includes('bn254_mul')
      ) {
        if (lower.includes('bn254_scalar_mul')) detected.push('bn254_scalar_mul');
        else detected.push('bn254_mul');
      }
    }
  }

  // For ZKP verifier functions, infer the primary operation
  if (
    lower.includes('verify_proof') ||
    lower.includes('verify_snark') ||
    lower.includes('verify_groth16')
  ) {
    if (!detected.includes('bn254_pairing_check')) detected.push('bn254_pairing_check');
    if (!detected.includes('bn254_multiscalar_mul')) detected.push('bn254_multiscalar_mul');
  }

  return detected;
}

/**
 * Estimate the MSM complexity from function name and resource data.
 * Multi-scalar multiplication cost scales with number of scalar-point pairs.
 */
export function estimateMsmComplexity(
  functionName: string | null,
  cpuInstructions: number,
): number {
  if (!functionName) return 0;

  const lower = functionName.toLowerCase();
  const hasMsm = lower.includes('multiscalar') || lower.includes('msm');

  if (!hasMsm) return 0;

  // If we have CPU instructions, estimate MSM size from CPU budget
  // Each scalar-point pair in MSM costs roughly 15k CPU instructions via host
  if (cpuInstructions > 0) {
    return Math.max(1, Math.round(cpuInstructions / 15_000));
  }

  // Fallback: check for numeric patterns in function name (e.g. msm_128, multiscalar_64)
  const numMatch = lower.match(/(\d+)/);
  if (numMatch) {
    return parseInt(numMatch[1], 10);
  }

  return 2; // conservative default
}

/**
 * Compute the Wasm-equivalent cost multiplier based on detected BN254
 * operation mix. Returns a blended multiplier.
 */
export function computeWasmMultiplier(ops: Bn254Op[]): number {
  if (ops.length === 0) return 1.0;

  const total = ops.reduce((sum, op) => sum + WASM_COST_MULTIPLIERS[op], 0);
  return total / ops.length;
}

/**
 * Calculate estimated Wasm CPU instructions for a given set of BN254
 * operations and complexity.
 */
export function estimateWasmCpu(ops: Bn254Op[], msmComplexity: number): number {
  if (ops.length === 0) return 0;

  let hostCpu = 0;
  for (const op of ops) {
    if (op === 'bn254_multiscalar_mul') {
      hostCpu += HOST_BASE_CPU[op] + msmComplexity * 15_000;
    } else {
      hostCpu += HOST_BASE_CPU[op];
    }
  }

  // Wasm equivalent: multiply each operation by its cost multiplier
  let wasmCpu = 0;
  for (const op of ops) {
    if (op === 'bn254_multiscalar_mul') {
      const base = HOST_BASE_CPU[op] + msmComplexity * 15_000;
      wasmCpu += Math.round(base * WASM_COST_MULTIPLIERS[op]);
    } else {
      wasmCpu += Math.round(HOST_BASE_CPU[op] * WASM_COST_MULTIPLIERS[op]);
    }
  }

  return wasmCpu;
}

/**
 * Compute gas savings metrics.
 *
 * Uses the actual fee charged and the estimated Wasm-equivalent cost
 * to derive net stroop savings and percentage saved.
 *
 * When actual CPU instructions are available from soroban resources,
 * they are used to refine the estimate.
 */
export function calculateSavings(
  ops: Bn254Op[],
  feeCharged: string | null,
  cpuInstructions: number,
  msmComplexity: number,
): {
  estimatedWasmFee: string | null;
  stroopSavings: string | null;
  savingsPct: number | null;
} {
  if (!feeCharged || ops.length === 0) {
    return { estimatedWasmFee: null, stroopSavings: null, savingsPct: null };
  }

  const actualFee = BigInt(feeCharged);
  if (actualFee <= 0n) {
    return { estimatedWasmFee: null, stroopSavings: null, savingsPct: null };
  }

  let multiplier = computeWasmMultiplier(ops);

  // Refine the multiplier when we have actual CPU instruction data
  if (cpuInstructions > 0) {
    const wasmCpu = estimateWasmCpu(ops, msmComplexity);
    if (wasmCpu > 0) {
      // Blend the theoretical multiplier with the CPU-based estimate
      const cpuBasedMultiplier = Math.max(1.0, wasmCpu / Math.max(1, cpuInstructions));
      multiplier = (multiplier + cpuBasedMultiplier) / 2;
    }
  }

  const estimatedWasm = BigInt(Math.round(Number(actualFee) * multiplier));
  const savings = estimatedWasm - actualFee;
  const savingsPct = estimatedWasm > 0n ? Number((savings * 100n) / estimatedWasm) : 0;

  return {
    estimatedWasmFee: estimatedWasm.toString(),
    stroopSavings: savings.toString(),
    savingsPct: Math.min(99.9, Math.round(savingsPct * 10) / 10),
  };
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Detect BN254 host function usage and compute gas exemption savings for
 * a single transaction. Idempotent — safe to call multiple times.
 */
export async function trackBn254GasExemption(
  transactionHash: string,
  contractAddress: string | null,
  functionName: string | null,
  feeCharged: string | null,
  sorobanResources: Record<string, unknown> | null,
  ledgerSequence: number,
  ledgerCloseTime: Date,
): Promise<Bn254TrackerResult | null> {
  const ops = detectBn254Ops(functionName);

  // Skip if no BN254 operations detected
  if (ops.length === 0) return null;

  const cpuInstructions = Number((sorobanResources as any)?.cpuInstructions ?? 0);
  const msmComplexity = estimateMsmComplexity(functionName, cpuInstructions);
  const { estimatedWasmFee, stroopSavings, savingsPct } = calculateSavings(
    ops,
    feeCharged,
    cpuInstructions,
    msmComplexity,
  );

  // Build a human-readable summary
  const opsSummary = ops.join(', ');
  const pct = savingsPct ?? 0;
  const humanReadable = `Saved ${pct}% in processing fees via host ZK acceleration (${opsSummary})`;

  await prisma.bn254GasExemption.upsert({
    where: { transactionHash },
    update: {
      bn254Ops: ops,
      opCount: ops.length,
      feeCharged,
      estimatedWasmFee,
      stroopSavings,
      savingsPct,
      cpuInstructions,
      msmComplexity,
    },
    create: {
      transactionHash,
      contractAddress,
      bn254Ops: ops,
      opCount: ops.length,
      feeCharged,
      estimatedWasmFee,
      stroopSavings,
      savingsPct,
      cpuInstructions,
      msmComplexity,
      ledgerSequence,
      ledgerCloseTime,
    },
  });

  return {
    bn254Ops: ops,
    opCount: ops.length,
    feeCharged,
    estimatedWasmFee,
    stroopSavings,
    savingsPct,
    cpuInstructions,
    msmComplexity,
    humanReadable,
  };
}

// ── Query helpers ─────────────────────────────────────────────────────────────

/**
 * Fetch BN254 gas exemption records for a given transaction hash.
 */
export async function getBn254ExemptionByTx(
  transactionHash: string,
): Promise<Bn254TrackerResult | null> {
  const record = await prisma.bn254GasExemption.findUnique({
    where: { transactionHash },
  });

  if (!record) return null;

  return {
    bn254Ops: (record.bn254Ops as string[]) ?? [],
    opCount: record.opCount,
    feeCharged: record.feeCharged,
    estimatedWasmFee: record.estimatedWasmFee,
    stroopSavings: record.stroopSavings,
    savingsPct: record.savingsPct,
    cpuInstructions: record.cpuInstructions,
    msmComplexity: record.msmComplexity,
    humanReadable:
      record.savingsPct != null
        ? `Saved ${record.savingsPct}% in processing fees via host ZK acceleration (${(record.bn254Ops as string[]).join(', ')})`
        : '',
  };
}

/**
 * Fetch BN254 gas exemption records for a contract address.
 */
export async function getBn254ExemptionsByContract(
  contractAddress: string,
  limit: number = 20,
): Promise<Bn254TrackerResult[]> {
  const records = await prisma.bn254GasExemption.findMany({
    where: { contractAddress },
    orderBy: { ledgerSequence: 'desc' },
    take: limit,
  });

  return records.map((r) => ({
    bn254Ops: (r.bn254Ops as string[]) ?? [],
    opCount: r.opCount,
    feeCharged: r.feeCharged,
    estimatedWasmFee: r.estimatedWasmFee,
    stroopSavings: r.stroopSavings,
    savingsPct: r.savingsPct,
    cpuInstructions: r.cpuInstructions,
    msmComplexity: r.msmComplexity,
    humanReadable:
      r.savingsPct != null
        ? `Saved ${r.savingsPct}% in processing fees via host ZK acceleration (${(r.bn254Ops as string[]).join(', ')})`
        : '',
  }));
}

/**
 * Fetch aggregate BN254 gas exemption statistics.
 */
export async function getBn254AggregateStats(limit: number = 1000) {
  const records = await prisma.bn254GasExemption.findMany({
    orderBy: { ledgerSequence: 'desc' },
    take: limit,
    select: {
      transactionHash: true,
      savingsPct: true,
      stroopSavings: true,
      estimatedWasmFee: true,
      feeCharged: true,
      opCount: true,
      ledgerSequence: true,
      ledgerCloseTime: true,
    },
  });

  if (records.length === 0) {
    return {
      totalTransactions: 0,
      totalStroopSavings: '0',
      avgSavingsPct: 0,
      totalOps: 0,
      recentTransactions: [],
    };
  }

  let totalSavings = 0n;
  let totalFeeCharged = 0n;

  for (const r of records) {
    if (r.stroopSavings) totalSavings += BigInt(r.stroopSavings);
    if (r.feeCharged) totalFeeCharged += BigInt(r.feeCharged);
  }

  const avgPct = records.reduce((sum, r) => sum + (r.savingsPct ?? 0), 0) / records.length;
  const totalOps = records.reduce((sum, r) => sum + r.opCount, 0);

  return {
    totalTransactions: records.length,
    totalStroopSavings: totalSavings.toString(),
    totalFeeCharged: totalFeeCharged.toString(),
    avgSavingsPct: Math.round(avgPct * 10) / 10,
    totalOps,
    recentTransactions: records.slice(0, 10).map((r) => ({
      hash: r.transactionHash,
      savingsPct: r.savingsPct,
      stroopSavings: r.stroopSavings,
      opCount: r.opCount,
      ledger: r.ledgerSequence,
      timestamp: r.ledgerCloseTime,
    })),
  };
}
