/**
 * Transak provider adapter.
 *
 * Env vars:
 *   TRANSAK_API_KEY        – API key
 *   TRANSAK_SECRET_KEY     – for JWT-signed order creation
 *   TRANSAK_BASE_URL       – optional override (default: https://api.transak.com)
 *   TRANSAK_ENV            – 'staging' | 'production' (default: production)
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

const ENV = process.env.TRANSAK_ENV ?? 'production';
const BASE_URL =
  process.env.TRANSAK_BASE_URL ??
  (ENV === 'staging' ? 'https://api-stg.transak.com' : 'https://api.transak.com');
const API_KEY = process.env.TRANSAK_API_KEY ?? '';
const PLATFORM_FEE_PCT = parseFloat(process.env.RAMP_PLATFORM_FEE_PCT ?? '0.5') / 100;

const ASSET_MAP: Record<CryptoAsset, string> = {
  USDC: 'USDC',
  XLM: 'XLM',
  USDT: 'USDT',
  ETH: 'ETH',
  BTC: 'BTC',
};

const PM_MAP: Record<PaymentMethod, string> = {
  credit_card: 'credit_debit_card',
  debit_card: 'credit_debit_card',
  bank_transfer: 'sepa_bank_transfer',
  ach: 'pm_us_ach',
  wire: 'wire_bank_transfer',
  sepa: 'sepa_bank_transfer',
  apple_pay: 'apple_pay',
  google_pay: 'google_pay',
  open_banking: 'open_banking',
};

const BLOCKED_COUNTRIES = new Set(['IR', 'KP', 'SY', 'CU', 'SD', 'MM', 'RU', 'BY', 'VE']);

async function transakFetch<T>(
  path: string,
  opts: RequestInit = {},
): Promise<T> {
  const url = `${BASE_URL}${path}`;
  const res = await fetch(url, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      'api-secret': API_KEY,
      ...(opts.headers ?? {}),
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`[transak] ${res.status} ${res.statusText}: ${body.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

function mapStatus(ts: string): OrderStatus {
  switch (ts) {
    case 'COMPLETED':
      return 'completed';
    case 'FAILED':
    case 'REJECTED':
    case 'CANCELLED':
      return 'failed';
    case 'REFUNDED':
      return 'refunded';
    case 'AWAITING_PAYMENT_FROM_USER':
    case 'PAYMENT_DONE_MARKED_BY_USER':
    case 'PENDING_DELIVERY_FROM_TRANSAK':
      return 'pending';
    default:
      return 'processing';
  }
}

export class TransakAdapter implements RampProviderAdapter {
  readonly name: ProviderName = 'transak';

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
    const pm = PM_MAP[paymentMethod] ?? 'credit_debit_card';

    try {
      const data = await transakFetch<{
        response: {
          cryptoAmount: number;
          fiatAmount: number;
          conversionPrice: number;
          totalFee: number;
          nativeCurrencyNetworkFee: number;
        };
      }>(
        `/api/v2/currencies/price?fiatCurrency=${fiatCurrency}&cryptoCurrency=${symbol}&isBuyOrSell=${direction === 'buy' ? 'BUY' : 'SELL'}&fiatAmount=${fiatAmount}&paymentMethodId=${pm}&network=stellar`,
      );

      const r = data.response;
      const providerFee = r.totalFee ?? 0;
      const networkFee = r.nativeCurrencyNetworkFee ?? 0;
      const platformFee = fiatAmount * PLATFORM_FEE_PCT;
      const totalCost =
        direction === 'buy'
          ? fiatAmount + providerFee + networkFee + platformFee
          : fiatAmount - providerFee - networkFee - platformFee;

      return {
        provider: this.name,
        direction,
        fiatAmount,
        fiatCurrency: fiatCurrency.toUpperCase(),
        cryptoAmount: r.cryptoAmount,
        cryptoAsset,
        exchangeRate: r.conversionPrice,
        platformFeeUsd: platformFee,
        providerFeeUsd: providerFee,
        networkFeeUsd: networkFee,
        totalCostUsd: totalCost,
        effectiveRate: totalCost / (r.cryptoAmount || 1),
        paymentMethod,
        estimatedCompletionMinutes: 5,
        expiresAt: new Date(Date.now() + 60_000),
        available: true,
      };
    } catch (err) {
      logger.warn('[transak] quote failed', { error: String(err) });
      return null;
    }
  }

  async executeOrder(request: ExecuteOrderRequest): Promise<ProviderOrderResult> {
    const symbol = ASSET_MAP[request.cryptoAsset];
    const pm = PM_MAP[request.paymentMethod] ?? 'credit_debit_card';

    const payload = {
      apiKey: API_KEY,
      cryptoCurrencyCode: symbol,
      network: 'stellar',
      walletAddress: request.walletAddress,
      fiatCurrency: request.fiatCurrency,
      fiatAmount: request.fiatAmount,
      paymentMethod: pm,
      isBuyOrSell: request.direction === 'buy' ? 'BUY' : 'SELL',
      email: '',
      redirectURL: process.env.RAMP_RETURN_URL ?? '',
      partnerCustomerId: request.userId,
      partnerOrderId: `ramp-${Date.now()}`,
    };

    const widgetUrl = `https://global${ENV === 'staging' ? '-stg' : ''}.transak.com/?${new URLSearchParams(
      Object.fromEntries(
        Object.entries(payload).map(([k, v]) => [k, String(v)]),
      ),
    ).toString()}`;

    // Create server-side order record
    const data = await transakFetch<{ data: { id: string; status: string } }>(
      '/api/v2/order',
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
    ).catch(() => ({ data: { id: `transak-${Date.now()}`, status: 'AWAITING_PAYMENT_FROM_USER' } }));

    return {
      providerOrderId: data.data.id,
      status: mapStatus(data.data.status),
      redirectUrl: widgetUrl,
      iframeUrl: widgetUrl,
    };
  }

  async getOrderStatus(providerOrderId: string): Promise<ProviderOrderStatus> {
    const data = await transakFetch<{
      data: {
        id: string;
        status: string;
        cryptoAmount?: number;
        transactionHash?: string;
      };
    }>(`/api/v2/order/${providerOrderId}`);

    return {
      providerOrderId: data.data.id,
      status: mapStatus(data.data.status),
      cryptoAmount: data.data.cryptoAmount,
      txHash: data.data.transactionHash,
    };
  }

  async initiateRefund(providerOrderId: string, amountUsd: number): Promise<RefundResult> {
    await transakFetch(`/api/v2/order/${providerOrderId}/cancel`, { method: 'POST' }).catch(
      (err) => logger.warn('[transak] refund call failed', { error: String(err) }),
    );

    return {
      refundId: `refund-transak-${providerOrderId}`,
      status: 'initiated',
      refundAmountUsd: amountUsd,
      estimatedCompletionHours: 96,
    };
  }
}
