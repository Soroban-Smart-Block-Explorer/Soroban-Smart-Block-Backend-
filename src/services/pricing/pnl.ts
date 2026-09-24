import { prismaRead, prismaWrite } from '../../db';
import { computeCompositePrice } from './composite-price';

/**
 * Multi-network profit/loss and holding analytics for a linked wallet.
 *
 * Holdings are supplied per network (explicit per-network balances) and are
 * priced through the composite price oracle. Token metadata (symbol/decimals)
 * is enriched from the indexed contract registry. When a caller does not know
 * the cost basis of a position, Stellar/Soroban positions can fall back to a
 * cost basis derived from indexed transfer events.
 */

const DEFAULT_DECIMALS = 7;
const EVENT_DERIVATION_LIMIT = 500;

const EVENT_COST_BASIS_NETWORKS = new Set(['stellar', 'soroban']);

export type CostBasisSource = 'provided' | 'events' | 'zero';

export interface NetworkHoldingInput {
  token: string;
  /** Raw integer balance (smallest unit) as a string, e.g. "10000000". */
  balance: string;
  /** Total USD cost basis for the open position (not per-unit). */
  costBasisUsd?: number;
  /** Lifetime realized P&L already booked for this position, in USD. */
  realizedPnlUsd?: number;
  symbol?: string;
  decimals?: number;
}

export interface NetworkPortfolioInput {
  network: string;
  /** Address on this network, used for event-derived cost basis. */
  address?: string;
  holdings: NetworkHoldingInput[];
}

export interface PortfolioPnlInput {
  wallet?: string;
  networks: NetworkPortfolioInput[];
  /** Point in time to snapshot at; defaults to now. */
  snapshotAt?: string;
  /** Derive cost basis from indexed events when not supplied. Defaults to true. */
  deriveCostBasisFromEvents?: boolean;
}

export interface AssetPnl {
  network: string;
  token: string;
  symbol: string | null;
  balance: string;
  quantity: number;
  decimals: number;
  priceUsd: number;
  valueUsd: number;
  costBasisUsd: number;
  unrealizedPnlUsd: number;
  unrealizedPnlPct: number | null;
  allocationPct: number;
  priceSource: string;
  confidence: number;
  costBasisSource: CostBasisSource;
}

export interface ChainPnl {
  network: string;
  address: string | null;
  valueUsd: number;
  costBasisUsd: number;
  unrealizedPnlUsd: number;
  unrealizedPnlPct: number | null;
  allocationPct: number;
  assetCount: number;
  assets: AssetPnl[];
}

export interface PortfolioPnlResult {
  wallet: string | null;
  totalValueUsd: number;
  totalCostBasisUsd: number;
  unrealizedPnlUsd: number;
  unrealizedPnlPct: number | null;
  realizedPnlUsd: number;
  byChain: ChainPnl[];
  byAsset: AssetPnl[];
  assetCount: number;
  timestamp: string;
}

export interface BalanceSnapshotRecord {
  id: string;
  wallet: string;
  network: string;
  token: string;
  symbol: string | null;
  quantity: number;
  priceUsd: number | null;
  valueUsd: number | null;
  costBasisUsd: number | null;
  unrealizedPnlUsd: number | null;
  snapshotAt: string;
}

interface TokenMeta {
  symbol: string | null;
  decimals: number;
}

/** Convert a raw balance string into a decimal quantity using token decimals. */
function toQuantity(balance: string, decimals: number): number {
  const raw = Number(balance);
  if (!Number.isFinite(raw)) return 0;
  return raw / 10 ** decimals;
}

function pct(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return (numerator / denominator) * 100;
}

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

async function resolveTokenMetadata(tokens: string[]): Promise<Map<string, TokenMeta>> {
  const meta = new Map<string, TokenMeta>();
  if (tokens.length === 0) return meta;

  const contracts = await prismaRead.contract.findMany({
    where: { address: { in: tokens }, isToken: true },
    select: { address: true, tokenSymbol: true, tokenDecimals: true },
  });

  for (const c of contracts) {
    meta.set(c.address, {
      symbol: c.tokenSymbol ?? null,
      decimals: c.tokenDecimals ?? DEFAULT_DECIMALS,
    });
  }
  return meta;
}

/**
 * Best-effort cost basis reconstruction from indexed transfer events.
 *
 * Sums the value (amount × price at event time) of inbound transfers of the
 * token to the wallet. Returns null when no events are found so callers can
 * distinguish "unknown" from a real zero cost basis.
 */
export async function deriveCostBasisFromEvents(params: {
  address: string;
  token: string;
  asOf: Date;
}): Promise<number | null> {
  const { address, token, asOf } = params;

  const events = await prismaRead.event.findMany({
    where: {
      contractAddress: token,
      ledgerCloseTime: { lte: asOf },
      OR: [
        { decoded: { path: ['to'], equals: address } },
        { decoded: { path: ['receiver'], equals: address } },
      ],
    },
    orderBy: { ledgerCloseTime: 'asc' },
    take: EVENT_DERIVATION_LIMIT,
    select: { decoded: true, ledgerCloseTime: true },
  });

  if (events.length === 0) return null;

  let total = 0;
  let sawPrice = false;

  for (const event of events) {
    const decoded = (event.decoded ?? {}) as Record<string, unknown>;
    const amount =
      toNumber(decoded.amount) ?? toNumber(decoded.value) ?? toNumber(decoded.quantity);
    if (!amount || amount <= 0) continue;

    const priceRecord = await prismaRead.tokenPriceHistory.findFirst({
      where: { tokenAddress: token, timestamp: { lte: event.ledgerCloseTime } },
      orderBy: { timestamp: 'desc' },
      select: { priceUsd: true },
    });
    if (!priceRecord) continue;

    total += amount * Number(priceRecord.priceUsd);
    sawPrice = true;
  }

  return sawPrice ? total : null;
}

/**
 * Compute consolidated P&L for a linked wallet across networks.
 *
 * Pricing is done per position via the composite price oracle; results are
 * decomposed both by chain and by asset.
 */
export async function computePortfolioPnl(input: PortfolioPnlInput): Promise<PortfolioPnlResult> {
  const asOf = input.snapshotAt ? new Date(input.snapshotAt) : new Date();
  const deriveFromEvents = input.deriveCostBasisFromEvents ?? true;

  const allTokens = Array.from(
    new Set(input.networks.flatMap((n) => n.holdings.map((h) => h.token))),
  );
  const metadata = await resolveTokenMetadata(allTokens);

  const byChain: ChainPnl[] = [];
  let totalValueUsd = 0;
  let totalCostBasisUsd = 0;
  let realizedPnlUsd = 0;

  for (const network of input.networks) {
    const assets: AssetPnl[] = [];
    let chainValueUsd = 0;
    let chainCostBasisUsd = 0;

    for (const holding of network.holdings) {
      const meta = metadata.get(holding.token);
      const symbol = holding.symbol ?? meta?.symbol ?? null;
      const decimals = holding.decimals ?? meta?.decimals ?? DEFAULT_DECIMALS;

      const price = await computeCompositePrice(holding.token, symbol);
      const quantity = toQuantity(holding.balance, decimals);
      const valueUsd = quantity * price.priceUsd;

      let costBasisUsd: number | null =
        typeof holding.costBasisUsd === 'number' && Number.isFinite(holding.costBasisUsd)
          ? holding.costBasisUsd
          : null;
      let costBasisSource: CostBasisSource = 'provided';

      if (
        costBasisUsd === null &&
        deriveFromEvents &&
        network.address &&
        EVENT_COST_BASIS_NETWORKS.has(network.network)
      ) {
        costBasisUsd = await deriveCostBasisFromEvents({
          address: network.address,
          token: holding.token,
          asOf,
        });
        costBasisSource = costBasisUsd === null ? 'zero' : 'events';
      }

      if (costBasisUsd === null) {
        costBasisUsd = 0;
        costBasisSource = 'zero';
      }

      const unrealizedPnlUsd = valueUsd - costBasisUsd;

      chainValueUsd += valueUsd;
      chainCostBasisUsd += costBasisUsd;
      realizedPnlUsd += holding.realizedPnlUsd ?? 0;

      assets.push({
        network: network.network,
        token: holding.token,
        symbol,
        balance: holding.balance,
        quantity,
        decimals,
        priceUsd: price.priceUsd,
        valueUsd,
        costBasisUsd,
        unrealizedPnlUsd,
        unrealizedPnlPct: pct(unrealizedPnlUsd, costBasisUsd),
        allocationPct: 0,
        priceSource: price.source,
        confidence: price.confidence,
        costBasisSource,
      });
    }

    totalValueUsd += chainValueUsd;
    totalCostBasisUsd += chainCostBasisUsd;
    byChain.push({
      network: network.network,
      address: network.address ?? null,
      valueUsd: chainValueUsd,
      costBasisUsd: chainCostBasisUsd,
      unrealizedPnlUsd: chainValueUsd - chainCostBasisUsd,
      unrealizedPnlPct: pct(chainValueUsd - chainCostBasisUsd, chainCostBasisUsd),
      allocationPct: 0,
      assetCount: assets.length,
      assets,
    });
  }

  const byAsset = byChain.flatMap((chain) => chain.assets).sort((a, b) => b.valueUsd - a.valueUsd);

  for (const asset of byAsset) {
    asset.allocationPct = totalValueUsd > 0 ? (asset.valueUsd / totalValueUsd) * 100 : 0;
  }
  for (const chain of byChain) {
    chain.allocationPct = totalValueUsd > 0 ? (chain.valueUsd / totalValueUsd) * 100 : 0;
  }

  const unrealizedPnlUsd = totalValueUsd - totalCostBasisUsd;

  return {
    wallet: input.wallet ?? null,
    totalValueUsd,
    totalCostBasisUsd,
    unrealizedPnlUsd,
    unrealizedPnlPct: pct(unrealizedPnlUsd, totalCostBasisUsd),
    realizedPnlUsd,
    byChain,
    byAsset,
    assetCount: byAsset.length,
    timestamp: asOf.toISOString(),
  };
}

/** Upsert cost-basis lots for a linked wallet. */
export async function upsertPositions(
  wallet: string,
  networks: NetworkPortfolioInput[],
): Promise<number> {
  let count = 0;

  for (const network of networks) {
    for (const holding of network.holdings) {
      const decimals = holding.decimals ?? DEFAULT_DECIMALS;
      const quantity = toQuantity(holding.balance, decimals);
      const costBasisUsd = holding.costBasisUsd ?? 0;
      const realizedPnlUsd = holding.realizedPnlUsd ?? 0;

      await prismaWrite.portfolioPosition.upsert({
        where: {
          wallet_network_token: { wallet, network: network.network, token: holding.token },
        },
        create: {
          wallet,
          network: network.network,
          address: network.address ?? null,
          token: holding.token,
          symbol: holding.symbol ?? null,
          decimals,
          quantity,
          costBasisUsd,
          realizedPnlUsd,
          source: 'manual',
        },
        update: {
          address: network.address ?? null,
          symbol: holding.symbol ?? null,
          decimals,
          quantity,
          costBasisUsd,
          realizedPnlUsd,
        },
      });
      count += 1;
    }
  }

  return count;
}

/** Persist per-asset balance snapshots for a computed P&L. */
export async function persistPortfolioPnl(
  wallet: string,
  pnl: PortfolioPnlResult,
): Promise<number> {
  if (pnl.byAsset.length === 0) return 0;

  const snapshotAt = new Date(pnl.timestamp);

  await prismaWrite.portfolioBalanceSnapshot.createMany({
    data: pnl.byAsset.map((asset) => ({
      wallet,
      network: asset.network,
      token: asset.token,
      symbol: asset.symbol,
      quantity: asset.quantity,
      priceUsd: asset.priceUsd,
      valueUsd: asset.valueUsd,
      costBasisUsd: asset.costBasisUsd,
      unrealizedPnlUsd: asset.unrealizedPnlUsd,
      snapshotAt,
    })),
  });

  return pnl.byAsset.length;
}

/** Recompute P&L for a wallet from its persisted cost-basis positions. */
export async function getPortfolioPnl(wallet: string): Promise<PortfolioPnlResult> {
  const positions = await prismaRead.portfolioPosition.findMany({
    where: { wallet },
    orderBy: { network: 'asc' },
  });

  const byNetwork = new Map<string, NetworkPortfolioInput>();
  for (const position of positions) {
    const network = byNetwork.get(position.network) ?? {
      network: position.network,
      address: position.address ?? undefined,
      holdings: [],
    };

    network.holdings.push({
      token: position.token,
      // convert stored quantity back to the raw balance string
      balance: String(Number(position.quantity) * 10 ** position.decimals),
      costBasisUsd: Number(position.costBasisUsd),
      realizedPnlUsd: Number(position.realizedPnlUsd),
      symbol: position.symbol ?? undefined,
      decimals: position.decimals,
    });
    if (!network.address && position.address) network.address = position.address;

    byNetwork.set(position.network, network);
  }

  return computePortfolioPnl({
    wallet,
    networks: Array.from(byNetwork.values()),
    deriveCostBasisFromEvents: false,
  });
}

/** List persisted balance snapshots for a wallet, newest first. */
export async function listBalanceSnapshots(
  wallet: string,
  opts: { network?: string; from?: Date; to?: Date; limit?: number } = {},
): Promise<BalanceSnapshotRecord[]> {
  const rows = await prismaRead.portfolioBalanceSnapshot.findMany({
    where: {
      wallet,
      ...(opts.network ? { network: opts.network } : {}),
      ...(opts.from || opts.to
        ? {
            snapshotAt: {
              ...(opts.from ? { gte: opts.from } : {}),
              ...(opts.to ? { lte: opts.to } : {}),
            },
          }
        : {}),
    },
    orderBy: { snapshotAt: 'desc' },
    take: opts.limit ?? 100,
  });

  return rows.map((row) => ({
    id: row.id,
    wallet: row.wallet,
    network: row.network,
    token: row.token,
    symbol: row.symbol,
    quantity: Number(row.quantity),
    priceUsd: row.priceUsd === null ? null : Number(row.priceUsd),
    valueUsd: row.valueUsd === null ? null : Number(row.valueUsd),
    costBasisUsd: row.costBasisUsd === null ? null : Number(row.costBasisUsd),
    unrealizedPnlUsd: row.unrealizedPnlUsd === null ? null : Number(row.unrealizedPnlUsd),
    snapshotAt: row.snapshotAt.toISOString(),
  }));
}
