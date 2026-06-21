/**
 * SAC G-Account Unlimited Trustline Mapper (CAP-0073)
 *
 * Tracks unlimited-token trustlines initiated natively from Soroban
 * smart contracts (Stellar Asset Contracts) directly into standard
 * classic Stellar G-addresses.
 *
 * Links each Soroban-initiated trustline to its originating transaction
 * and attempts to pair it with the corresponding classic ChangeTrustOp
 * historical record to maintain a cohesive unified ledger for
 * institutional asset holding states.
 */

import { prismaWrite as prisma } from '../db';

// ── Constants ─────────────────────────────────────────────────────────────────

const UNLIMITED_LIMIT_THRESHOLD = BigInt('9223372036854775807'); // Max int64

// SAC function names related to trustline management (CAP-0073)
const TRUSTLINE_FUNCTIONS = new Set([
  'set_trustline',
  'change_trust',
  'set_trustline_with_limit',
  'update_trustline',
]);

// Event symbols indicating a trustline change
const TRUSTLINE_EVENT_SYMBOLS = new Set([
  'trustline_changed',
  'trustline_updated',
  'trustline_created',
  'trustline_removed',
]);

// Function name patterns that suggest trustline operations
const TRUSTLINE_NAME_PATTERNS = [
  'trustline',
  'change_trust',
  'set_trust',
  'allow_trust',
  'trust_limit',
];

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TrustlineOpDetected {
  gAccount: string;
  sacAddress: string;
  assetCode: string;
  assetIssuer: string | null;
  assetType: string;
  trustlineLimit: string;
  isUnlimited: boolean;
  status: 'active' | 'deactivated' | 'frozen';
  transactionHash: string;
  ledgerSequence: number;
  ledgerCloseTime: Date;
  changeTrustOpLedger: number | null;
  changeTrustOpTxHash: string | null;
  origin: 'soroban' | 'classic';
}

export interface TrustlineMapperResult {
  gAccount: string;
  sacAddress: string;
  assetCode: string;
  assetIssuer: string | null;
  assetType: string;
  trustlineLimit: string;
  isUnlimited: boolean;
  status: string;
  transactionHash: string;
  ledgerSequence: number;
  ledgerCloseTime: Date;
  changeTrustOpLedger: number | null;
  changeTrustOpTxHash: string | null;
  origin: string;
  humanReadable: string;
}

// ── Detection ─────────────────────────────────────────────────────────────────

/**
 * Check if a function name indicates a SAC trustline operation.
 */
export function isTrustlineFunction(functionName: string | null): boolean {
  if (!functionName) return false;

  const lower = functionName.toLowerCase();
  if (TRUSTLINE_FUNCTIONS.has(lower)) return true;
  return TRUSTLINE_NAME_PATTERNS.some((p) => lower.includes(p));
}

/**
 * Check if an event symbol indicates a trustline change.
 */
export function isTrustlineEvent(eventType: string | null, topicSymbol: string | null): boolean {
  if (topicSymbol && TRUSTLINE_EVENT_SYMBOLS.has(topicSymbol)) return true;
  if (eventType && TRUSTLINE_EVENT_SYMBOLS.has(eventType)) return true;
  return false;
}

/**
 * Determine if a trustline limit counts as "unlimited".
 * The max int64 value (9223372036854775807) is the standard sentinel
 * for an unlimited trustline in Stellar.
 */
export function isUnlimitedTrustline(limit: string): boolean {
  try {
    const limitBig = BigInt(limit);
    return limitBig >= UNLIMITED_LIMIT_THRESHOLD;
  } catch {
    return false;
  }
}

/**
 * Heuristic: extract the G-account address from function arguments
 * represented as decoded JSON args.  Looks for common field names
 * that hold the classic account address.
 */
export function extractGAccountFromArgs(
  functionArgs: Record<string, unknown> | null,
): string | null {
  if (!functionArgs) return null;

  const candidateKeys = [
    'account',
    'to',
    'from',
    'address',
    'g_account',
    'gAddress',
    'g_address',
    'target',
    'holder',
    'trustor',
    'trusted',
    'trustee',
  ];

  for (const key of candidateKeys) {
    const val = functionArgs[key];
    if (typeof val === 'string' && val.startsWith('G')) return val;
    if (typeof val === 'string' && val.startsWith('C')) continue; // contract address, skip
  }

  // Search nested values
  for (const val of Object.values(functionArgs)) {
    if (typeof val === 'object' && val !== null) {
      const nested = val as Record<string, unknown>;
      for (const key of candidateKeys) {
        const nestedVal = nested[key];
        if (typeof nestedVal === 'string' && nestedVal.startsWith('G')) return nestedVal;
      }
    }
  }

  return null;
}

/**
 * Extract the trustline limit from function arguments.
 * Returns "0" if not found.
 */
export function extractTrustlineLimit(functionArgs: Record<string, unknown> | null): string {
  if (!functionArgs) return '0';

  const limitKeys = ['limit', 'amount', 'trustline_limit', 'max_amount', 'ceiling'];
  for (const key of limitKeys) {
    const val = functionArgs[key];
    if (val != null) {
      const str = String(val);
      if (str.length > 0 && !isNaN(Number(str))) return str;
    }
  }

  return '0';
}

/**
 * Extract asset type from function args or derive from SAC context.
 */
export function extractAssetType(
  functionArgs: Record<string, unknown> | null,
  assetCode?: string,
): string {
  if (assetCode === 'XLM') return 'native';
  if (!functionArgs) return 'credit_alphanum4';

  const typeVal = functionArgs['asset_type'] ?? functionArgs['assetType'];
  if (typeVal && typeof typeVal === 'string') {
    if (typeVal.includes('4')) return 'credit_alphanum4';
    if (typeVal.includes('12')) return 'credit_alphanum12';
    if (typeVal.includes('native')) return 'native';
  }

  return 'credit_alphanum4';
}

// ── ChangeTrustOp matching ────────────────────────────────────────────────────

/**
 * Attempt to find a matching classic ChangeTrustOp transaction for a given
 * Soroban-initiated trustline. Scans the same ledger for classic transactions
 * that set a trustline for the same G-account and asset.
 *
 * This is a heuristic — in practice, the ChangeTrustOp may appear in the
 * same ledger or an adjacent ledger.
 */
export async function findMatchingChangeTrustOp(
  gAccount: string,
  assetCode: string,
  assetIssuer: string | null,
  ledgerSequence: number,
): Promise<{ ledger: number; txHash: string } | null> {
  const searchRange = 5; // look ±5 ledgers from the Soroban trustline creation

  const minLedger = Math.max(1, ledgerSequence - searchRange);
  const maxLedger = ledgerSequence + searchRange;

  // Query transactions in the range that might be classic ChangeTrustOps.
  // Classic transactions won't have a contractAddress, but may reference
  // the G-account as the sourceAccount.
  const candidates = await prisma.transaction.findMany({
    where: {
      sourceAccount: gAccount,
      ledgerSequence: { gte: minLedger, lte: maxLedger },
      contractAddress: null, // classic transactions have no contract address
    },
    select: {
      hash: true,
      ledgerSequence: true,
      rawXdr: true,
      humanReadable: true,
    },
    orderBy: { ledgerSequence: 'asc' },
    take: 20,
  });

  // Filter: look for transactions whose humanReadable or rawXdr suggests
  // a ChangeTrust operation for the target asset
  for (const tx of candidates) {
    const lower = (tx.humanReadable ?? '').toLowerCase();
    const rawLower = tx.rawXdr.toLowerCase();

    const mentionsAsset =
      lower.includes(assetCode.toLowerCase()) || rawLower.includes(assetCode.toLowerCase());
    const mentionsTrustline = lower.includes('trust') || rawLower.includes('trust');

    if (mentionsAsset && mentionsTrustline) {
      return { ledger: tx.ledgerSequence, txHash: tx.hash };
    }
  }

  // Broader search: any transaction with the G-account as source
  // in the same ledger that could be a ChangeTrustOp
  const sameLedger = await prisma.transaction.findMany({
    where: {
      sourceAccount: gAccount,
      ledgerSequence,
      contractAddress: null,
    },
    select: { hash: true, ledgerSequence: true },
    orderBy: { hash: 'asc' },
    take: 5,
  });

  if (sameLedger.length > 0) {
    return { ledger: sameLedger[0].ledgerSequence, txHash: sameLedger[0].hash };
  }

  return null;
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Detect and record SAC trustline operations for a single transaction.
 * Idempotent — safe to call multiple times.
 */
export async function trackSacTrustline(
  transactionHash: string,
  sourceAccount: string,
  contractAddress: string | null,
  functionName: string | null,
  functionArgs: Record<string, unknown> | null,
  humanReadable: string | null,
  feeCharged: string | null,
  sorobanResources: Record<string, unknown> | null,
  ledgerSequence: number,
  ledgerCloseTime: Date,
): Promise<TrustlineMapperResult | null> {
  // Skip if no contract address (classic transaction)
  if (!contractAddress) return null;

  const isTrustlineOp = isTrustlineFunction(functionName);
  if (!isTrustlineOp) return null;

  // Extract G-account from args or default to sourceAccount
  const gAccount = extractGAccountFromArgs(functionArgs) ?? sourceAccount;

  // Look up SAC mapping to get asset details
  const sacMapping = await prisma.sacMapping.findUnique({
    where: { sacAddress: contractAddress },
  });

  const assetCode = sacMapping?.assetCode ?? (functionArgs?.['asset_code'] as string) ?? 'unknown';
  const assetIssuer = sacMapping?.assetIssuer ?? (functionArgs?.['asset_issuer'] as string) ?? null;
  const assetType = sacMapping?.assetType ?? extractAssetType(functionArgs, assetCode);

  const trustlineLimit = extractTrustlineLimit(functionArgs);
  const unlimited = isUnlimitedTrustline(trustlineLimit);

  // Attempt to match with classic ChangeTrustOp
  const changeTrustOp = await findMatchingChangeTrustOp(
    gAccount,
    assetCode,
    assetIssuer,
    ledgerSequence,
  );

  const status: 'active' | 'deactivated' | 'frozen' = 'active';

  await prisma.sacTrustlineMapping.upsert({
    where: { gAccount_sacAddress: { gAccount, sacAddress: contractAddress } },
    update: {
      trustlineLimit,
      isUnlimited: unlimited,
      status,
      transactionHash,
      ledgerSequence,
      ledgerCloseTime,
      changeTrustOpLedger: changeTrustOp?.ledger ?? null,
      changeTrustOpTxHash: changeTrustOp?.txHash ?? null,
    },
    create: {
      gAccount,
      sacAddress: contractAddress,
      assetCode,
      assetIssuer,
      assetType,
      trustlineLimit,
      isUnlimited: unlimited,
      status,
      transactionHash,
      ledgerSequence,
      ledgerCloseTime,
      changeTrustOpLedger: changeTrustOp?.ledger ?? null,
      changeTrustOpTxHash: changeTrustOp?.txHash ?? null,
      origin: 'soroban',
    },
  });

  const unlimitedLabel = unlimited ? 'unlimited' : `${trustlineLimit}`;
  const changeTrustLabel = changeTrustOp
    ? ` (matched with ChangeTrustOp in ledger ${changeTrustOp.ledger})`
    : ' (no classic ChangeTrustOp matched yet)';

  const humanReadableSummary = `${gAccount} → ${assetCode}${assetIssuer ? `:${assetIssuer}` : ''} trustline set to ${unlimitedLabel} via SAC${changeTrustLabel}`;

  return {
    gAccount,
    sacAddress: contractAddress,
    assetCode,
    assetIssuer,
    assetType,
    trustlineLimit,
    isUnlimited: unlimited,
    status,
    transactionHash,
    ledgerSequence,
    ledgerCloseTime,
    changeTrustOpLedger: changeTrustOp?.ledger ?? null,
    changeTrustOpTxHash: changeTrustOp?.txHash ?? null,
    origin: 'soroban',
    humanReadable: humanReadableSummary,
  };
}

/**
 * Attempt to detect a trustline event and record it.
 * Called during event ingestion for events that signal trustline changes.
 */
export async function trackTrustlineEvent(
  transactionHash: string,
  contractAddress: string,
  sourceAccount: string,
  eventType: string,
  topicSymbol: string | null,
  eventDecoded: Record<string, unknown> | null,
  ledgerSequence: number,
  ledgerCloseTime: Date,
  sorobanResources: Record<string, unknown> | null,
): Promise<TrustlineMapperResult | null> {
  if (!isTrustlineEvent(eventType, topicSymbol)) return null;

  // Extract G-account from event data
  const gAccount = extractGAccountFromArgs(eventDecoded) ?? sourceAccount;

  // Look up SAC mapping
  const sacMapping = await prisma.sacMapping.findUnique({
    where: { sacAddress: contractAddress },
  });

  const assetCode = sacMapping?.assetCode ?? 'unknown';
  const assetIssuer = sacMapping?.assetIssuer ?? null;
  const assetType = sacMapping?.assetType ?? 'credit_alphanum4';

  // Extract limit from event data if available
  const trustlineLimit = eventDecoded?.['limit']
    ? String(eventDecoded['limit'])
    : eventDecoded?.['amount']
      ? String(eventDecoded['amount'])
      : '9223372036854775807';

  const unlimited = isUnlimitedTrustline(trustlineLimit);

  const changeTrustOp = await findMatchingChangeTrustOp(
    gAccount,
    assetCode,
    assetIssuer,
    ledgerSequence,
  );

  const isRemoved = topicSymbol === 'trustline_removed';
  const status: 'active' | 'deactivated' | 'frozen' = isRemoved ? 'deactivated' : 'active';

  await prisma.sacTrustlineMapping.upsert({
    where: { gAccount_sacAddress: { gAccount, sacAddress: contractAddress } },
    update: {
      trustlineLimit,
      isUnlimited: unlimited,
      status,
      transactionHash,
      ledgerSequence,
      ledgerCloseTime,
      changeTrustOpLedger: changeTrustOp?.ledger ?? null,
      changeTrustOpTxHash: changeTrustOp?.txHash ?? null,
    },
    create: {
      gAccount,
      sacAddress: contractAddress,
      assetCode,
      assetIssuer,
      assetType,
      trustlineLimit,
      isUnlimited: unlimited,
      status,
      transactionHash,
      ledgerSequence,
      ledgerCloseTime,
      changeTrustOpLedger: changeTrustOp?.ledger ?? null,
      changeTrustOpTxHash: changeTrustOp?.txHash ?? null,
      origin: 'soroban',
    },
  });

  const unlimitedLabel = unlimited ? 'unlimited' : trustlineLimit;
  const action = isRemoved ? 'removed' : 'set';
  const humanReadableSummary = `${gAccount} ${action} trustline for ${assetCode}${assetIssuer ? `:${assetIssuer}` : ''} (${unlimitedLabel}) via SAC event`;

  return {
    gAccount,
    sacAddress: contractAddress,
    assetCode,
    assetIssuer,
    assetType,
    trustlineLimit,
    isUnlimited: unlimited,
    status,
    transactionHash,
    ledgerSequence,
    ledgerCloseTime,
    changeTrustOpLedger: changeTrustOp?.ledger ?? null,
    changeTrustOpTxHash: changeTrustOp?.txHash ?? null,
    origin: 'soroban',
    humanReadable: humanReadableSummary,
  };
}

// ── Query helpers ─────────────────────────────────────────────────────────────

/**
 * Fetch trustline mappings for a G-account.
 */
export async function getTrustlinesByAccount(
  gAccount: string,
  limit: number = 50,
): Promise<TrustlineMapperResult[]> {
  const records = await prisma.sacTrustlineMapping.findMany({
    where: { gAccount },
    orderBy: { ledgerSequence: 'desc' },
    take: limit,
  });

  return records.map(formatResult);
}

/**
 * Fetch trustline mappings for a SAC contract address.
 */
export async function getTrustlinesBySac(
  sacAddress: string,
  limit: number = 50,
): Promise<TrustlineMapperResult[]> {
  const records = await prisma.sacTrustlineMapping.findMany({
    where: { sacAddress },
    orderBy: { ledgerSequence: 'desc' },
    take: limit,
  });

  return records.map(formatResult);
}

/**
 * Fetch a specific trustline mapping by G-account and SAC address.
 */
export async function getTrustlineByAccountAndSac(
  gAccount: string,
  sacAddress: string,
): Promise<TrustlineMapperResult | null> {
  const record = await prisma.sacTrustlineMapping.findUnique({
    where: { gAccount_sacAddress: { gAccount, sacAddress } },
  });

  return record ? formatResult(record) : null;
}

/**
 * Get aggregate statistics for SAC trustline mappings.
 */
export async function getSacTrustlineStats() {
  const [total, active, unlimited, byAsset] = await Promise.all([
    prisma.sacTrustlineMapping.count(),
    prisma.sacTrustlineMapping.count({ where: { status: 'active' } }),
    prisma.sacTrustlineMapping.count({ where: { isUnlimited: true } }),
    prisma.sacTrustlineMapping.groupBy({
      by: ['assetCode'],
      _count: true,
      orderBy: { _count: { assetCode: 'desc' } },
      take: 20,
    }),
  ]);

  return {
    totalTrustlines: total,
    activeTrustlines: active,
    unlimitedTrustlines: unlimited,
    uniqueAssets: byAsset.length,
    topAssets: byAsset.map((a) => ({
      assetCode: a.assetCode,
      count: a._count,
    })),
  };
}

function formatResult(r: any): TrustlineMapperResult {
  const unlimitedLabel = r.isUnlimited ? 'unlimited' : r.trustlineLimit;
  const changeTrustLabel = r.changeTrustOpLedger
    ? ` (matched with ChangeTrustOp in ledger ${r.changeTrustOpLedger})`
    : '';

  return {
    gAccount: r.gAccount,
    sacAddress: r.sacAddress,
    assetCode: r.assetCode,
    assetIssuer: r.assetIssuer,
    assetType: r.assetType,
    trustlineLimit: r.trustlineLimit,
    isUnlimited: r.isUnlimited,
    status: r.status,
    transactionHash: r.transactionHash,
    ledgerSequence: r.ledgerSequence,
    ledgerCloseTime: r.ledgerCloseTime,
    changeTrustOpLedger: r.changeTrustOpLedger,
    changeTrustOpTxHash: r.changeTrustOpTxHash,
    origin: r.origin,
    humanReadable: `${r.gAccount} → ${r.assetCode}${r.assetIssuer ? `:${r.assetIssuer}` : ''} trustline (${unlimitedLabel}) [${r.status}]${changeTrustLabel}`,
  };
}
