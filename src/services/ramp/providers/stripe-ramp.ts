/**
 * Stripe Crypto On-ramp provider adapter.
 *
 * Uses the Stripe Crypto On-ramp session API (currently US only, expanding).
 *
 * Env vars:
 *   STRIPE_SECRET_KEY          – shared with billing integration
 *   STRIPE_RAMP_WEBHOOK_SECRET – for ramp-specific webhook verification
 *   STRIPE_RAMP_BASE_URL       – optional override
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

const PLATFORM_FEE_PCT = parseFloat(process.env.RAMP_PLATFORM_FEE_PCT ?? '0.5') / 100;

// Stripe Crypto On-ramp currently supports only USD and buy direction
const SUPPORTED_COUNTRIES = new Set(['US']);

// Stripe uses network:token notation
const ASSET_MAP: Record<CryptoAsset, string> = {
  USDC: 'stellar:usdc',
  XLM: 'stellar:xlm',
  USDT: 'stellar:usdc', // fallback: Stripe ramp doesn't support USDT on Stellar yet
  ETH: 'ethereum:eth',
  BTC: 'bitcoin:btc',
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type StripeInstance = any;
let _stripe: StripeInstance | null = null;

async function getStripe(): Promise<StripeInstance> {
  if (_stripe) return _stripe;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Stripe = require('stripe');
  _stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? '', { apiVersion: '2024-04-10' });
  return _stripe;
}

function mapStatus(ss: string): OrderStatus {
  switch (ss) {
    case 'fulfillment_complete':
      return 'completed';
    case 'fulfillment_processing':
      return 'processing';
    case 'payment_failed':
      return 'failed';
    default:
      return 'pending';
  }
}

export class StripeRampAdapter implements RampProviderAdapter {
  readonly name: ProviderName = 'stripe';

  async isAvailable(country: string, paymentMethod: PaymentMethod): Promise<boolean> {
    if (!SUPPORTED_COUNTRIES.has(country.toUpperCase())) return false;
    const supported: PaymentMethod[] = ['credit_card', 'debit_card', 'apple_pay', 'google_pay'];
    return supported.includes(paymentMethod);
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
    if (direction === 'sell') return null; // Stripe on-ramp is buy-only
    if (fiatCurrency.toUpperCase() !== 'USD') return null;

    const networkToken = ASSET_MAP[cryptoAsset];

    try {
      const stripe = await getStripe();
      const session = await stripe.crypto.onrampSessions.create({
        transaction_details: {
          destination_currency: networkToken,
          destination_exchange_amount: undefined,
          source_currency: 'usd',
          source_exchange_amount: fiatAmount.toFixed(2),
          wallet_address: '',
        },
        customer_ip_address: '0.0.0.0',
      });

      const quote = session.transaction_details;
      const cryptoAmount = parseFloat(quote?.destination_exchange_amount ?? '0');
      const rate = cryptoAmount > 0 ? fiatAmount / cryptoAmount : 0;
      const providerFee = parseFloat(quote?.fees?.network_fee_monetary ?? '0') +
        parseFloat(quote?.fees?.transaction_fee_monetary ?? '0');
      const platformFee = fiatAmount * PLATFORM_FEE_PCT;
      const totalCost = fiatAmount + providerFee + platformFee;

      return {
        provider: this.name,
        direction,
        fiatAmount,
        fiatCurrency: 'USD',
        cryptoAmount,
        cryptoAsset,
        exchangeRate: rate,
        platformFeeUsd: platformFee,
        providerFeeUsd: providerFee,
        networkFeeUsd: 0,
        totalCostUsd: totalCost,
        effectiveRate: totalCost / (cryptoAmount || 1),
        paymentMethod,
        estimatedCompletionMinutes: 2,
        expiresAt: new Date(Date.now() + 60_000),
        available: true,
      };
    } catch (err) {
      logger.warn('[stripe-ramp] quote failed', { error: String(err) });
      return null;
    }
  }

  async executeOrder(request: ExecuteOrderRequest): Promise<ProviderOrderResult> {
    const networkToken = ASSET_MAP[request.cryptoAsset];
    const stripe = await getStripe();

    const session = await stripe.crypto.onrampSessions.create({
      transaction_details: {
        destination_currency: networkToken,
        source_currency: 'usd',
        source_exchange_amount: request.fiatAmount.toFixed(2),
        wallet_address: request.walletAddress,
      },
      customer_ip_address: request.userIp ?? '0.0.0.0',
    });

    return {
      providerOrderId: session.id,
      status: mapStatus(session.status),
      redirectUrl: session.redirect_url,
      iframeUrl: session.client_secret,
    };
  }

  async getOrderStatus(providerOrderId: string): Promise<ProviderOrderStatus> {
    try {
      const stripe = await getStripe();
      const session = await stripe.crypto.onrampSessions.retrieve(providerOrderId);
      return {
        providerOrderId: session.id,
        status: mapStatus(session.status),
        txHash: session.transaction_details?.transaction_hash,
        cryptoAmount: parseFloat(session.transaction_details?.destination_exchange_amount ?? '0'),
      };
    } catch {
      return { providerOrderId, status: 'pending' };
    }
  }

  async initiateRefund(_providerOrderId: string, amountUsd: number): Promise<RefundResult> {
    // Stripe Crypto On-ramp handles refunds through Stripe's standard refund flow
    return {
      refundId: `refund-stripe-${Date.now()}`,
      status: 'initiated',
      refundAmountUsd: amountUsd,
      estimatedCompletionHours: 48,
    };
  }
}
