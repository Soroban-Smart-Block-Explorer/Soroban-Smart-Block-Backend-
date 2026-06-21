import { prismaRead as prisma } from '../db';

export interface OraclePriceUpdate {
  oracleAddress: string;
  assetPair: string;
  price: string;
  timestamp: number;
  source: 'chainlink' | 'pyth' | 'band' | 'generic';
  confidence?: string;
  updateFrequency?: number;
}

export interface OracleAnalyticalMatrix {
  assetPair: string;
  source: string;
  priceHistory: Array<{
    price: string;
    timestamp: number;
    ledger: number;
  }>;
  updateCount: number;
  averagePrice: string;
  minPrice: string;
  maxPrice: string;
  volatility: number;
  lastUpdate: number;
}

const ORACLE_PATTERNS = {
  chainlink: /chainlink|link_price|price_feed/i,
  pyth: /pyth|pyth_price|oracle_price/i,
  band: /band|band_oracle/i,
};

const TRUSTED_ORACLES = new Set([
  'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
  'CBQHD3BLRBPN4UKOXKYZJSQJWLJREAB2HY42VSOMPCVJ7MZJVTPV5Z7',
]);

/**
 * Detect if a transaction is a high-frequency oracle update.
 * Filters out oracle updates from standard user transaction views.
 */
export function isOracleUpdate(
  functionName: string | null,
  contractAddress: string | null,
): boolean {
  if (!functionName || !contractAddress) return false;

  const fnLower = functionName.toLowerCase();
  const isOracleFunction =
    fnLower.includes('update') || fnLower.includes('price') || fnLower.includes('feed');

  const isTrustedOracle =
    TRUSTED_ORACLES.has(contractAddress) ||
    Object.values(ORACLE_PATTERNS).some((pattern) => pattern.test(contractAddress));

  return isOracleFunction && isTrustedOracle;
}

/**
 * Extract oracle price update metadata from transaction.
 */
export async function extractOraclePriceUpdate(
  transactionHash: string,
): Promise<OraclePriceUpdate | null> {
  const transaction = await prisma.transaction.findUnique({
    where: { hash: transactionHash },
    include: { events: true, ledger: true },
  });

  if (!transaction) return null;

  const args = transaction.functionArgs as any;
  const source = detectOracleSource(transaction.contractAddress || '');

  // Extract price data from function args
  let price = '0';
  let assetPair = 'unknown';

  if (args?.price) price = String(args.price);
  if (args?.asset_pair) assetPair = String(args.asset_pair);
  if (args?.pair) assetPair = String(args.pair);

  // Try to extract from events
  for (const event of transaction.events) {
    const decoded = event.decoded as any;
    if (decoded?.price) price = String(decoded.price);
    if (decoded?.asset_pair) assetPair = String(decoded.asset_pair);
  }

  return {
    oracleAddress: transaction.contractAddress || '',
    assetPair,
    price,
    timestamp: transaction.ledger?.closeTime.getTime() || 0,
    source,
    confidence: args?.confidence,
    updateFrequency: args?.update_frequency,
  };
}

function detectOracleSource(contractAddress: string): 'chainlink' | 'pyth' | 'band' | 'generic' {
  if (ORACLE_PATTERNS.chainlink.test(contractAddress)) return 'chainlink';
  if (ORACLE_PATTERNS.pyth.test(contractAddress)) return 'pyth';
  if (ORACLE_PATTERNS.band.test(contractAddress)) return 'band';
  return 'generic';
}

/**
 * Build analytical matrix for historical price tracking.
 * Aggregates oracle updates into optimized data structure for charting.
 */
export async function buildOracleAnalyticalMatrix(
  assetPair: string,
  source?: string,
  ledgerRangeStart?: number,
  ledgerRangeEnd?: number,
): Promise<OracleAnalyticalMatrix | null> {
  const transactions = await prisma.transaction.findMany({
    where: {
      functionName: {
        contains: 'price',
      },
      ledgerSequence: {
        gte: ledgerRangeStart || 0,
        lte: ledgerRangeEnd || Number.MAX_SAFE_INTEGER,
      },
    },
    include: { ledger: true },
    orderBy: { ledgerSequence: 'asc' },
    take: 10000,
  });

  const priceHistory: Array<{
    price: string;
    timestamp: number;
    ledger: number;
  }> = [];

  let totalPrice = 0;
  let minPrice = Number.MAX_SAFE_INTEGER;
  let maxPrice = 0;

  for (const tx of transactions) {
    const update = await extractOraclePriceUpdate(tx.hash);
    if (!update || update.assetPair !== assetPair) continue;
    if (source && update.source !== source) continue;

    const priceNum = parseFloat(update.price);
    priceHistory.push({
      price: update.price,
      timestamp: update.timestamp,
      ledger: tx.ledgerSequence,
    });

    totalPrice += priceNum;
    minPrice = Math.min(minPrice, priceNum);
    maxPrice = Math.max(maxPrice, priceNum);
  }

  if (priceHistory.length === 0) return null;

  const avgPrice = (totalPrice / priceHistory.length).toFixed(8);
  const volatility = calculateVolatility(priceHistory);

  return {
    assetPair,
    source: source || 'all',
    priceHistory,
    updateCount: priceHistory.length,
    averagePrice: avgPrice,
    minPrice: minPrice.toFixed(8),
    maxPrice: maxPrice.toFixed(8),
    volatility,
    lastUpdate: priceHistory[priceHistory.length - 1]?.timestamp || 0,
  };
}

function calculateVolatility(
  priceHistory: Array<{ price: string; timestamp: number; ledger: number }>,
): number {
  if (priceHistory.length < 2) return 0;

  const prices = priceHistory.map((p) => parseFloat(p.price));
  const mean = prices.reduce((a, b) => a + b, 0) / prices.length;
  const variance = prices.reduce((sum, p) => sum + Math.pow(p - mean, 2), 0) / prices.length;

  return Math.sqrt(variance);
}

/**
 * Store oracle analytical matrix for efficient querying.
 */
export async function storeOracleMatrix(matrix: OracleAnalyticalMatrix): Promise<void> {
  // Store in a dedicated table or cache for fast retrieval
  // For now, we'll store in contract metadata
  const contracts = await prisma.contract.findMany({
    where: {
      functionSignatures: {
        path: ['$[*].name'],
        string_contains: 'price',
      },
    },
    take: 1,
  });

  if (contracts.length > 0) {
    const existingAbi =
      typeof contracts[0].abi === 'object' && contracts[0].abi !== null ? contracts[0].abi : {};

    await prisma.contract.update({
      where: { id: contracts[0].id },
      data: {
        abi: {
          ...existingAbi,
          _oracleMatrix: {
            assetPair: matrix.assetPair,
            source: matrix.source,
            updateCount: matrix.updateCount,
            averagePrice: matrix.averagePrice,
            minPrice: matrix.minPrice,
            maxPrice: matrix.maxPrice,
            volatility: matrix.volatility,
            lastUpdate: matrix.lastUpdate,
          },
        },
      },
    });
  }
}

/**
 * Filter oracle updates from transaction list.
 * Returns only user transactions, excluding high-frequency oracle updates.
 */
export async function filterOutOracleUpdates(transactions: any[]): Promise<any[]> {
  return transactions.filter((tx) => !isOracleUpdate(tx.functionName, tx.contractAddress));
}
