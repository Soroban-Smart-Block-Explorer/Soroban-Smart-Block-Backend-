import axios from 'axios';
import crypto from 'crypto';
import { prismaWrite as prisma } from '../db';

// Maximum delivery attempts before a delivery is marked permanently failed
export const MAX_ATTEMPTS = 5;
// Hard timeout per HTTP request (ms)
export const REQUEST_TIMEOUT_MS = 10_000;

/** Compute exponential backoff delay for a given attempt (1-based). */
export function backoffMs(attempt: number): number {
  // 10s, 30s, 90s, 270s, 810s — capped at 15 min
  return Math.min(10_000 * 3 ** (attempt - 1), 900_000);
}

export interface WebhookPayload {
  id: string;
  contractAddress: string;
  eventType: string;
  topicSymbol?: string | null;
  decoded: unknown;
  ledger: number;
  ledgerCloseTime: Date;
  transactionHash: string;
}

/**
 * Fan-out a single event to all matching active webhook subscriptions.
 * Each delivery is persisted and dispatched immediately (attempt 1).
 */
export async function dispatchWebhooks(event: WebhookPayload): Promise<void> {
  const subs = await prisma.webhookSubscription.findMany({
    where: {
      active: true,
      ...(event.contractAddress && {
        OR: [{ contractAddress: null }, { contractAddress: event.contractAddress }],
      }),
    },
  });

  const matching = subs.filter((s) => {
    if (s.eventType && s.eventType !== event.eventType) return false;
    if (s.topicSymbol && s.topicSymbol !== event.topicSymbol) return false;
    return true;
  });

  await Promise.all(matching.map((sub) => deliverOnce(sub.id, sub.url, sub.secret, event, 1)));
}

/**
 * Retry all pending deliveries whose nextRetryAt is due.
 * Call this on a periodic schedule (e.g. every 30s from the indexer).
 */
export async function retryPendingDeliveries(): Promise<void> {
  const due = await prisma.webhookDelivery.findMany({
    where: { status: 'pending', nextRetryAt: { lte: new Date() } },
    include: { subscription: { select: { url: true, secret: true, active: true } } },
  });

  await Promise.all(
    due.map((d) =>
      deliverOnce(
        d.subscriptionId,
        d.subscription.url,
        d.subscription.secret,
        null,
        d.attempt,
        d.id,
      ),
    ),
  );
}

/**
 * Perform a single HTTP delivery attempt.
 * @param deliveryId  If provided, updates an existing delivery row; otherwise creates one.
 */
async function deliverOnce(
  subscriptionId: string,
  url: string,
  secret: string | null,
  event: WebhookPayload | null,
  attempt: number,
  deliveryId?: string,
): Promise<void> {
  // Resolve payload — for retries we re-fetch from the delivery row's eventId
  let payload: WebhookPayload | null = event;
  let eventId = event?.id ?? '';

  if (!payload && deliveryId) {
    const row = await prisma.webhookDelivery.findUnique({ where: { id: deliveryId } });
    if (!row) return;
    eventId = row.eventId;
    // Re-fetch the event to rebuild the payload
    const ev = await prisma.event.findUnique({ where: { id: eventId } });
    if (!ev) return;
    payload = {
      id: ev.id,
      contractAddress: ev.contractAddress,
      eventType: ev.eventType,
      topicSymbol: ev.topicSymbol,
      decoded: ev.decoded,
      ledger: ev.ledgerSequence,
      ledgerCloseTime: ev.ledgerCloseTime,
      transactionHash: ev.transactionHash,
    };
  }

  if (!payload) return;

  const body = JSON.stringify({ event: payload, attempt });
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };

  if (secret) {
    const sig = crypto.createHmac('sha256', secret).update(body).digest('hex');
    headers['X-Webhook-Signature'] = `sha256=${sig}`;
  }

  // Create or update the delivery row to "pending" before attempting
  const delivery = deliveryId
    ? await prisma.webhookDelivery.update({
        where: { id: deliveryId },
        data: { attempt, status: 'pending', nextRetryAt: null },
      })
    : await prisma.webhookDelivery.create({
        data: { subscriptionId, eventId, attempt, status: 'pending' },
      });

  try {
    const response = await axios.post(url, body, {
      headers,
      timeout: REQUEST_TIMEOUT_MS,
      validateStatus: () => true, // handle all HTTP codes ourselves
    });

    const success = response.status >= 200 && response.status < 300;
    const responseBody = String(response.data ?? '').slice(0, 500);

    if (success) {
      await prisma.webhookDelivery.update({
        where: { id: delivery.id },
        data: {
          status: 'success',
          httpStatus: response.status,
          responseBody,
          deliveredAt: new Date(),
        },
      });
      return;
    }

    await scheduleRetryOrFail(
      delivery.id,
      attempt,
      `HTTP ${response.status}`,
      response.status,
      responseBody,
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    await scheduleRetryOrFail(delivery.id, attempt, msg, undefined, undefined);
  }
}

async function scheduleRetryOrFail(
  deliveryId: string,
  attempt: number,
  errorMsg: string,
  httpStatus?: number,
  responseBody?: string,
): Promise<void> {
  const nextAttempt = attempt + 1;

  if (nextAttempt > MAX_ATTEMPTS) {
    await prisma.webhookDelivery.update({
      where: { id: deliveryId },
      data: { status: 'failed', errorMsg, httpStatus, responseBody, nextRetryAt: null },
    });
    return;
  }

  const nextRetryAt = new Date(Date.now() + backoffMs(nextAttempt));
  await prisma.webhookDelivery.update({
    where: { id: deliveryId },
    data: {
      status: 'pending',
      errorMsg,
      httpStatus,
      responseBody,
      nextRetryAt,
      attempt: nextAttempt,
    },
  });
}
