import { EventEmitter } from 'events';

type SubscriptionType =
  | 'price_alert'
  | 'wallet_activity'
  | 'contract_event'
  | 'governance_milestone'
  | 'compliance_event'
  | 'gas_price_spike'
  | 'system_announcement';

interface UserSubscription {
  id: string;
  userId: string;
  type: SubscriptionType;
  config: Record<string, unknown>;
  enabled: boolean;
  createdAt: Date;
}

interface MatchedNotification {
  userId: string;
  subscriptionId: string;
  type: SubscriptionType;
  title: string;
  body: string;
  data?: Record<string, string>;
  groupKey?: string;
  category?: string;
  deepLink?: string;
  severity?: 'low' | 'medium' | 'high' | 'critical';
}

export class SubscriptionMatcher extends EventEmitter {
  private subscriptions: Map<SubscriptionType, UserSubscription[]> = new Map();

  registerSubscription(sub: UserSubscription): void {
    const key = sub.type;
    if (!this.subscriptions.has(key)) {
      this.subscriptions.set(key, []);
    }
    this.subscriptions.get(key)!.push(sub);
  }

  unregisterSubscription(id: string): void {
    for (const [key, subs] of this.subscriptions.entries()) {
      const filtered = subs.filter((s) => s.id !== id);
      if (filtered.length === 0) {
        this.subscriptions.delete(key);
      } else {
        this.subscriptions.set(key, filtered);
      }
    }
  }

  async evaluateEvent(event: {
    type: SubscriptionType;
    data: Record<string, unknown>;
  }): Promise<MatchedNotification[]> {
    const subscribers = this.subscriptions.get(event.type) || [];
    const notifications: MatchedNotification[] = [];

    for (const sub of subscribers) {
      if (!sub.enabled) continue;
      if (this.matchesFilter(sub.config, event.data)) {
        notifications.push({
          userId: sub.userId,
          subscriptionId: sub.id,
          type: event.type,
          title: this.generateTitle(event.type, event.data),
          body: this.generateBody(event.type, event.data),
          data: { subscriptionId: sub.id, ...event.data } as Record<string, string>,
          groupKey: this.getGroupKey(event.type, event.data),
          category: this.getCategory(event.type),
          deepLink: this.getDeepLink(event.type, event.data),
          severity: this.getSeverity(event.type, event.data),
        });
      }
    }
    return notifications;
  }

  private matchesFilter(config: Record<string, unknown>, data: Record<string, unknown>): boolean {
    for (const [key, value] of Object.entries(config)) {
      if (key === 'threshold') {
        const dataValue = Number(data.value ?? 0);
        if (dataValue < Number(value)) return false;
      } else if (key === 'addresses' && Array.isArray(value)) {
        const dataAddress = (data.address ?? data.contractAddress ?? data.sourceAccount) as string;
        if (!value.includes(dataAddress)) return false;
      } else if (key === 'contracts' && Array.isArray(value)) {
        const dataContract = (data.contractAddress ?? data.contract) as string;
        if (!value.includes(dataContract)) return false;
      }
    }
    return true;
  }

  private generateTitle(type: SubscriptionType, data: Record<string, unknown>): string {
    const titles: Record<SubscriptionType, string> = {
      price_alert: `Price Alert: ${data.symbol ?? 'Token'} ${data.direction === 'up' ? '↑' : '↓'} ${data.change ?? ''}`,
      wallet_activity: `Wallet Activity: ${(data.address as string)?.slice(0, 8)}...`,
      contract_event: `Contract Event: ${(data.contractAddress as string)?.slice(0, 8)}...`,
      governance_milestone: `Governance: ${data.eventType ?? 'Update'}`,
      compliance_event: `Compliance Alert: ${data.severity ?? 'Info'}`,
      gas_price_spike: `Gas Price Spike: ${data.value} stroops`,
      system_announcement: `System: ${data.message ?? 'Announcement'}`,
    };
    return titles[type];
  }

  private generateBody(type: SubscriptionType, data: Record<string, unknown>): string {
    const bodies: Record<SubscriptionType, string> = {
      price_alert: `${data.symbol ?? 'Token'} is now $${data.price} (${data.change}%)`,
      wallet_activity: `New transaction from ${(data.address as string)?.slice(0, 8)}...`,
      contract_event: `Event ${data.eventType} from contract ${(data.contractAddress as string)?.slice(0, 8)}...`,
      governance_milestone: `Proposal ${data.proposalId}: ${data.eventType}`,
      compliance_event: `${data.description ?? 'Compliance event detected'}`,
      gas_price_spike: `Gas price at ${data.value} stroops`,
      system_announcement: `${data.message ?? 'System announcement'}`,
    };
    return bodies[type];
  }

  private getGroupKey(type: SubscriptionType, data: Record<string, unknown>): string {
    const keys: Record<SubscriptionType, string> = {
      wallet_activity: `wallet_tx_${data.address}`,
      price_alert: `price_alert_${data.symbol}`,
      contract_event: `contract_event_${data.contractAddress}`,
      compliance_event: `compliance_${data.address}`,
      governance_milestone: `governance_${data.proposalId}`,
      gas_price_spike: `gas_spike_${Date.now()}`,
      system_announcement: `system_${Date.now()}`,
    };
    return keys[type];
  }

  private getCategory(type: SubscriptionType): string {
    const categories: Record<SubscriptionType, string> = {
      compliance_event: 'compliance',
      governance_milestone: 'governance',
      price_alert: 'price',
      wallet_activity: 'wallet',
      contract_event: 'contract',
      gas_price_spike: 'gas',
      system_announcement: 'system',
    };
    return categories[type];
  }

  private getSeverity(
    type: SubscriptionType,
    data: Record<string, unknown>,
  ): 'low' | 'medium' | 'high' | 'critical' {
    if (type === 'compliance_event') {
      return (data.severity as 'low' | 'medium' | 'high' | 'critical') ?? 'high';
    }
    if (type === 'gas_price_spike') {
      const value = Number(data.value ?? 0);
      return value > 10000 ? 'critical' : value > 5000 ? 'high' : 'medium';
    }
    return 'low';
  }

  private getDeepLink(type: SubscriptionType, data: Record<string, unknown>): string | undefined {
    switch (type) {
      case 'wallet_activity':
        return `soroban://wallet/${data.address}`;
      case 'contract_event':
        return `soroban://contract/${data.contractAddress}`;
      case 'governance_milestone':
        return `soroban://proposal/${data.proposalId}`;
      default:
        return undefined;
    }
  }
}
