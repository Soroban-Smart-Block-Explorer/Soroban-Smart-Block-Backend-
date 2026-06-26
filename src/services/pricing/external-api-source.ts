import { cacheGet, cacheSet } from '../../cache';

const RATE_LIMIT_WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 30;

interface RateLimitState {
  count: number;
  windowStart: number;
}

const rateLimitState: Record<string, RateLimitState> = {};

export interface ExternalPrice {
  priceUsd: number;
  priceXlm?: number;
  marketCapUsd?: number;
  volume24hUsd?: number;
  fullyDilutedValuation?: number;
  circulatingSupply?: number;
  totalSupply?: number;
  priceChange1h?: number;
  priceChange24h?: number;
  priceChange7d?: number;
  source: string;
  confidence: number;
}

function checkRateLimit(source: string): boolean {
  const state = rateLimitState[source] ?? { count: 0, windowStart: Date.now() };
  if (Date.now() - state.windowStart > RATE_LIMIT_WINDOW_MS) {
    state.count = 0;
    state.windowStart = Date.now();
  }
  if (state.count >= MAX_REQUESTS_PER_WINDOW) return false;
  state.count++;
  rateLimitState[source] = state;
  return true;
}

function coingeckoIdFromSymbol(symbol: string): string {
  const map: Record<string, string> = {
    usdc: 'usd-coin',
    usdt: 'tether',
    xlm: 'stellar',
    eurc: 'euro-coin',
    dai: 'dai',
    sushi: 'sushi',
    uni: 'uniswap',
    yfi: 'yearn-finance',
    aave: 'aave',
    link: 'chainlink',
    wbtc: 'wrapped-bitcoin',
    weth: 'wrapped-ether',
  };
  return map[symbol.toLowerCase()] ?? symbol.toLowerCase();
}

async function fetchCoinGeckoPrice(tokenSymbol: string): Promise<ExternalPrice | null> {
  if (!checkRateLimit('coingecko')) {
    console.warn('[ExternalPrice] CoinGecko rate limited');
    return null;
  }

  const cacheKey = `cg_price:${tokenSymbol}`;
  const cached = await cacheGet<ExternalPrice>(cacheKey);
  if (cached) return cached;

  const cgId = coingeckoIdFromSymbol(tokenSymbol);
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${cgId}&vs_currencies=usd&include_24hr_vol=true&include_24hr_change=true&include_market_cap=true`;

  try {
    const response = await fetch(url);
    if (!response.ok) {
      if (response.status === 429) {
        rateLimitState['coingecko'] = { count: MAX_REQUESTS_PER_WINDOW, windowStart: Date.now() };
      }
      return null;
    }

    const data = (await response.json()) as Record<string, Record<string, number>>;
    const priceData = data[cgId];
    if (!priceData || !priceData.usd) return null;

    const result: ExternalPrice = {
      priceUsd: priceData.usd,
      volume24hUsd: priceData.usd_24h_vol,
      marketCapUsd: priceData.usd_market_cap,
      priceChange24h: priceData.usd_24h_change,
      priceChange1h: 0,
      source: 'coingecko',
      confidence: 0.85,
    };

    await cacheSet(cacheKey, result, 300);
    return result;
  } catch {
    return null;
  }
}

async function fetchCoinMarketCapPrice(tokenSymbol: string): Promise<ExternalPrice | null> {
  if (!checkRateLimit('cmc')) {
    console.warn('[ExternalPrice] CMC rate limited');
    return null;
  }

  const cmcApiKey = process.env.COINMARKETCAP_API_KEY;
  if (!cmcApiKey) return null;

  const cacheKey = `cmc_price:${tokenSymbol}`;
  const cached = await cacheGet<ExternalPrice>(cacheKey);
  if (cached) return cached;

  try {
    const response = await fetch(
      `https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest?symbol=${tokenSymbol}`,
      { headers: { 'X-CMC_PRO_API_KEY': cmcApiKey } },
    );

    if (!response.ok) return null;
    const data = (await response.json()) as {
      data?: Record<
        string,
        Array<{
          quote: {
            USD: {
              price: number;
              volume_24h: number;
              market_cap: number;
              percent_change_1h: number;
              percent_change_24h: number;
              percent_change_7d: number;
            };
          };
        }>
      >;
    };

    const quotes = data.data?.[tokenSymbol.toUpperCase()];
    if (!quotes || quotes.length === 0) return null;

    const quote = quotes[0].quote.USD;
    const result: ExternalPrice = {
      priceUsd: quote.price,
      volume24hUsd: quote.volume_24h,
      marketCapUsd: quote.market_cap,
      priceChange1h: quote.percent_change_1h,
      priceChange24h: quote.percent_change_24h,
      priceChange7d: quote.percent_change_7d,
      source: 'cmc',
      confidence: 0.9,
    };

    await cacheSet(cacheKey, result, 300);
    return result;
  } catch {
    return null;
  }
}

async function fetchStellarExpertPrice(tokenAddress: string): Promise<ExternalPrice | null> {
  if (!checkRateLimit('stellarexpert')) return null;

  const cacheKey = `se_price:${tokenAddress}`;
  const cached = await cacheGet<ExternalPrice>(cacheKey);
  if (cached) return cached;

  try {
    const response = await fetch(`https://api.stellar.expert/explorer/asset/${tokenAddress}`, {
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { price?: string };
    if (!data.price) return null;

    const result: ExternalPrice = {
      priceUsd: parseFloat(data.price),
      source: 'stellarexpert',
      confidence: 0.6,
    };

    await cacheSet(cacheKey, result, 300);
    return result;
  } catch {
    return null;
  }
}

export async function discoverExternalPrice(
  tokenAddress: string,
  tokenSymbol?: string | null,
): Promise<ExternalPrice | null> {
  const sources: Array<() => Promise<ExternalPrice | null>> = [];

  if (tokenSymbol) {
    sources.push(() => fetchCoinGeckoPrice(tokenSymbol));
    sources.push(() => fetchCoinMarketCapPrice(tokenSymbol));
  }
  sources.push(() => fetchStellarExpertPrice(tokenAddress));

  for (const source of sources) {
    try {
      const price = await source();
      if (price && price.priceUsd > 0) return price;
    } catch {
      continue;
    }
  }

  return null;
}
