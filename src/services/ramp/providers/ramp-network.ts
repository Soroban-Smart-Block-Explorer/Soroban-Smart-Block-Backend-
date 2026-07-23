/**
 * Ramp Network provider adapter.
 *
 * Env vars:
 *   RAMP_NETWORK_API_KEY   – API key
 *   RAMP_NETWORK_BASE_URL  – optional override
 */

import { logger } from '../../../logger';
import type {
  RampProviderAdapter,
  ProviderName,
  ProviderQuote,
  ProviderOrderResult,
  ProviderOrderStatus,
  RefundResult,
  RampDirection,
  CryptoAsset,
  PaymentMethod,
  ExecuteOrderRequest,
  OrderStatus,
} from '../types';

const BASE_URL =
  process.env.RAMP_NETWORK_BASE_URL ?? 'https://api.ramp.network/api/host-api';
const API_KEY = process.env.RAMP_NETWORK_API_KEY ?? '';
const PLATFORM_FEE_PCT = parseFloat(process.env.RAMP_PLATFORM_FEE_PCT ?? '0.5') / 100;

const ASSET_MAP: Record<CryptoAsset, string> = {
  USDC: 'STELLAR_USDC',
  XLM: 'STELLAR_XLM',
  USDT: 'STELLAR_USDT',
  ETH: 'ETH_ETH',
  BTC: 'BTC_BTC',
};

const BLOCKED_COUNTRIES = new Set(['IR', 'KP', 'SY', 'CU', 'SD', 'MM', 'RU', 'BY', 'VE', 'AF']);

async function rampFetch<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const url = `${BASE_URL}${path}`;
  const res = await fetch(url, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Basic ${Buffer.from(`${API_KEY}:`).toString('base64')}`,
      ...(opts.headers ?? {}),
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`[ramp-network] ${res.status} ${res.statusText}: ${body.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

function mapStatus(rs: string): OrderStatus {
  switch (rs) {
    case 'RELEASE_SUCCEEDED':
      return 'completed';
    case 'FIAT_PAYMENT_FAILED':
    case 'CANCELLED':
    case 'EXPIRED':
      return 'failed';
    case 'INITIALIZED':
    case 'PAYMENT_STARTED':
    case 'PAYMENT_IN_PROGRESS':
      return 'pending';
    default:
      return 'processing';
  }
}

export class RampNetworkAdapter implements RampProviderAdapter {
  readonly name: ProviderName = 'ramp';

  async isAvailable(country: string, _paymentMethod: PaymentMethod): Promise<boolean> {
    return !BLOCKED_COUNTRIES.has(country.toUpperCase());
  }

  async getQuote(
    direction: RampDirection,
    fiatAmount: number,
    fiatCurrency: string,
    cryptoAsset: CryptoAsset,
    paymentMethod: PaymentMethod,
    country: string,
  ): Promise<ProviderQuote | null> {
    if (!(await this.isAvailable(country, paymentMethod))) return null;
    // Ramp Network only supports on-ramp (buy)
    if (direction === 'sell') return null;

    const assetCode = ASSET_MAP[cryptoAsset];

    try {
      const data = await rampFetch<{
        asset: { price: string };
        appliedFee: number;
        networkFee: number;
        cryptoAmount: number;
      }>(
        `/onramp/quote/all?currencyCode=${fiatCurrency}&fiatValue=${fiatAmount}&type=OFFRAMP&hostApiKey=${API_KEY}&swapAsset=${assetCode}`,
      );

      const rate = parseFloat(data.asset?.price ?? '0');
      const providerFee = data.appliedFee ?? 0;
      const networkFee = data.networkFee ?? 0;
      const platformFee = fiatAmount * PLATFORM_FEE_PCT;
      const totalCost = fiatAmount + providerFee + networkFee + platformFee;

      return {
        provider: this.name,
        direction,
        fiatAmount,
        fiatCurrency: fiatCurrency.toUpperCase(),
        cryptoAmount: data.cryptoAmount,
        cryptoAsset,
        exchangeRate: rate,
        platformFeeUsd: platformFee,
        providerFeeUsd: providerFee,
        networkFeeUsd: networkFee,
        totalCostUsd: totalCost,
        effectiveRate: totalCost / (data.cryptoAmount || 1),
        paymentMethod,
        estimatedCompletionMinutes: 5,
        expiresAt: new Date(Date.now() + 60_000),
        available: true,
      };
    } catch (err) {
      logger.warn('[ramp-network] quote failed', { error: String(err) });
      return null;
    }
  }

  async executeOrder(request: ExecuteOrderRequest): Promise<ProviderOrderResult> {
    const assetCode = ASSET_MAP[request.cryptoAsset];

    const widgetUrl =
      `https://app.ramp.network/?hostApiKey=${API_KEY}` +
      `&swapAsset=${assetCode}` +
      `&swapAmount=${Math.round(request.fiatAmount * 100)}` +
      `&fiatCurrency=${request.fiatCurrency}` +
      `&userAddress=${encodeURIComponent(request.walletAddress)}` +
      `&finalUrl=${encodeURIComponent(process.env.RAMP_RETURN_URL ?? '')}`;

    const id = `ramp-${Date.now()}-${request.userId.slice(0, 8)}`;

    return {
      providerOrderId: id,
      status: 'pending',
      redirectUrl: widgetUrl,
      iframeUrl: widgetUrl,
    };
  }

  async getOrderStatus(providerOrderId: string): Promise<ProviderOrderStatus> {
    try {
      const data = await rampFetch<{ id: string; status: string; asset?: { amount: number }; txHash?: string }>(
        `/purchase/${providerOrderId}`,
      );
      return {
        providerOrderId: data.id,
        status: mapStatus(data.status),
        cryptoAmount: data.asset?.amount,
        txHash: data.txHash,
      };
    } catch {
      return { providerOrderId, status: 'pending' };
    }
  }

  async initiateRefund(_providerOrderId: string, amountUsd: number): Promise<RefundResult> {
    return {
      refundId: `refund-ramp-${Date.now()}`,
      status: 'initiated',
      refundAmountUsd: amountUsd,
      estimatedCompletionHours: 120,
    };
  }
}
