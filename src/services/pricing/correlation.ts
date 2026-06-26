import { cacheGet, cacheSet } from '../../cache';

export interface CrossChainPrice {
  chain: string;
  priceUsd: number;
  timestamp: string;
  source: string;
}

export interface ArbitrageOpportunity {
  tokenAddress: string;
  tokenSymbol: string | null;
  buyChain: string;
  sellChain: string;
  buyPrice: number;
  sellPrice: number;
  profitPct: number;
  estimatedProfitUsd: number;
  confidence: number;
}

async function fetchChainPrice(
  chain: string,
  tokenAddress: string,
  tokenSymbol?: string | null,
): Promise<number | null> {
  const cacheKey = `chain_price:${chain}:${tokenAddress}`;
  const cached = await cacheGet<number>(cacheKey);
  if (cached) return cached;

  try {
    if (chain === 'ethereum') {
      const apiKey = process.env.ETHERSCAN_API_KEY;
      const url = `https://api.etherscan.io/api?module=stats&action=tokenprice&contractaddress=${tokenAddress}${apiKey ? `&apikey=${apiKey}` : ''}`;
      const res = await fetch(url);
      if (!res.ok) return null;
      const data = (await res.json()) as { status: string; result: string };
      if (data.status === '1' && data.result) {
        const price = parseFloat(data.result);
        if (price > 0) {
          await cacheSet(cacheKey, price, 300);
          return price;
        }
      }
    }

    if (chain === 'solana' && tokenSymbol) {
      const url = `https://public-api.solscan.io/market/token/${tokenAddress}`;
      const res = await fetch(url);
      if (!res.ok) return null;
      const data = (await res.json()) as { priceUsdt?: number };
      if (data.priceUsdt && data.priceUsdt > 0) {
        await cacheSet(cacheKey, data.priceUsdt, 300);
        return data.priceUsdt;
      }
    }
  } catch {
    return null;
  }

  return null;
}

export async function getCrossChainPrices(
  tokenAddress: string,
  tokenSymbol?: string | null,
): Promise<CrossChainPrice[]> {
  const prices: CrossChainPrice[] = [];
  const chains = ['ethereum', 'bsc', 'solana'];

  for (const chain of chains) {
    try {
      const price = await fetchChainPrice(chain, tokenAddress, tokenSymbol);
      if (price && price > 0) {
        prices.push({
          chain,
          priceUsd: price,
          timestamp: new Date().toISOString(),
          source: `chain_rpc_${chain}`,
        });
      }
    } catch {
      continue;
    }
  }

  return prices;
}

export async function findArbitrageOpportunities(
  sorobanPrices: Map<string, { priceUsd: number; symbol?: string | null }>,
): Promise<ArbitrageOpportunity[]> {
  const opportunities: ArbitrageOpportunity[] = [];
  const MIN_PROFIT_PCT = 2;
  const MIN_LIQUIDITY_USD = 10000;

  for (const [address, sorobanPrice] of sorobanPrices) {
    try {
      const chainPrices = await getCrossChainPrices(address, sorobanPrice.symbol);

      for (const chainPrice of chainPrices) {
        if (chainPrice.priceUsd <= 0 || sorobanPrice.priceUsd <= 0) continue;

        if (sorobanPrice.priceUsd < chainPrice.priceUsd) {
          const profitPct =
            ((chainPrice.priceUsd - sorobanPrice.priceUsd) / sorobanPrice.priceUsd) * 100;
          if (profitPct >= MIN_PROFIT_PCT) {
            opportunities.push({
              tokenAddress: address,
              tokenSymbol: sorobanPrice.symbol ?? null,
              buyChain: 'soroban',
              sellChain: chainPrice.chain,
              buyPrice: sorobanPrice.priceUsd,
              sellPrice: chainPrice.priceUsd,
              profitPct,
              estimatedProfitUsd: profitPct * 0.01 * MIN_LIQUIDITY_USD,
              confidence: 0.6,
            });
          }
        } else {
          const profitPct =
            ((sorobanPrice.priceUsd - chainPrice.priceUsd) / chainPrice.priceUsd) * 100;
          if (profitPct >= MIN_PROFIT_PCT) {
            opportunities.push({
              tokenAddress: address,
              tokenSymbol: sorobanPrice.symbol ?? null,
              buyChain: chainPrice.chain,
              sellChain: 'soroban',
              buyPrice: chainPrice.priceUsd,
              sellPrice: sorobanPrice.priceUsd,
              profitPct,
              estimatedProfitUsd: profitPct * 0.01 * MIN_LIQUIDITY_USD,
              confidence: 0.6,
            });
          }
        }
      }
    } catch {
      continue;
    }
  }

  return opportunities.sort((a, b) => b.profitPct - a.profitPct).slice(0, 20);
}
