import { prismaWrite as prisma } from '../db';
import { EventEmitter } from 'events';

interface WhaleThreshold {
  asset: string;
  threshold: number; // in base units
  usdEquivalent?: number;
}

interface WhaleAlert {
  transactionHash: string;
  contractAddress: string;
  eventType: string;
  asset: string;
  amount: number;
  usdValue?: number;
  sourceAccount: string;
  ledgerSequence: number;
  timestamp: Date;
}

const DEFAULT_THRESHOLDS: WhaleThreshold[] = [
  { asset: 'USDC', threshold: 50000e6, usdEquivalent: 50000 }, // 50k USDC
  { asset: 'XLM', threshold: 250000e7, usdEquivalent: 250000 }, // 250k XLM
  { asset: 'USDT', threshold: 50000e6, usdEquivalent: 50000 },
];

export class WhaleWatcher extends EventEmitter {
  private thresholds: Map<string, WhaleThreshold>;

  constructor(customThresholds?: WhaleThreshold[]) {
    super();
    this.thresholds = new Map();
    const thresholds = customThresholds || DEFAULT_THRESHOLDS;
    thresholds.forEach((t) => this.thresholds.set(t.asset, t));
  }

  async monitorEvent(event: any): Promise<void> {
    try {
      const decoded = event.decoded || {};
      const asset = decoded.asset || decoded.symbol;
      const amount = decoded.amount || decoded.value;

      if (!asset || !amount) return;

      const threshold = this.thresholds.get(asset);
      if (!threshold) return;

      if (amount >= threshold.threshold) {
        const alert: WhaleAlert = {
          transactionHash: event.transactionHash,
          contractAddress: event.contractAddress,
          eventType: event.eventType,
          asset,
          amount,
          usdValue: threshold.usdEquivalent
            ? (amount / 1e6) * (threshold.usdEquivalent / threshold.threshold)
            : undefined,
          sourceAccount: event.sourceAccount,
          ledgerSequence: event.ledgerSequence,
          timestamp: new Date(event.ledgerCloseTime),
        };

        await this.handleWhaleAlert(alert);
      }
    } catch (err) {
      console.error('[WhaleWatcher] Error monitoring event:', err);
    }
  }

  private async handleWhaleAlert(alert: WhaleAlert): Promise<void> {
    console.log(
      `[WhaleWatcher] 🐋 WHALE ALERT: ${alert.amount} ${alert.asset} (${alert.usdValue?.toFixed(2)} USD) on tx ${alert.transactionHash}`,
    );

    // Emit for real-time push notifications
    this.emit('whale-alert', alert);

    // Store alert metadata for dashboard
    try {
      await prisma.transaction.update({
        where: { hash: alert.transactionHash },
        data: {
          humanReadable: `🐋 WHALE: ${alert.amount} ${alert.asset} transferred (${alert.usdValue?.toFixed(2)} USD)`,
        },
      });
    } catch (err) {
      console.error('[WhaleWatcher] Error storing whale alert:', err);
    }
  }

  setThreshold(asset: string, threshold: number, usdEquivalent?: number): void {
    this.thresholds.set(asset, { asset, threshold, usdEquivalent });
    console.log(
      `[WhaleWatcher] Updated threshold for ${asset}: ${threshold} (${usdEquivalent} USD)`,
    );
  }

  getThresholds(): WhaleThreshold[] {
    return Array.from(this.thresholds.values());
  }
}

let whaleWatcher: WhaleWatcher | null = null;

export function initWhaleWatcher(customThresholds?: WhaleThreshold[]): WhaleWatcher {
  whaleWatcher = new WhaleWatcher(customThresholds);

  // Listen for whale alerts and broadcast to connected clients
  whaleWatcher.on('whale-alert', (alert: WhaleAlert) => {
    console.log(`[WhaleWatcher] Broadcasting alert to ${alert.transactionHash}`);
    // In production, this would push to WebSocket clients or notification service
  });

  return whaleWatcher;
}

export function getWhaleWatcher(): WhaleWatcher {
  if (!whaleWatcher) {
    whaleWatcher = new WhaleWatcher();
  }
  return whaleWatcher;
}
