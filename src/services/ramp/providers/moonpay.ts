/**
 * MoonPay provider adapter.
 *
 * Wraps the MoonPay REST API behind the unified RampProviderAdapter interface.
 * Sandbox mode is used when MOONPAY_SECRET_KEY is not set.
 *
 * Env vars:
 *   MOONPAY_API_KEY        – publishable (frontend) key
 *   MOONPAY_SECRET_KEY     – secret key for server-side API calls
 *   MOONPAY_WEBHOOK_SECRET – for verifying inbound callback signatures
 *   MOONPAY_BASE_URL       – optional override (default: https://api.moonpay.com)
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

const BASE_URL = process.env.MOONPAY_BASE_URL ?? 'https://api.moonpay.com';
const API_KEY = process.env.MOONPAY_API_KEY ?? '';
const SECRET_KEY = process.env.MOONPAY_SECRET_KEY ?? '';
const PLATFORM_FEE_PCT = parseFloat(process.env.RAMP_PLATFORM_FEE_PCT ?? '0.5') / 100;

// MoonPay uses underscore-lowercased symbols, e.g. "usdc" → "usdc"
const ASSET_MAP: Record<CryptoAsset, string> = {
  USDC: 'usdc',
  XLM: 'xlm',
  USDT: 'usdt',
  ETH: 'eth',
  BTC: 'btc',
};

const PAYMENT_MAP: Record<PaymentMethod, string> = {
  credit_card: 'credit_debit_card',
  debit_card: 'credit_debit_card',
  bank_transfer: 'sepa_bank_transfer',
  ach: 'ach_bank_transfer',
  wire: 'wire_bank_transfer',
  sepa: 'sepa_bank_transfer',
  apple_pay: 'apple_pay',
  google_pay: 'google_pay',
  open_banking: 'gbp_open_banking_payment',
};

function signUrl(url: string): string {
  if (!SECRET_KEY) return url;
  const sig = crypto
    .createHmac('sha256', SECRET_KEY)
    .update(new URL(url).search)
    .digest('base64');
  const encoded = encodeURIComponent(sig);
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}signature=${encoded}`;
}

async function moonpayFetch<T>(
  path: string,
  opts: RequestInit = {},
): Promise<T> {
  const url = `${BASE_URL}${path}${path.includes('?') ? '&' : '?'}apiKey=${API_KEY}`;
  const signed = signUrl(url);

  const res = await fetch(signed, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers ?? {}) },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`[moonpay] ${res.status} ${res.statusText}: ${body.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

function mapStatus(mpStatus: string): OrderStatus {
  switch (mpStatus) {
    case 'completed':
      return 'completed';
    case 'failed':
    case 'rejected':
      return 'failed';
    case 'refunded':
      return 'refunded';
    case 'waitingPayment':
    case 'pendingPayment':
    case 'waitingAuthorization':
    case 'pending':
      return 'pending';
    default:
      return 'processing';
  }
}

export class MoonPayAdapter implements RampProviderAdapter {
  readonly name: ProviderName = 'moonpay';

  async isAvailable(country: string, _paymentMethod: PaymentMethod): Promise<boolean> {
    // FATF grey/black-listed and US-restricted countries not supported
    const BLOCKED = new Set([
      'IR', 'KP', 'SY', 'CU', 'SD', 'MM', 'RU', 'BY', 'VE',
    ]);
    return !BLOCKED.has(country.toUpperCase());
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
    const pmCode = PAYMENT_MAP[paymentMethod] ?? 'credit_debit_card';

    try {
      if (direction === 'buy') {
        const data = await moonpayFetch<{
          quoteCurrencyAmount: number;
          feeAmount: number;
          networkFeeAmount: number;
          extraFeeAmount: number;
          exchangeRate: number;
        }>(
          `/v3/currencies/${symbol}/buy_quote?baseCurrencyAmount=${fiatAmount}&baseCurrencyCode=${fiatCurrency.toLowerCase()}&paymentMethod=${pmCode}`,
        );

        const providerFee = (data.feeAmount ?? 0) + (data.extraFeeAmount ?? 0);
        const networkFee = data.networkFeeAmount ?? 0;
        const platformFee = fiatAmount * PLATFORM_FEE_PCT;
        const totalCost = fiatAmount + providerFee + networkFee + platformFee;

        return {
          provider: this.name,
          direction,
          fiatAmount,
          fiatCurrency: fiatCurrency.toUpperCase(),
          cryptoAmount: data.quoteCurrencyAmount,
          cryptoAsset,
          exchangeRate: data.exchangeRate,
          platformFeeUsd: platformFee,
          providerFeeUsd: providerFee,
          networkFeeUsd: networkFee,
          totalCostUsd: totalCost,
          effectiveRate: totalCost / (data.quoteCurrencyAmount || 1),
          paymentMethod,
          estimatedCompletionMinutes: 5,
          expiresAt: new Date(Date.now() + 60_000),
          available: true,
        };
      } else {
        // sell: fiatAmount is the fiat value the user wants to receive
        const data = await moonpayFetch<{
          baseCurrencyAmount: number;
          feeAmount: number;
          networkFeeAmount: number;
          exchangeRate: number;
        }>(
          `/v3/currencies/${symbol}/sell_quote?quoteCurrencyAmount=${fiatAmount}&quoteCurrencyCode=${fiatCurrency.toLowerCase()}`,
        );

        const providerFee = data.feeAmount ?? 0;
        const networkFee = data.networkFeeAmount ?? 0;
        const platformFee = fiatAmount * PLATFORM_FEE_PCT;
        const totalCost = (data.baseCurrencyAmount ?? 0);

        return {
          provider: this.name,
          direction,
          fiatAmount,
          fiatCurrency: fiatCurrency.toUpperCase(),
          cryptoAmount: data.baseCurrencyAmount,
          cryptoAsset,
          exchangeRate: data.exchangeRate,
          platformFeeUsd: platformFee,
          providerFeeUsd: providerFee,
          networkFeeUsd: networkFee,
          totalCostUsd: totalCost,
          effectiveRate: fiatAmount / (data.baseCurrencyAmount || 1),
          paymentMethod,
          estimatedCompletionMinutes: 10,
          expiresAt: new Date(Date.now() + 60_000),
          available: true,
        };
      }
    } catch (err) {
      logger.warn('[moonpay] quote failed', { error: String(err) });
      return null;
    }
  }

  async executeOrder(request: ExecuteOrderRequest): Promise<ProviderOrderResult> {
    const symbol = ASSET_MAP[request.cryptoAsset];
    const pmCode = PAYMENT_MAP[request.paymentMethod] ?? 'credit_debit_card';

    const body =
      request.direction === 'buy'
        ? {
            baseCurrencyCode: request.fiatCurrency.toLowerCase(),
            baseCurrencyAmount: request.fiatAmount,
            currencyCode: symbol,
            walletAddress: request.walletAddress,
            paymentMethod: pmCode,
            externalCustomerId: request.userId,
            ipAddress: request.userIp,
            returnUrl: process.env.RAMP_RETURN_URL ?? '',
          }
        : {
            quoteCurrencyCode: request.fiatCurrency.toLowerCase(),
            quoteCurrencyAmount: request.fiatAmount,
            baseCurrencyCode: symbol,
            refundWalletAddress: request.walletAddress,
            paymentMethod: pmCode,
            externalCustomerId: request.userId,
          };

    const data = await moonpayFetch<{ id: string; status: string; redirectUrl?: string }>(
      `/v1/transactions`,
      { method: 'POST', body: JSON.stringify(body) },
    );

    return {
      providerOrderId: data.id,
      status: mapStatus(data.status),
      redirectUrl: data.redirectUrl,
      iframeUrl: data.redirectUrl,
    };
  }

  async getOrderStatus(providerOrderId: string): Promise<ProviderOrderStatus> {
    const data = await moonpayFetch<{
      id: string;
      status: string;
      cryptoTransactionId?: string;
      cryptoAmount?: number;
    }>(`/v1/transactions/${providerOrderId}`);

    return {
      providerOrderId: data.id,
      status: mapStatus(data.status),
      cryptoAmount: data.cryptoAmount,
      txHash: data.cryptoTransactionId,
    };
  }

  async initiateRefund(providerOrderId: string, amountUsd: number): Promise<RefundResult> {
    const data = await moonpayFetch<{ id: string; status: string }>(
      `/v1/transactions/${providerOrderId}/refund`,
      { method: 'POST', body: JSON.stringify({ amount: amountUsd }) },
    );

    return {
      refundId: data.id,
      status: data.status,
      refundAmountUsd: amountUsd,
      estimatedCompletionHours: 72,
    };
  }
}
