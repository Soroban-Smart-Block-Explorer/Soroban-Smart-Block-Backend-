import { prismaRead } from '../../db';
import { computeCompositePrice } from './composite-price';

export interface PortfolioHolding {
  token: string;
  balance: string;
  costBasisUsd?: number;
}

export interface PortfolioValuation {
  totalUsd: number;
  totalXlm: number;
  breakdown: Array<{
    token: string;
    symbol: string | null;
    balance: string;
    priceUsd: number;
    valueUsd: number;
    allocation: number;
    priceSource: string;
    confidence: number;
  }>;
  timestamp: string;
}

export interface PortfolioHistoryPoint {
  timestamp: string;
  totalUsd: number;
  totalXlm: number;
}

export async function valuatePortfolio(holdings: PortfolioHolding[]): Promise<PortfolioValuation> {
  const breakdown: PortfolioValuation['breakdown'] = [];
  let totalUsd = 0;

  const tokenMap = new Map<string, string>();
  const tokenContracts = await prismaRead.contract.findMany({
    where: {
      address: { in: holdings.map((h) => h.token) },
      isToken: true,
    },
    select: { address: true, tokenSymbol: true },
  });
  for (const c of tokenContracts) {
    tokenMap.set(c.address, c.tokenSymbol ?? (null as unknown as string));
  }

  for (const holding of holdings) {
    const symbol = tokenMap.get(holding.token) ?? null;
    const priceInfo = await computeCompositePrice(holding.token, symbol);
    const balanceNum = parseFloat(holding.balance) / 10 ** 7;
    const valueUsd = balanceNum * priceInfo.priceUsd;
    totalUsd += valueUsd;

    breakdown.push({
      token: holding.token,
      symbol,
      balance: holding.balance,
      priceUsd: priceInfo.priceUsd,
      valueUsd,
      allocation: 0,
      priceSource: priceInfo.source,
      confidence: priceInfo.confidence,
    });
  }

  for (const item of breakdown) {
    item.allocation = totalUsd > 0 ? (item.valueUsd / totalUsd) * 100 : 0;
  }

  return {
    totalUsd,
    totalXlm: totalUsd * 2.5,
    breakdown,
    timestamp: new Date().toISOString(),
  };
}

export async function computePortfolioHistory(
  holdings: Array<{ token: string; balance: string }>,
  from: Date,
  to: Date,
  intervalMs: number = 60 * 60 * 1000,
): Promise<PortfolioHistoryPoint[]> {
  const history: PortfolioHistoryPoint[] = [];

  for (let time = from.getTime(); time <= to.getTime(); time += intervalMs) {
    const endDate = new Date(time);
    let totalUsd = 0;

    for (const holding of holdings) {
      const priceRecord = await prismaRead.tokenPriceHistory.findFirst({
        where: {
          tokenAddress: holding.token,
          timestamp: { lte: endDate },
        },
        orderBy: { timestamp: 'desc' },
        select: { priceUsd: true },
      });

      if (priceRecord) {
        const balanceNum = parseFloat(holding.balance) / 10 ** 7;
        totalUsd += balanceNum * Number(priceRecord.priceUsd);
      }
    }

    history.push({
      timestamp: endDate.toISOString(),
      totalUsd,
      totalXlm: totalUsd * 2.5,
    });
  }

  return history;
}
