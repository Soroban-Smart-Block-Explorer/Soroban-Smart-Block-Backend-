/**
 * Order Management Service
 *
 * Owns the full order lifecycle:
 *   pending → processing → completed | failed → refunded
 *
 * Every state transition is written to RampOrderEvent (immutable audit log).
 * The service is the single authority for mutating order state — no other
 * code should write directly to ramp_orders.
 */

import { prismaWrite, prismaRead } from '../../db';
import { logger } from '../../logger';
import type { OrderStatus, ProviderName, RampDirection, CryptoAsset, PaymentMethod } from './types';

// ── Order creation ────────────────────────────────────────────────────────────

export interface CreateOrderInput {
  userId: string;
  kycId?: string;
  provider: ProviderName;
  direction: RampDirection;
  fiatAmount: number;
  fiatCurrency: string;
  cryptoAsset: CryptoAsset;
  walletAddress: string;
  paymentMethod: PaymentMethod;
  exchangeRate?: number;
  cryptoAmount?: number;
  platformFeeUsd?: number;
  providerFeeUsd?: number;
  networkFeeUsd?: number;
  totalCostUsd?: number;
  userIp?: string;
  userCountry?: string;
}

export async function createOrder(input: CreateOrderInput) {
  const order = await prismaWrite.rampOrder.create({
    data: {
      userId: input.userId,
      kycId: input.kycId ?? null,
      provider: input.provider,
      direction: input.direction,
      status: 'pending',
      fiatAmount: input.fiatAmount,
      fiatCurrency: input.fiatCurrency.toUpperCase(),
      cryptoAsset: input.cryptoAsset,
      walletAddress: input.walletAddress,
      paymentMethod: input.paymentMethod,
      exchangeRate: input.exchangeRate ?? null,
      cryptoAmount: input.cryptoAmount ?? null,
      platformFeeUsd: input.platformFeeUsd ?? 0,
      providerFeeUsd: input.providerFeeUsd ?? 0,
      networkFeeUsd: input.networkFeeUsd ?? 0,
      totalCostUsd: input.totalCostUsd ?? input.fiatAmount,
      userIp: input.userIp ?? null,
      userCountry: input.userCountry ?? null,
    },
  });

  await appendEvent(order.id, null, 'pending', 'user', {});

  logger.info('[ramp-order] created', {
    orderId: order.id,
    provider: input.provider,
    direction: input.direction,
    fiatAmount: input.fiatAmount,
    userId: input.userId,
  });

  return order;
}

// ── State transitions ─────────────────────────────────────────────────────────

export async function transitionOrder(
  orderId: string,
  toStatus: OrderStatus,
  triggeredBy: 'user' | 'provider' | 'system',
  payload: Record<string, unknown> = {},
): Promise<void> {
  const order = await prismaRead.rampOrder.findUnique({ where: { id: orderId } });
  if (!order) {
    logger.warn('[ramp-order] transition on unknown order', { orderId, toStatus });
    return;
  }

  const fromStatus = order.status as OrderStatus;
  if (fromStatus === toStatus) return;

  // Validate allowed transitions
  const allowed = ALLOWED_TRANSITIONS[fromStatus] ?? [];
  if (!allowed.includes(toStatus)) {
    logger.warn('[ramp-order] illegal transition', { orderId, fromStatus, toStatus });
    return;
  }

  const updateData: Record<string, unknown> = { status: toStatus };
  if (toStatus === 'completed') updateData.completedAt = new Date();
  if (toStatus === 'failed') {
    updateData.failedAt = new Date();
    updateData.failureReason = payload.failureReason ?? null;
  }
  if (toStatus === 'refunded') {
    updateData.refundedAt = new Date();
    updateData.refundStatus = 'completed';
    if (payload.refundAmount) updateData.refundAmount = payload.refundAmount;
  }
  if (payload.txHash) updateData.txHash = payload.txHash;
  if (payload.cryptoAmount) updateData.cryptoAmount = payload.cryptoAmount;
  if (payload.providerOrderId) updateData.providerOrderId = payload.providerOrderId;

  await prismaWrite.rampOrder.update({ where: { id: orderId }, data: updateData });
  await appendEvent(orderId, fromStatus, toStatus, triggeredBy, payload);

  logger.info('[ramp-order] transition', { orderId, fromStatus, toStatus, triggeredBy });
}

// ── Provider order ID linking ─────────────────────────────────────────────────

export async function attachProviderOrderId(
  orderId: string,
  providerOrderId: string,
): Promise<void> {
  await prismaWrite.rampOrder.update({
    where: { id: orderId },
    data: { providerOrderId, status: 'processing' },
  });
  const order = await prismaRead.rampOrder.findUnique({ where: { id: orderId } });
  if (order) {
    await appendEvent(orderId, order.status as OrderStatus, 'processing', 'system', {
      providerOrderId,
    });
  }
}

// ── Order retrieval ───────────────────────────────────────────────────────────

export async function getOrder(orderId: string) {
  return prismaRead.rampOrder.findUnique({
    where: { id: orderId },
    include: { events: { orderBy: { createdAt: 'asc' } } },
  });
}

export async function getOrderByProviderRef(provider: ProviderName, providerOrderId: string) {
  return prismaRead.rampOrder.findFirst({
    where: { provider, providerOrderId },
  });
}

export async function listUserOrders(
  userId: string,
  opts: { status?: OrderStatus; limit?: number; offset?: number } = {},
) {
  return prismaRead.rampOrder.findMany({
    where: {
      userId,
      ...(opts.status ? { status: opts.status } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: opts.limit ?? 20,
    skip: opts.offset ?? 0,
    include: { events: { orderBy: { createdAt: 'asc' } } },
  });
}

// ── Refund initiation ─────────────────────────────────────────────────────────

export async function markRefundInitiated(
  orderId: string,
  refundAmount: number,
  refundId: string,
): Promise<void> {
  await prismaWrite.rampOrder.update({
    where: { id: orderId },
    data: { refundStatus: 'initiated', refundAmount, metadata: { refundId } },
  });
  const order = await prismaRead.rampOrder.findUnique({ where: { id: orderId } });
  await appendEvent(orderId, order?.status as OrderStatus | null, order?.status as OrderStatus ?? 'completed', 'user', {
    refundId,
    refundAmount,
  });
}

// ── Audit log ─────────────────────────────────────────────────────────────────

async function appendEvent(
  orderId: string,
  fromStatus: OrderStatus | null,
  toStatus: OrderStatus,
  triggeredBy: string,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    await prismaWrite.rampOrderEvent.create({
      data: { orderId, fromStatus, toStatus, triggeredBy, payload },
    });
  } catch (err) {
    logger.error('[ramp-order] event append failed', { error: String(err), orderId });
  }
}

// ── Transition table ──────────────────────────────────────────────────────────

const ALLOWED_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  pending:    ['processing', 'failed', 'cancelled'],
  processing: ['completed', 'failed'],
  completed:  ['refunded'],
  failed:     [],
  refunded:   [],
  cancelled:  [],
};
