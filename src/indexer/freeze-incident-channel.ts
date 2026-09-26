/**
 * Freeze-system incident alert channel (VE05).
 *
 * Fans CAP-0077 freeze violations out to subscribers in real time over SSE
 * and SSRF-guarded webhooks. Incidents are de-duplicated by transaction hash
 * and delivered only to subscribers whose minimum severity is met.
 */
import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { logger } from '../logger';
import { safePost } from '../webhooks/ssrf-guard';

export type FreezeSeverity = 'low' | 'medium' | 'high' | 'critical';
const RANK: Record<FreezeSeverity, number> = { low: 0, medium: 1, high: 2, critical: 3 };

export interface FreezeIncident {
  id: string;
  transactionHash: string;
  contractAddress: string | null;
  ledgerSequence: number;
  severity: FreezeSeverity;
  frozenKeys: string[];
  detectedAt: string;
}

export interface WebhookSubscriber {
  id: string;
  url: string;
  minSeverity: FreezeSeverity;
}

const DEDUPE_TTL_MS = 10 * 60 * 1000;
const MAX_RECENT = 500;

class FreezeIncidentChannel {
  readonly events = new EventEmitter();
  private recent: FreezeIncident[] = [];
  private seen = new Map<string, number>();
  private webhooks = new Map<string, WebhookSubscriber>();

  constructor() {
    this.events.setMaxListeners(0);
  }

  publish(input: Omit<FreezeIncident, 'id' | 'detectedAt'>, now = Date.now()): FreezeIncident | null {
    for (const [hash, ts] of this.seen) if (now - ts > DEDUPE_TTL_MS) this.seen.delete(hash);
    if (this.seen.has(input.transactionHash)) return null;
    this.seen.set(input.transactionHash, now);

    const incident: FreezeIncident = {
      ...input,
      id: randomUUID(),
      detectedAt: new Date(now).toISOString(),
    };
    this.recent.push(incident);
    if (this.recent.length > MAX_RECENT) this.recent.shift();
    this.events.emit('incident', incident);
    this.deliverWebhooks(incident);
    return incident;
  }

  listRecent(minSeverity: FreezeSeverity = 'low', limit = 50): FreezeIncident[] {
    return this.recent
      .filter((i) => RANK[i.severity] >= RANK[minSeverity])
      .slice(-limit)
      .reverse();
  }

  addWebhook(url: string, minSeverity: FreezeSeverity): WebhookSubscriber {
    const sub = { id: randomUUID(), url, minSeverity };
    this.webhooks.set(sub.id, sub);
    return sub;
  }

  removeWebhook(id: string): boolean {
    return this.webhooks.delete(id);
  }

  listWebhooks(): WebhookSubscriber[] {
    return [...this.webhooks.values()];
  }

  meetsSeverity(incident: FreezeIncident, min: FreezeSeverity): boolean {
    return RANK[incident.severity] >= RANK[min];
  }

  private deliverWebhooks(incident: FreezeIncident): void {
    for (const sub of this.webhooks.values()) {
      if (!this.meetsSeverity(incident, sub.minSeverity)) continue;
      safePost(
        sub.url,
        JSON.stringify({ alert: 'FREEZE_INCIDENT', incident }),
        { 'Content-Type': 'application/json' },
        5000,
      ).catch((err) =>
        logger.error('[freeze-incident-channel] webhook delivery failed', {
          subscriber: sub.id,
          err: String(err),
        }),
      );
    }
  }
}

export const freezeIncidentChannel = new FreezeIncidentChannel();
