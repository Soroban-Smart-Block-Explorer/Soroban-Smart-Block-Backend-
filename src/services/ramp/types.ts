/**
 * Shared types for the fiat on/off-ramp gateway.
 *
 * All five providers (MoonPay, Transak, Ramp, Banxa, Stripe) expose a unified
 * surface through these interfaces. No provider-specific types leak outside
 * this module.
 */

export type RampDirection = 'buy' | 'sell';

export type PaymentMethod =
  | 'credit_card'
  | 'debit_card'
  | 'bank_transfer'
  | 'ach'
  | 'wire'
  | 'sepa'
  | 'apple_pay'
  | 'google_pay'
  | 'open_banking';

export type CryptoAsset = 'USDC' | 'XLM' | 'USDT' | 'ETH' | 'BTC';

export type OrderStatus =
  | 'pending'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'refunded'
  | 'cancelled';

export type KycStatus = 'pending' | 'submitted' | 'approved' | 'rejected' | 'expired';
export type KycTier = 'tier1' | 'tier2' | 'tier3';

/** Supported ramp providers. */
export type ProviderName = 'moonpay' | 'transak' | 'ramp' | 'banxa' | 'stripe';

/** Provider availability status in a given context. */
export interface ProviderAvailability {
  provider: ProviderName;
  available: boolean;
  reason?: string;
}

/** A single quote returned by one provider. */
export interface ProviderQuote {
  provider: ProviderName;
  direction: RampDirection;
  fiatAmount: number;
  fiatCurrency: string;
  cryptoAmount: number;
  cryptoAsset: CryptoAsset;
  exchangeRate: number;
  platformFeeUsd: number;
  providerFeeUsd: number;
  networkFeeUsd: number;
  totalCostUsd: number;
  /** Platform-fee-adjusted effective rate expressed as fiatAmount / cryptoAmount */
  effectiveRate: number;
  paymentMethod: PaymentMethod;
  estimatedCompletionMinutes: number;
  expiresAt: Date;
  available: boolean;
  unavailableReason?: string;
}

/** Aggregate response that bundles all provider quotes, sorted by best price. */
export interface QuoteBundle {
  direction: RampDirection;
  fiatAmount: number;
  fiatCurrency: string;
  cryptoAsset: CryptoAsset;
  paymentMethod: PaymentMethod;
  quotes: ProviderQuote[];
  bestQuote: ProviderQuote | null;
  requestedAt: Date;
}

/** Request to execute a ramp order via a specific provider. */
export interface ExecuteOrderRequest {
  userId: string;
  kycId: string;
  provider: ProviderName;
  direction: RampDirection;
  fiatAmount: number;
  fiatCurrency: string;
  cryptoAsset: CryptoAsset;
  walletAddress: string;
  paymentMethod: PaymentMethod;
  userIp?: string;
  userCountry?: string;
}

/** Normalised order returned from provider execution. */
export interface ProviderOrderResult {
  providerOrderId: string;
  status: OrderStatus;
  redirectUrl?: string;
  iframeUrl?: string;
  cryptoAmount?: number;
  exchangeRate?: number;
  metadata?: Record<string, unknown>;
}

/** Normalised order status from a provider poll. */
export interface ProviderOrderStatus {
  providerOrderId: string;
  status: OrderStatus;
  cryptoAmount?: number;
  txHash?: string;
  failureReason?: string;
  metadata?: Record<string, unknown>;
}

/** Refund initiation result. */
export interface RefundResult {
  refundId: string;
  status: string;
  refundAmountUsd: number;
  estimatedCompletionHours: number;
}

/** Interface every provider adapter must implement. */
export interface RampProviderAdapter {
  readonly name: ProviderName;

  /** Returns whether this provider can service the given country + payment method. */
  isAvailable(country: string, paymentMethod: PaymentMethod): Promise<boolean>;

  /** Fetch a quote. Returns null when the provider cannot service the request. */
  getQuote(
    direction: RampDirection,
    fiatAmount: number,
    fiatCurrency: string,
    cryptoAsset: CryptoAsset,
    paymentMethod: PaymentMethod,
    country: string,
  ): Promise<ProviderQuote | null>;

  /** Initiate an order and return the provider-side reference + redirect URL. */
  executeOrder(request: ExecuteOrderRequest): Promise<ProviderOrderResult>;

  /** Poll the current status of an order. */
  getOrderStatus(providerOrderId: string): Promise<ProviderOrderStatus>;

  /** Initiate a refund. */
  initiateRefund(providerOrderId: string, amountUsd: number): Promise<RefundResult>;
}

/** Routing context used by the dynamic router to pick the best provider. */
export interface RoutingContext {
  country: string;
  paymentMethod: PaymentMethod;
  fiatAmountUsd: number;
  preferredProvider?: ProviderName;
}
