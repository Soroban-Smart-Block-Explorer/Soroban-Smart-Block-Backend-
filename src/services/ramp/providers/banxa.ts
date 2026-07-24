/**
 * Banxa provider adapter.
 *
 * Env vars:
 *   BANXA_API_KEY      – API key
 *   BANXA_SECRET_KEY   – HMAC secret
 *   BANXA_BASE_URL     – optional override (default: https://banxa.com)
 */

import crypto from 'crypto';
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

const BASE_URL = process.env.BANXA_BASE_URL ?? 'https://banxa.com';
const API_KEY = process.env.BANXA_API_KEY ?? '';
const SECRET_KEY = process.env.BANXA_SECRET_KEY ?? '';
const PLATFORM_FEE_PCT = parseFloat(process.env.RAMP_PLATFORM_FEE_PCT ?? '0.5') / 100;

const ASSET_MAP: Record<CryptoAsset, string> = {
  USDC: 'USDC',
  XLM: 'XLM',
  USDT: 'USDT',
  ETH: 'ETH',
  BTC: 'BTC',
};

const BLOCKED_COUNTRIES = new Set(['IR', 'KP', 'SY', 'CU', 'SD', 'MM', 'RU', 'BY', 'VE', 'AF', 'YE']);

function buildHmacAuth(method: string, path: string, body: string): string {
  const nonce = Date.now().toString();
  const data = `${method}\n${path}\n${nonce}\n${body}`;
  const sig = crypto.createHmac('sha256', SECRET_KEY).update(data).digest('hex');
  return `Token ${API_KEY}:${nonce}:${sig}`;
}

async function banxaFetch<T>(
  method: string,
  path: string,
  body?: object,
): Promise<T> {
  const rawBody = body ? JSON.stringify(body) : '';
  const auth = buildHmacAuth(method, path, rawBody);
  const url = `${BASE_URL}${path}`;

  const res = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: auth,
    },
    ...(rawBody ? { body: rawBody } : {}),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`[banxa] ${res.status} ${res.statusText}: ${text.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

function mapStatus(bs: string): OrderStatus {
  switch (bs) {
    case 'complete':
      return 'completed';
    case 'failed':
    case 'declined':
    case 'expired':
      return 'failed';
    case 'refunded':
      return 'refunded';
    case 'pending-payment':
    case 'waiting-payment':
      return 'pending';
    default:
      return 'processing';
  }
}

export class BanxaAdapter implements RampProviderAdapter {
  readonly name: ProviderName = 'banxa';

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

    const symbol = ASSET_MAP[cryptoAsset];

    try {
      const data = await banxaFetch<{
        data: {
          spot_price: string;
          coin_amount: number;
          fee_amount: number;
          network_fee: number;
          total_amount: number;
        };
      }>(
        'GET',
        `/api/prices?source=${fiatCurrency}&target=${symbol}&source_amount=${fiatAmount}&type=${direction === 'buy' ? 'buy' : 'sell'}`,
      );

      const r = data.data;
      const rate = parseFloat(r.spot_price ?? '0');
      const providerFee = r.fee_amount ?? 0;
      const networkFee = r.network_fee ?? 0;
      const platformFee = fiatAmount * PLATFORM_FEE_PCT;
      const totalCost = (r.total_amount ?? fiatAmount) + platformFee;

      return {
        provider: this.name,
        direction,
        fiatAmount,
        fiatCurrency: fiatCurrency.toUpperCase(),
        cryptoAmount: r.coin_amount,
        cryptoAsset,
        exchangeRate: rate,
        platformFeeUsd: platformFee,
        providerFeeUsd: providerFee,
        networkFeeUsd: networkFee,
        totalCostUsd: totalCost,
        effectiveRate: totalCost / (r.coin_amount || 1),
        paymentMethod,
        estimatedCompletionMinutes: direction === 'buy' ? 5 : 15,
        expiresAt: new Date(Date.now() + 60_000),
        available: true,
      };
    } catch (err) {
      logger.warn('[banxa] quote failed', { error: String(err) });
      return null;
    }
  }

  async executeOrder(request: ExecuteOrderRequest): Promise<ProviderOrderResult> {
    const symbol = ASSET_MAP[request.cryptoAsset];

    const payload = {
      account_reference: request.userId,
      source: request.fiatCurrency,
      source_amount: request.fiatAmount,
      target: symbol,
      wallet_address: request.walletAddress,
      return_url_on_success: process.env.RAMP_RETURN_URL ?? '',
    };

    const data = await banxaFetch<{
      data: { order: { id: string; status: string; checkout_url: string } };
    }>('POST', request.direction === 'buy' ? '/api/orders/buy' : '/api/orders/sell', payload);

    const order = data.data.order;
    return {
      providerOrderId: order.id,
      status: mapStatus(order.status),
      redirectUrl: order.checkout_url,
      iframeUrl: order.checkout_url,
    };
  }

  async getOrderStatus(providerOrderId: string): Promise<ProviderOrderStatus> {
    const data = await banxaFetch<{
      data: { order: { id: string; status: string; coin_amount?: number; tx_hash?: string } };
    }>('GET', `/api/orders/${providerOrderId}`);

    const order = data.data.order;
    return {
      providerOrderId: order.id,
      status: mapStatus(order.status),
      cryptoAmount: order.coin_amount,
      txHash: order.tx_hash,
    };
  }

  async initiateRefund(providerOrderId: string, amountUsd: number): Promise<RefundResult> {
    await banxaFetch(
      'DELETE',
      `/api/orders/${providerOrderId}`,
    ).catch((err) => logger.warn('[banxa] refund failed', { error: String(err) }));

    return {
      refundId: `refund-banxa-${providerOrderId}`,
      status: 'initiated',
      refundAmountUsd: amountUsd,
      estimatedCompletionHours: 72,
    };
  }
}
