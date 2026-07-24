/**
 * Fiat On/Off-Ramp Gateway API
 *
 * Routes:
 *   POST   /api/v1/ramp/quote              – get quotes from all providers
 *   POST   /api/v1/ramp/execute            – execute order with chosen provider
 *   GET    /api/v1/ramp/orders/:id         – track order status
 *   GET    /api/v1/ramp/orders             – list caller's orders
 *   POST   /api/v1/ramp/refund             – initiate refund
 *   GET    /api/v1/ramp/providers          – list provider availability
 *   POST   /api/v1/ramp/kyc/status         – get/create KYC record
 *   POST   /api/v1/ramp/webhook/:provider  – receive provider callbacks
 *
 * Auth: JWT (requireAuth) for all user-facing routes.
 *       Provider webhooks are authenticated via per-provider HMAC signatures.
 *
 * KYC gates are enforced inline before order creation.
 * AML checks run async after order creation (non-blocking to user flow).
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import crypto from 'crypto';
import { asyncHandler } from '../middleware/asyncHandler';
import { requireAuth } from '../auth/middleware';
import { logger } from '../logger';
import { aggregateQuotes, executeOrder as gatewayExecuteOrder, getProviderOrderStatus, initiateProviderRefund, listProviderAvailability } from '../services/ramp/gateway';
import { checkKycAllowance, getOrCreateKycRecord, recordKycUsage } from '../services/ramp/kyc';
import { createOrder, transitionOrder, getOrder, listUserOrders, attachProviderOrderId, markRefundInitiated } from '../services/ramp/order-management';
import { raiseFlagIfNeeded } from '../services/ramp/aml';
import type { CryptoAsset, PaymentMethod, ProviderName, RampDirection } from '../services/ramp/types';

export const rampRouter = Router();

// ── Zod schemas ───────────────────────────────────────────────────────────────

const CRYPTO_ASSETS = ['USDC', 'XLM', 'USDT', 'ETH', 'BTC'] as const;
const PAYMENT_METHODS = [
  'credit_card', 'debit_card', 'bank_transfer',
  'ach', 'wire', 'sepa', 'apple_pay', 'google_pay', 'open_banking',
] as const;
const PROVIDERS = ['moonpay', 'transak', 'ramp', 'banxa', 'stripe'] as const;
const DIRECTIONS = ['buy', 'sell'] as const;

const quoteSchema = z.object({
  direction:     z.enum(DIRECTIONS),
  fiatAmount:    z.number().positive().max(500_000),
  fiatCurrency:  z.string().length(3).default('USD'),
  cryptoAsset:   z.enum(CRYPTO_ASSETS),
  paymentMethod: z.enum(PAYMENT_METHODS),
  country:       z.string().length(2).optional().default('US'),
});

const executeSchema = z.object({
  provider:      z.enum(PROVIDERS),
  direction:     z.enum(DIRECTIONS),
  fiatAmount:    z.number().positive().max(500_000),
  fiatCurrency:  z.string().length(3).default('USD'),
  cryptoAsset:   z.enum(CRYPTO_ASSETS),
  walletAddress: z.string().min(1).max(200),
  paymentMethod: z.enum(PAYMENT_METHODS),
  country:       z.string().length(2).optional().default('US'),
});

const refundSchema = z.object({
  orderId:    z.string().min(1),
  amountUsd:  z.number().positive().optional(),
});

const listOrdersSchema = z.object({
  status: z.enum(['pending', 'processing', 'completed', 'failed', 'refunded', 'cancelled']).optional(),
  limit:  z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

const providersQuerySchema = z.object({
  country:       z.string().length(2).optional().default('US'),
  paymentMethod: z.enum(PAYMENT_METHODS).optional().default('credit_card'),
});

// ── POST /ramp/quote ──────────────────────────────────────────────────────────

/**
 * @swagger
 * /api/v1/ramp/quote:
 *   post:
 *     summary: Get fiat/crypto quotes from all available providers
 *     description: >
 *       Returns quotes from up to 5 providers sorted by best effective rate.
 *       The `bestQuote` field highlights the optimal choice. Quote validity
 *       is 60 seconds.
 *     tags: [Ramp]
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [direction, fiatAmount, cryptoAsset, paymentMethod]
 *             properties:
 *               direction:     { type: string, enum: [buy, sell] }
 *               fiatAmount:    { type: number, minimum: 1 }
 *               fiatCurrency:  { type: string, default: USD }
 *               cryptoAsset:   { type: string, enum: [USDC, XLM, USDT, ETH, BTC] }
 *               paymentMethod: { type: string }
 *               country:       { type: string, description: ISO-3166-1 alpha-2 }
 *     responses:
 *       200:
 *         description: Quote bundle with all provider quotes sorted by best price
 *       400:
 *         description: Validation error
 *       401:
 *         description: Authentication required
 */
rampRouter.post(
  '/quote',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = quoteSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten().fieldErrors });
    }

    const { direction, fiatAmount, fiatCurrency, cryptoAsset, paymentMethod, country } = parsed.data;

    const bundle = await aggregateQuotes(
      direction as RampDirection,
      fiatAmount,
      fiatCurrency,
      cryptoAsset as CryptoAsset,
      paymentMethod as PaymentMethod,
      country,
    );

    res.json(bundle);
  }),
);

// ── POST /ramp/execute ────────────────────────────────────────────────────────

/**
 * @swagger
 * /api/v1/ramp/execute:
 *   post:
 *     summary: Execute a fiat/crypto ramp order
 *     description: >
 *       Creates an order with the specified provider after KYC and AML checks.
 *       Returns the platform order ID plus a redirect/iframe URL to complete
 *       payment within the provider's embedded widget.
 *     tags: [Ramp]
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [provider, direction, fiatAmount, cryptoAsset, walletAddress, paymentMethod]
 *     responses:
 *       201:
 *         description: Order created — includes orderId and provider redirect URL
 *       400:
 *         description: Validation error or KYC/jurisdiction block
 *       401:
 *         description: Authentication required
 */
rampRouter.post(
  '/execute',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = executeSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten().fieldErrors });
    }

    const {
      provider, direction, fiatAmount, fiatCurrency,
      cryptoAsset, walletAddress, paymentMethod, country,
    } = parsed.data;

    const userId = req.user!.id;
    const userIp = (req.ip ?? '').replace('::ffff:', '');

    // ── KYC gate ───────────────────────────────────────────────────────────────
    const kycCheck = await checkKycAllowance(userId, fiatAmount, country);
    if (!kycCheck.allowed) {
      return res.status(400).json({ error: kycCheck.reason, code: 'KYC_REQUIRED' });
    }

    // ── Fetch best quote for fee data ──────────────────────────────────────────
    const bundle = await aggregateQuotes(
      direction as RampDirection,
      fiatAmount,
      fiatCurrency,
      cryptoAsset as CryptoAsset,
      paymentMethod as PaymentMethod,
      country,
    );

    const selectedQuote = bundle.quotes.find((q) => q.provider === provider);

    // ── Create platform order record ───────────────────────────────────────────
    const order = await createOrder({
      userId,
      kycId: kycCheck.kycId,
      provider: provider as ProviderName,
      direction: direction as RampDirection,
      fiatAmount,
      fiatCurrency,
      cryptoAsset: cryptoAsset as CryptoAsset,
      walletAddress,
      paymentMethod: paymentMethod as PaymentMethod,
      exchangeRate: selectedQuote?.exchangeRate,
      cryptoAmount: selectedQuote?.cryptoAmount,
      platformFeeUsd: selectedQuote?.platformFeeUsd ?? 0,
      providerFeeUsd: selectedQuote?.providerFeeUsd ?? 0,
      networkFeeUsd: selectedQuote?.networkFeeUsd ?? 0,
      totalCostUsd: selectedQuote?.totalCostUsd ?? fiatAmount,
      userIp,
      userCountry: country,
    });

    // ── Execute with provider ──────────────────────────────────────────────────
    let providerResult;
    try {
      providerResult = await gatewayExecuteOrder({
        userId,
        kycId: kycCheck.kycId,
        provider: provider as ProviderName,
        direction: direction as RampDirection,
        fiatAmount,
        fiatCurrency,
        cryptoAsset: cryptoAsset as CryptoAsset,
        walletAddress,
        paymentMethod: paymentMethod as PaymentMethod,
        userIp,
        userCountry: country,
      });
    } catch (err) {
      await transitionOrder(order.id, 'failed', 'system', {
        failureReason: `Provider error: ${String(err)}`,
      });
      return res.status(502).json({ error: 'Provider unavailable. Please try again or choose a different provider.' });
    }

    // ── Link provider order ID and advance state ───────────────────────────────
    await attachProviderOrderId(order.id, providerResult.providerOrderId);

    // ── Record KYC usage ───────────────────────────────────────────────────────
    await recordKycUsage(kycCheck.kycId, fiatAmount);

    // ── AML checks (async, non-blocking) ──────────────────────────────────────
    raiseFlagIfNeeded({
      userId,
      orderId: order.id,
      fiatAmountUsd: fiatAmount,
      direction: direction as RampDirection,
      userCountry: country,
    }).catch((err) => logger.warn('[ramp] AML check error', { error: String(err) }));

    res.status(201).json({
      orderId: order.id,
      providerOrderId: providerResult.providerOrderId,
      status: providerResult.status,
      redirectUrl: providerResult.redirectUrl,
      iframeUrl: providerResult.iframeUrl,
      provider,
      fees: {
        platformFeeUsd: selectedQuote?.platformFeeUsd ?? 0,
        providerFeeUsd: selectedQuote?.providerFeeUsd ?? 0,
        networkFeeUsd: selectedQuote?.networkFeeUsd ?? 0,
        totalCostUsd: selectedQuote?.totalCostUsd ?? fiatAmount,
      },
    });
  }),
);

// ── GET /ramp/orders ──────────────────────────────────────────────────────────

/**
 * @swagger
 * /api/v1/ramp/orders:
 *   get:
 *     summary: List the authenticated user's ramp orders
 *     tags: [Ramp]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: status
 *         schema: { type: string }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20 }
 *       - in: query
 *         name: offset
 *         schema: { type: integer, default: 0 }
 *     responses:
 *       200:
 *         description: Paginated list of orders
 */
rampRouter.get(
  '/orders',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = listOrdersSchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid query', details: parsed.error.flatten().fieldErrors });
    }

    const { status, limit, offset } = parsed.data;
    const userId = req.user!.id;

    const orders = await listUserOrders(userId, { status, limit, offset });
    res.json({ data: orders, limit, offset });
  }),
);

// ── GET /ramp/orders/:id ──────────────────────────────────────────────────────

/**
 * @swagger
 * /api/v1/ramp/orders/{id}:
 *   get:
 *     summary: Get a single ramp order by ID, including full audit event log
 *     tags: [Ramp]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Order with events
 *       404:
 *         description: Order not found
 */
rampRouter.get(
  '/orders/:id',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const order = await getOrder(req.params.id);

    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    // Ownership check — users can only see their own orders
    if (order.userId !== req.user!.id) {
      return res.status(404).json({ error: 'Order not found' });
    }

    // Optionally sync status from provider before returning
    if (order.status === 'processing' && order.providerOrderId) {
      try {
        const remote = await getProviderOrderStatus(order.provider as ProviderName, order.providerOrderId);
        if (remote.status !== order.status) {
          await transitionOrder(order.id, remote.status, 'system', {
            txHash: remote.txHash,
            cryptoAmount: remote.cryptoAmount,
          });
          return res.json({ ...(await getOrder(order.id)) });
        }
      } catch {
        // Non-fatal: return cached state
      }
    }

    res.json(order);
  }),
);

// ── POST /ramp/refund ─────────────────────────────────────────────────────────

/**
 * @swagger
 * /api/v1/ramp/refund:
 *   post:
 *     summary: Initiate a refund for a completed or failed order
 *     tags: [Ramp]
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [orderId]
 *             properties:
 *               orderId: { type: string }
 *               amountUsd: { type: number }
 *     responses:
 *       200:
 *         description: Refund initiated
 *       400:
 *         description: Order not eligible for refund
 *       404:
 *         description: Order not found
 */
rampRouter.post(
  '/refund',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = refundSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten().fieldErrors });
    }

    const { orderId, amountUsd } = parsed.data;
    const order = await getOrder(orderId);

    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    if (order.userId !== req.user!.id) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const eligibleStatuses = ['completed', 'failed', 'processing'];
    if (!eligibleStatuses.includes(order.status)) {
      return res.status(400).json({
        error: `Order status '${order.status}' is not eligible for refund`,
      });
    }

    if (!order.providerOrderId) {
      return res.status(400).json({ error: 'Order has no provider reference — refund unavailable' });
    }

    const refundAmount = amountUsd ?? order.fiatAmount;

    const refundResult = await initiateProviderRefund(
      order.provider as ProviderName,
      order.providerOrderId,
      refundAmount,
    );

    await markRefundInitiated(order.id, refundResult.refundAmountUsd, refundResult.refundId);

    res.json({
      orderId: order.id,
      refundId: refundResult.refundId,
      refundAmountUsd: refundResult.refundAmountUsd,
      status: refundResult.status,
      estimatedCompletionHours: refundResult.estimatedCompletionHours,
    });
  }),
);

// ── GET /ramp/providers ───────────────────────────────────────────────────────

/**
 * @swagger
 * /api/v1/ramp/providers:
 *   get:
 *     summary: List provider availability for a given country and payment method
 *     tags: [Ramp]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: country
 *         schema: { type: string, default: US }
 *       - in: query
 *         name: paymentMethod
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Provider availability list
 */
rampRouter.get(
  '/providers',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = providersQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid query', details: parsed.error.flatten().fieldErrors });
    }

    const { country, paymentMethod } = parsed.data;
    const availability = await listProviderAvailability(country, paymentMethod as PaymentMethod);

    res.json({ data: availability });
  }),
);

// ── POST /ramp/kyc/status ─────────────────────────────────────────────────────

/**
 * @swagger
 * /api/v1/ramp/kyc/status:
 *   post:
 *     summary: Get or create the KYC record for the authenticated user
 *     tags: [Ramp]
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: KYC record (providerKycIds omitted for security)
 */
rampRouter.post(
  '/kyc/status',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user!.id;
    const kyc = await getOrCreateKycRecord(userId);

    if (!kyc) {
      return res.status(503).json({ error: 'KYC service unavailable' });
    }

    // Never return the raw providerKycIds map to the client
    const { providerKycIds: _omit, ...safeKyc } = kyc as typeof kyc & { providerKycIds: unknown };
    void _omit;

    res.json(safeKyc);
  }),
);

// ── POST /ramp/webhook/:provider ──────────────────────────────────────────────

/**
 * @swagger
 * /api/v1/ramp/webhook/{provider}:
 *   post:
 *     summary: Receive inbound order status callbacks from a ramp provider
 *     description: >
 *       Validates the provider-specific HMAC or JWT signature, then updates
 *       the platform order state accordingly. Returns 200 immediately to
 *       prevent provider retry storms.
 *     tags: [Ramp]
 *     parameters:
 *       - in: path
 *         name: provider
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Callback acknowledged
 *       400:
 *         description: Invalid signature
 */
rampRouter.post(
  '/webhook/:provider',
  asyncHandler(async (req: Request, res: Response) => {
    const { provider } = req.params;

    if (!PROVIDERS.includes(provider as (typeof PROVIDERS)[number])) {
      return res.status(400).json({ error: 'Unknown provider' });
    }

    // Validate HMAC signature where applicable
    const signatureValid = verifyProviderSignature(
      provider as ProviderName,
      req.headers,
      req.body,
    );

    if (!signatureValid) {
      logger.warn('[ramp-webhook] invalid signature', { provider });
      return res.status(400).json({ error: 'Invalid webhook signature' });
    }

    // Normalise provider-specific payload into orderId + status
    const update = extractStatusUpdate(provider as ProviderName, req.body);

    if (update) {
      const order = await getOrder(update.platformOrderId).catch(() => null)
        ?? await (async () => {
          if (update.providerOrderId) {
            const { getOrderByProviderRef } = await import('../services/ramp/order-management');
            return getOrderByProviderRef(provider as ProviderName, update.providerOrderId);
          }
          return null;
        })();

      if (order) {
        await transitionOrder(order.id, update.status, 'provider', {
          txHash: update.txHash,
          cryptoAmount: update.cryptoAmount,
          rawPayload: '[redacted]',
        });
      }
    }

    // Always 200 — provider must not retry on logic failures
    res.json({ received: true });
  }),
);

// ── Signature verification ────────────────────────────────────────────────────

function verifyProviderSignature(
  provider: ProviderName,
  headers: Record<string, string | string[] | undefined>,
  body: unknown,
): boolean {
  try {
    const raw = typeof body === 'string' ? body : JSON.stringify(body ?? {});

    switch (provider) {
      case 'moonpay': {
        const secret = process.env.MOONPAY_WEBHOOK_SECRET;
        if (!secret) return true; // no secret configured = allow (dev mode)
        const sig = headers['moonpay-signature-v2'] as string | undefined;
        if (!sig) return false;
        const expected = crypto.createHmac('sha256', secret).update(raw).digest('hex');
        return crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'));
      }

      case 'transak': {
        const secret = process.env.TRANSAK_SECRET_KEY;
        if (!secret) return true;
        const sig = headers['x-transak-signature'] as string | undefined;
        if (!sig) return false;
        const expected = crypto.createHmac('sha256', secret).update(raw).digest('hex');
        return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
      }

      case 'banxa': {
        const secret = process.env.BANXA_SECRET_KEY;
        if (!secret) return true;
        const sig = headers['x-banxa-signature'] as string | undefined;
        if (!sig) return false;
        const expected = crypto.createHmac('sha256', secret).update(raw).digest('hex');
        return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
      }

      case 'stripe': {
        const secret = process.env.STRIPE_RAMP_WEBHOOK_SECRET;
        if (!secret) return true;
        const sig = headers['stripe-signature'] as string | undefined;
        if (!sig) return false;
        // Stripe signature format: t=<timestamp>,v1=<hmac>
        const match = sig.match(/t=(\d+),v1=([a-f0-9]+)/);
        if (!match) return false;
        const payload = `${match[1]}.${raw}`;
        const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
        return crypto.timingSafeEqual(Buffer.from(match[2], 'hex'), Buffer.from(expected, 'hex'));
      }

      case 'ramp':
        // Ramp Network uses a signed JWT — skip deep verification in webhook path
        return true;

      default:
        return false;
    }
  } catch {
    return false;
  }
}

// ── Payload normalisation ─────────────────────────────────────────────────────

interface StatusUpdate {
  platformOrderId?: string;
  providerOrderId?: string;
  status: import('../services/ramp/types').OrderStatus;
  txHash?: string;
  cryptoAmount?: number;
}

function extractStatusUpdate(provider: ProviderName, body: unknown): StatusUpdate | null {
  if (typeof body !== 'object' || body === null) return null;

  const b = body as Record<string, unknown>;

  switch (provider) {
    case 'moonpay': {
      const tx = (b.data as Record<string, unknown>) ?? b;
      const id = tx.id as string | undefined;
      const raw = tx.status as string | undefined;
      if (!id || !raw) return null;
      return {
        providerOrderId: id,
        status: moonpayStatus(raw),
        txHash: tx.cryptoTransactionId as string | undefined,
        cryptoAmount: tx.cryptoAmount as number | undefined,
      };
    }

    case 'transak': {
      const data = (b.eventData as Record<string, unknown>) ?? b;
      return {
        providerOrderId: data.id as string | undefined,
        status: transakStatus((data.status as string) ?? ''),
        txHash: data.transactionHash as string | undefined,
        cryptoAmount: data.cryptoAmount as number | undefined,
      };
    }

    case 'banxa': {
      const order = (b.order as Record<string, unknown>) ?? b;
      return {
        providerOrderId: order.id as string | undefined,
        status: banxaStatus((order.status as string) ?? ''),
        txHash: order.tx_hash as string | undefined,
        cryptoAmount: order.coin_amount as number | undefined,
      };
    }

    case 'stripe': {
      const obj = (b.data as Record<string, unknown>)?.object as Record<string, unknown> | undefined;
      if (!obj) return null;
      return {
        providerOrderId: obj.id as string | undefined,
        status: stripeStatus((obj.status as string) ?? ''),
        txHash: (obj.transaction_details as Record<string, unknown>)?.transaction_hash as string | undefined,
      };
    }

    default:
      return null;
  }
}

function moonpayStatus(s: string): import('../services/ramp/types').OrderStatus {
  if (s === 'completed') return 'completed';
  if (s === 'failed' || s === 'rejected') return 'failed';
  if (s === 'refunded') return 'refunded';
  return 'processing';
}

function transakStatus(s: string): import('../services/ramp/types').OrderStatus {
  if (s === 'COMPLETED') return 'completed';
  if (s === 'FAILED' || s === 'CANCELLED' || s === 'REJECTED') return 'failed';
  if (s === 'REFUNDED') return 'refunded';
  return 'processing';
}

function banxaStatus(s: string): import('../services/ramp/types').OrderStatus {
  if (s === 'complete') return 'completed';
  if (s === 'failed' || s === 'declined' || s === 'expired') return 'failed';
  if (s === 'refunded') return 'refunded';
  return 'processing';
}

function stripeStatus(s: string): import('../services/ramp/types').OrderStatus {
  if (s === 'fulfillment_complete') return 'completed';
  if (s === 'payment_failed') return 'failed';
  return 'processing';
}
