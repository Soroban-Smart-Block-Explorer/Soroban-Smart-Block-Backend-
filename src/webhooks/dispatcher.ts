import crypto from 'crypto';
import { prismaWrite as prisma } from '../db';
import { processResponseBody } from './redaction';
import { assertSafeUrl, safePost, SsrfBlockedError } from './ssrf-guard';

// Maximum delivery attempts before a delivery is marked permanently failed
export const MAX_ATTEMPTS = 5;
// Hard timeout per HTTP request (ms)
export const REQUEST_TIMEOUT_MS = 10_000;
// How long a processing lease is held before it is considered stale (ms)
export const LEASE_DURATION_MS = 60_000;
// Maximum concurrent outbound HTTP deliveries for fan-out and retry (#483)
export const DISPATCH_CONCURRENCY = parseInt(process.env.WEBHOOK_DISPATCH_CONCURRENCY ?? '10', 10);

/** Compute exponential backoff delay for a given attempt (1-based). */
export function backoffMs(attempt: number): number {
  // 10s, 30s, 90s, 270s, 810s — capped at 15 min
  return Math.min(10_000 * 3 ** (attempt - 1), 900_000);
}

// ── Metrics (#483) ────────────────────────────────────────────────────────────

let _queueDepth = 0;
let _lastDeliveryLatencyMs = 0;

/** Live dispatch metrics exported for observability. */
export function getDispatchMetrics(): { queueDepth: number; lastDeliveryLatencyMs: number } {
  return { queueDepth: _queueDepth, lastDeliveryLatencyMs: _lastDeliveryLatencyMs };
}

// ── Concurrency pool (#483) ───────────────────────────────────────────────────

/**
 * Run `fn` over every item in `items` with at most `concurrency` tasks
 * executing in parallel. Excess items wait in a queue. Errors are swallowed
 * per item so that one failure doesn't abort remaining deliveries.
 */
async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;

  const queue = [...items];
  _queueDepth += queue.length;

  await new Promise<void>((resolve) => {
    let active = 0;
    let settled = 0;
    const total = items.length;

    function next(): void {
      while (active < concurrency && queue.length > 0) {
        const item = queue.shift()!;
        _queueDepth--;
        active++;
        fn(item)
          .catch(() => {
            /* individual delivery errors are handled inside fn */
          })
          .finally(() => {
            active--;
            settled++;
            if (settled === total) resolve();
            else next();
          });
      }
    }

    next();
  });
}

// ─────────────────────────────────────────────────────────────────────────────

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
 * Concurrency is bounded by DISPATCH_CONCURRENCY (#483).
 */
export async function dispatchWebhooks(event: WebhookPayload): Promise<void> {
  const subs = await prisma.webhookSubscription.findMany({
    where: {
      active: true,
      ...(event.contractAddress && {
        OR: [{ contractAddress: null }, { contractAddress: event.contractAddress }],
      }),
    },
    select: {
      id: true,
      url: true,
      secret: true,
      eventType: true,
      topicSymbol: true,
      storeResponseBody: true,
      responseRetentionDays: true,
    },
  });

  const matching = subs.filter((s) => {
    if (s.eventType && s.eventType !== event.eventType) return false;
    if (s.topicSymbol && s.topicSymbol !== event.topicSymbol) return false;
    return true;
  });

  await runWithConcurrency(matching, DISPATCH_CONCURRENCY, (sub) =>
    deliverOnce(
      sub.id,
      sub.url,
      sub.secret,
      event,
      1,
      undefined,
      sub.storeResponseBody,
      sub.responseRetentionDays,
    ),
  );
}

/**
 * Retry all pending deliveries whose nextRetryAt is due.
 * Rows are claimed atomically with a processing lease so that concurrent
 * service replicas cannot pick up the same delivery twice.
 * Concurrency is bounded by DISPATCH_CONCURRENCY (#483).
 *
 * Call this on a periodic schedule (e.g. every 30s from the indexer).
 */
export async function retryPendingDeliveries(): Promise<void> {
  const now = new Date();
  const leaseExpiry = new Date(now.getTime() + LEASE_DURATION_MS);

  // Atomically claim a batch of due deliveries that are currently idle.
  const claimed = await prisma.$transaction(async (tx) => {
    const rows = await tx.webhookDelivery.findMany({
      where: {
        status: 'pending',
        nextRetryAt: { lte: now },
        OR: [
          { processingStatus: 'idle' },
          // Re-claim rows whose lease has expired (e.g. the previous worker crashed)
          { processingStatus: 'processing', leaseExpiresAt: { lte: now } },
        ],
      },
      select: { id: true },
    });

    if (rows.length === 0) return [];

    const ids = rows.map((r) => r.id);

    await tx.webhookDelivery.updateMany({
      where: {
        id: { in: ids },
        OR: [
          { processingStatus: 'idle' },
          { processingStatus: 'processing', leaseExpiresAt: { lte: now } },
        ],
      },
      data: { processingStatus: 'processing', leaseExpiresAt: leaseExpiry },
    });

    return tx.webhookDelivery.findMany({
      where: { id: { in: ids }, processingStatus: 'processing', leaseExpiresAt: leaseExpiry },
      include: {
        subscription: {
          select: {
            url: true,
            secret: true,
            active: true,
            storeResponseBody: true,
            responseRetentionDays: true,
          },
        },
      },
    });
  });

  await runWithConcurrency(claimed, DISPATCH_CONCURRENCY, async (d) => {
    // Skip deliveries for inactive subscriptions (#482).
    if (!d.subscription.active) {
      await prisma.webhookDelivery.update({
        where: { id: d.id },
        data: { status: 'cancelled', processingStatus: 'done', leaseExpiresAt: null },
      });
      return;
    }

    await deliverOnce(
      d.subscriptionId,
      d.subscription.url,
      d.subscription.secret,
      null,
      d.attempt ?? 1,
      d.id,
      d.subscription.storeResponseBody,
      d.subscription.responseRetentionDays,
    );
  });
}

/**
 * Perform a single HTTP delivery attempt.
 * Validates the destination URL against SSRF rules before every request,
 * including on each redirect hop.
 *
 * @param deliveryId  If provided, updates an existing delivery row; otherwise creates one.
 */
async function deliverOnce(
  subscriptionId: string,
  url: string,
  secret: string,
  event: WebhookPayload | null,
  attempt: number,
  deliveryId?: string,
  storeResponseBody: boolean = true,
  responseRetentionDays: number = 90,
): Promise<void> {
  let payload: WebhookPayload | null = event;
  let eventId = event?.id ?? '';

  if (!payload && deliveryId) {
    const row = await prisma.webhookDelivery.findUnique({ where: { id: deliveryId } });
    if (!row) return;
    eventId = row.eventId ?? '';
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

  // Pre-flight SSRF check before opening a socket.
  try {
    await assertSafeUrl(url);
  } catch (err) {
    const msg = err instanceof SsrfBlockedError ? err.message : String(err);
    if (deliveryId) {
      await prisma.webhookDelivery.update({
        where: { id: deliveryId },
        data: {
          status: 'failed',
          processingStatus: 'done',
          leaseExpiresAt: null,
          errorMsg: msg,
          nextRetryAt: null,
        },
      });
    }
    return;
  }

  const body = JSON.stringify({ event: payload, attempt });
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };

  // Every subscription now has a secret (#481).
  const sig = crypto.createHmac('sha256', secret).update(body).digest('hex');
  headers['X-Webhook-Signature'] = `sha256=${sig}`;

  const expiresAt = new Date(Date.now() + responseRetentionDays * 24 * 60 * 60 * 1000);

  const delivery = deliveryId
    ? await prisma.webhookDelivery.update({
        where: { id: deliveryId },
        data: { attempt, status: 'pending', nextRetryAt: null },
      })
    : await prisma.webhookDelivery.create({
        data: {
          subscriptionId,
          eventId,
          attempt,
          status: 'pending',
          processingStatus: 'processing',
          leaseExpiresAt: new Date(Date.now() + LEASE_DURATION_MS),
          expiresAt,
        },
      });

  const startMs = Date.now();

  try {
    const response = await safePost(url, body, headers, REQUEST_TIMEOUT_MS);
    _lastDeliveryLatencyMs = Date.now() - startMs;

    const success = response.status >= 200 && response.status < 300;
    const rawResponseBody = String(response.data ?? '');

    if (success) {
      const processedResponseBody = storeResponseBody
        ? processResponseBody(rawResponseBody, 500, true)
        : null;

      await prisma.webhookDelivery.update({
        where: { id: delivery.id },
        data: {
          status: 'success',
          processingStatus: 'done',
          leaseExpiresAt: null,
          httpStatus: response.status,
          responseBody: processedResponseBody,
          deliveredAt: new Date(),
        },
      });
      return;
    }

    const processedResponseBody = storeResponseBody
      ? processResponseBody(rawResponseBody, 500, true)
      : null;

    await scheduleRetryOrFail(
      delivery.id,
      attempt,
      `HTTP ${response.status}`,
      response.status,
      processedResponseBody,
    );
  } catch (err: unknown) {
    _lastDeliveryLatencyMs = Date.now() - startMs;
    const msg = err instanceof Error ? err.message : String(err);

    // SSRF blocks on redirect are permanent failures — don't retry
    if (err instanceof SsrfBlockedError) {
      await prisma.webhookDelivery.update({
        where: { id: delivery.id },
        data: {
          status: 'failed',
          processingStatus: 'done',
          leaseExpiresAt: null,
          errorMsg: msg,
          nextRetryAt: null,
        },
      });
      return;
    }

    const processedError = storeResponseBody ? processResponseBody(msg, 500, true) : null;
    await scheduleRetryOrFail(delivery.id, attempt, msg, undefined, processedError);
  }
}

async function scheduleRetryOrFail(
  deliveryId: string,
  attempt: number,
  errorMsg: string,
  httpStatus?: number,
  responseBody?: string | null,
): Promise<void> {
  const nextAttempt = attempt + 1;

  if (nextAttempt > MAX_ATTEMPTS) {
    await prisma.webhookDelivery.update({
      where: { id: deliveryId },
      data: {
        status: 'failed',
        processingStatus: 'done',
        leaseExpiresAt: null,
        errorMsg,
        httpStatus,
        responseBody,
        nextRetryAt: null,
      },
    });
    return;
  }

  const nextRetryAt = new Date(Date.now() + backoffMs(nextAttempt));
  await prisma.webhookDelivery.update({
    where: { id: deliveryId },
    data: {
      status: 'pending',
      processingStatus: 'idle',
      leaseExpiresAt: null,
      errorMsg,
      httpStatus,
      responseBody,
      nextRetryAt,
      attempt: nextAttempt,
    },
  });
}
