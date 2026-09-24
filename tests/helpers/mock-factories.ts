/**
 * Typed Mock Factory Helpers
 *
 * Provides type-safe factory functions for creating mock data in tests.
 * Replaces "as never" / "as any" casts with proper TypeScript inference.
 *
 * Benefits:
 * - ✅ Full TypeScript type checking on mock data
 * - ✅ IDE autocomplete for mock properties
 * - ✅ Compile-time error detection
 * - ✅ Self-documenting mock structure
 * - ✅ Reusable across tests
 */

import { MevType, Prisma } from '@prisma/client';

// ─────────────────────────────────────────────────────────────────────
// MEV Classification Mocks
// ─────────────────────────────────────────────────────────────────────

export interface MevEventMock {
  id: string;
  txHash: string;
  ledgerSeq: number;
  timestamp: Date;
  mevType: MevType;
  victimAddress?: string | null;
  attackerAddress?: string | null;
  protocolAddress?: string | null;
  profitUsd?: number | null;
  confidence: number;
  details?: Prisma.JsonValue;
  createdAt: Date;
  updatedAt: Date;
}

export interface MevVictimMock {
  id: string;
  address: string;
  totalLossUsd: number;
  victimCount: number;
  lastVictimized: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface MevAttackerMock {
  id: string;
  address: string;
  totalProfitUsd: number;
  attackCount: number;
  lastAttack: Date;
  strategies: Prisma.JsonValue;
  createdAt: Date;
  updatedAt: Date;
}

export interface MevAlertMock {
  id: string;
  txHash: string;
  mevEventId: string;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  reason: string;
  acknowledged: boolean;
  createdAt: Date;
}

/**
 * Create a typed MevEvent mock
 *
 * @example
 * const event = createMevEventMock({
 *   txHash: 'abc123',
 *   mevType: 'SANDWICH',
 *   confidence: 0.95,
 * });
 */
export function createMevEventMock(overrides: Partial<MevEventMock> = {}): MevEventMock {
  return {
    id: 'mev-1',
    txHash: 'txhash123',
    ledgerSeq: 1000,
    timestamp: new Date('2026-01-01'),
    mevType: 'SANDWICH' as MevType,
    victimAddress: 'GAVICTIM123',
    attackerAddress: 'GAATTACKER123',
    protocolAddress: 'GAPROTOCOL123',
    profitUsd: 1500.5,
    confidence: 0.85,
    details: { pattern: 'sandwich_attack' },
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides,
  };
}

/**
 * Create a typed MevVictim mock
 */
export function createMevVictimMock(overrides: Partial<MevVictimMock> = {}): MevVictimMock {
  return {
    id: 'victim-1',
    address: 'GAVICTIM123',
    totalLossUsd: 5000,
    victimCount: 3,
    lastVictimized: new Date('2026-01-01'),
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides,
  };
}

/**
 * Create a typed MevAttacker mock
 */
export function createMevAttackerMock(overrides: Partial<MevAttackerMock> = {}): MevAttackerMock {
  return {
    id: 'attacker-1',
    address: 'GAATTACKER123',
    totalProfitUsd: 50000,
    attackCount: 25,
    lastAttack: new Date('2026-01-01'),
    strategies: { primary: 'sandwich', secondary: 'frontrun' },
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides,
  };
}

/**
 * Create a typed MevAlert mock
 */
export function createMevAlertMock(overrides: Partial<MevAlertMock> = {}): MevAlertMock {
  return {
    id: 'alert-1',
    txHash: 'txhash123',
    mevEventId: 'mev-1',
    severity: 'HIGH',
    reason: 'Sandwich attack detected',
    acknowledged: false,
    createdAt: new Date('2026-01-01'),
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Arbitrage Mocks
// ─────────────────────────────────────────────────────────────────────

export interface DexPoolMock {
  id: string;
  contractAddress: string;
  reserve0: string;
  reserve1: string;
  token0: string;
  token1: string;
  fee: number;
  lpCount: number;
  volumeUsd24h: number;
  tvlUsd: number;
  lastUpdated: Date;
}

/**
 * Create a typed DexPool mock
 *
 * @example
 * const pool = createDexPoolMock({
 *   token0: 'USDC',
 *   token1: 'XLM',
 *   tvlUsd: 1000000,
 * });
 */
export function createDexPoolMock(overrides: Partial<DexPoolMock> = {}): DexPoolMock {
  return {
    id: 'pool-1',
    contractAddress: 'CAPOOL123',
    reserve0: '1000000000',
    reserve1: '5000000',
    token0: 'USDC',
    token1: 'XLM',
    fee: 25,
    lpCount: 150,
    volumeUsd24h: 500000,
    tvlUsd: 2000000,
    lastUpdated: new Date('2026-01-01'),
    ...overrides,
  };
}

export interface PriceGraphNode {
  token: string;
  price: number;
}

export interface PriceGraphEdge {
  from: string;
  to: string;
  rate: number;
  poolId: string;
}

/**
 * Create a typed price graph node
 */
export function createPriceGraphNode(token: string, price: number = 1.0): PriceGraphNode {
  return { token, price };
}

/**
 * Create a typed price graph edge
 */
export function createPriceGraphEdge(
  from: string,
  to: string,
  rate: number = 1.0,
  poolId: string = 'pool-default',
): PriceGraphEdge {
  return { from, to, rate, poolId };
}

// ─────────────────────────────────────────────────────────────────────
// Stellar Integration Mocks
// ─────────────────────────────────────────────────────────────────────

export interface StellarAssetMock {
  code: string;
  issuer: string;
  nativeBalance?: string;
  balance?: string;
  limit?: string;
  isAuthorized?: boolean;
}

export interface StellarAccountMock {
  id: string;
  accountId: string;
  balances: StellarAssetMock[];
  sequenceNumber: string;
  signers: Array<{ key: string; weight: number }>;
  flags: {
    authRequired: boolean;
    authRevocable: boolean;
    clawbackEnabled: boolean;
  };
}

/**
 * Create a typed Stellar asset mock
 */
export function createStellarAssetMock(
  overrides: Partial<StellarAssetMock> = {},
): StellarAssetMock {
  return {
    code: 'USDC',
    issuer: 'GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXUSMIQSTBE2EURIDVXL6B',
    balance: '1000.00',
    limit: '100000.00',
    isAuthorized: true,
    ...overrides,
  };
}

/**
 * Create a typed Stellar account mock
 */
export function createStellarAccountMock(
  overrides: Partial<StellarAccountMock> = {},
): StellarAccountMock {
  return {
    id: 'account-1',
    accountId: 'GBRPYHIL2CI3WHZDTOOQFC6EB4MSTOF5U37GFHOGM4FUGPVZERVREYX',
    balances: [createStellarAssetMock({ code: 'XLM' }), createStellarAssetMock({ code: 'USDC' })],
    sequenceNumber: '12345678901234567',
    signers: [{ key: 'GBRPYHIL2CI3WHZDTOOQFC6EB4MSTOF5U37GFHOGM4FUGPVZERVREYX', weight: 1 }],
    flags: {
      authRequired: false,
      authRevocable: false,
      clawbackEnabled: false,
    },
    ...overrides,
  };
}

export interface StellarTransactionMock {
  id: string;
  hash: string;
  ledger: number;
  createdAt: Date;
  sourceAccount: string;
  feeCharged: number;
  operationCount: number;
  envelope_xdr: string;
  result_xdr: string;
  result_meta_xdr: string;
}

/**
 * Create a typed Stellar transaction mock
 */
export function createStellarTransactionMock(
  overrides: Partial<StellarTransactionMock> = {},
): StellarTransactionMock {
  return {
    id: 'tx-1',
    hash: 'txhash123abc456',
    ledger: 50000000,
    createdAt: new Date('2026-01-01T12:00:00Z'),
    sourceAccount: 'GBRPYHIL2CI3WHZDTOOQFC6EB4MSTOF5U37GFHOGM4FUGPVZERVREYX',
    feeCharged: 100,
    operationCount: 1,
    envelope_xdr: 'base64_encoded_xdr_data',
    result_xdr: 'base64_result_xdr',
    result_meta_xdr: 'base64_meta_xdr',
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Generic Helpers
// ─────────────────────────────────────────────────────────────────────

/**
 * Create an array of mocks using a factory function
 *
 * @example
 * const events = createArrayOf(createMevEventMock, 5, {
 *   confidence: 0.9,
 * });
 */
export function createArrayOf<T>(
  factory: (overrides: Partial<T>) => T,
  count: number,
  overrides?: Partial<T>,
): T[] {
  return Array.from({ length: count }, (_, i) =>
    factory({
      ...overrides,
      id: `${overrides?.id || 'item'}-${i + 1}`,
    } as Partial<T>),
  );
}

/**
 * Create aggregation result mock for Prisma aggregate queries
 *
 * @example
 * const agg = createAggregateMock({ _sum: { profitUsd: 100 } });
 */
export function createAggregateMock<T extends Record<string, unknown>>(data: T): T {
  return data;
}

/**
 * Create grouped result mock for Prisma groupBy queries
 *
 * @example
 * const grouped = createGroupedMock([
 *   { mevType: 'SANDWICH', _count: { _all: 10 } },
 * ]);
 */
export function createGroupedMock<T extends Record<string, unknown>>(data: T[]): T[] {
  return data;
}
