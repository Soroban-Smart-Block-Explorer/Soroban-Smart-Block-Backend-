import axios from 'axios';
import { logger } from '../../logger';
import { recordAudit } from './audit';

export type WebhookEventType =
  | 'match.found'
  | 'list.updated'
  | 'address.status_changed'
  | 'match.reviewed';

interface WebhookPayload {
  event: WebhookEventType;
  timestamp: string;
  data: Record<string, unknown>;
}

interface RegisteredWebhook {
  id: string;
  url: string;
  events: WebhookEventType[];
  secret?: string;
  active: boolean;
}

const registeredWebhooks: Map<string, RegisteredWebhook> = new Map();

export function registerWebhook(
  url: string,
  events: WebhookEventType[],
  secret?: string,
): RegisteredWebhook {
  const id = `wh_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const webhook: RegisteredWebhook = { id, url, events, secret, active: true };
  registeredWebhooks.set(id, webhook);

  recordAudit({
    action: 'register_webhook',
    resourceType: 'webhook',
    resourceId: id,
    details: { url, events },
  });

  return webhook;
}

export function unregisterWebhook(id: string): boolean {
  const existing = registeredWebhooks.get(id);
  if (existing) {
    existing.active = false;
    registeredWebhooks.set(id, existing);
    return true;
  }
  return false;
}

export function listWebhooks(): RegisteredWebhook[] {
  return Array.from(registeredWebhooks.values()).filter((w) => w.active);
}

export function getWebhook(id: string): RegisteredWebhook | undefined {
  return registeredWebhooks.get(id);
}

export async function triggerComplianceWebhooks(
  event: WebhookEventType,
  data: Record<string, unknown>,
): Promise<void> {
  const payload: WebhookPayload = {
    event,
    timestamp: new Date().toISOString(),
    data,
  };

  const targets = Array.from(registeredWebhooks.values()).filter(
    (w) => w.active && w.events.includes(event),
  );

  if (targets.length === 0) return;

  const deliveryPromises = targets.map(async (webhook) => {
    const delays = [10000, 30000, 60000];
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          'X-Webhook-Event': event,
          'X-Delivery-Attempt': String(attempt + 1),
        };

        if (webhook.secret) {
          headers['X-Webhook-Signature'] = webhook.secret;
        }

        await axios.post(webhook.url, payload, {
          headers,
          timeout: 10000,
        });

        logger.info(`Webhook delivered`, { webhookId: webhook.id, event, attempt: attempt + 1 });
        return;
      } catch (err) {
        lastError = err as Error;
        logger.warn(`Webhook delivery failed`, {
          webhookId: webhook.id,
          event,
          attempt: attempt + 1,
          error: (err as Error).message,
        });
        if (attempt < 2) {
          await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
        }
      }
    }

    logger.error(`Webhook delivery exhausted retries`, {
      webhookId: webhook.id,
      event,
      error: lastError?.message,
    });
  });

  await Promise.allSettled(deliveryPromises);
}

let lastListUpdateNotification = '';

export function notifyListUpdated(source: string, version: string): void {
  const key = `${source}_${version}`;
  if (key === lastListUpdateNotification) return;
  lastListUpdateNotification = key;

  triggerComplianceWebhooks('list.updated', {
    source,
    listVersion: version,
    updatedAt: new Date().toISOString(),
  }).catch((err) => logger.error('List update webhook failed', { error: (err as Error).message }));
}

export async function notifyAddressStatusChanged(
  address: string,
  previousStatus: string,
  newStatus: string,
): Promise<void> {
  triggerComplianceWebhooks('address.status_changed', {
    address,
    previousStatus,
    newStatus,
    timestamp: new Date().toISOString(),
  }).catch((err) =>
    logger.error('Status change webhook failed', { error: (err as Error).message }),
  );
}
