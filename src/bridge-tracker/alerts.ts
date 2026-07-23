import {
  AlertSeverity,
  AlertType,
  BridgeProtocol,
  Chain,
  MonitoredAddressEntry,
  BridgeAlertEntry,
} from './types';
import { ALERT_CONFIG } from './config';
import { prismaWrite as prisma, prismaRead } from '../db';
import { logger } from '../logger';

const LARGE_TRANSFER_THRESHOLD_USD = ALERT_CONFIG.largeTransferThresholdUsd;
const MAX_DELAY_MINUTES = ALERT_CONFIG.maxDelayMinutes;

export async function checkLargeTransfer(
  protocol: BridgeProtocol,
  chain: Chain,
  asset: string,
  amount: string,
  sender: string,
  recipient: string,
  txHash: string,
): Promise<BridgeAlertEntry | null> {
  const amountNum = parseFloat(amount);
  if (isNaN(amountNum) || amountNum < LARGE_TRANSFER_THRESHOLD_USD) return null;

  const alert: BridgeAlertEntry = {
    id: '',
    type: 'large_transfer',
    severity: amountNum >= LARGE_TRANSFER_THRESHOLD_USD * 10 ? 'critical' : 'warning',
    protocol,
    chain,
    transactionHash: txHash,
    asset,
    amount: amount,
    message: `Large ${protocol} transfer detected: ${amount} ${asset} from ${sender.slice(0, 10)}... to ${recipient.slice(0, 10)}... on ${chain}`,
    data: { sender, recipient },
    acknowledged: false,
    triggeredAt: new Date(),
  };

  await storeAlert(alert);
  logger.warn('Large transfer alert triggered', {
    amount,
    asset,
    protocol,
    chain,
    threshold: LARGE_TRANSFER_THRESHOLD_USD,
  });

  return alert;
}

export async function checkBridgeDelay(
  txHash: string,
  protocol: BridgeProtocol,
  sourceChain: Chain,
  destinationChain: Chain,
  createdAt: Date,
  currentStatus: string,
): Promise<BridgeAlertEntry | null> {
  if (currentStatus === 'completed' || currentStatus === 'failed') return null;

  const elapsedMinutes = (Date.now() - createdAt.getTime()) / 60000;
  if (elapsedMinutes < MAX_DELAY_MINUTES) return null;

  const alert: BridgeAlertEntry = {
    id: '',
    type: 'bridge_delay',
    severity: elapsedMinutes >= MAX_DELAY_MINUTES * 3 ? 'critical' : 'warning',
    protocol,
    chain: sourceChain,
    transactionHash: txHash,
    message: `Bridge delay detected on ${protocol}: ${sourceChain}→${destinationChain} — tx ${txHash.slice(0, 10)}... has been pending for ${Math.round(elapsedMinutes)} minutes`,
    data: { sourceChain, destinationChain, elapsedMinutes, createdAt: createdAt.toISOString() },
    acknowledged: false,
    triggeredAt: new Date(),
  };

  await storeAlert(alert);
  logger.warn('Bridge delay alert triggered', { txHash, protocol, elapsedMinutes });

  return alert;
}

export async function checkBridgeFailure(
  txHash: string,
  protocol: BridgeProtocol,
  chain: Chain,
): Promise<BridgeAlertEntry> {
  const alert: BridgeAlertEntry = {
    id: '',
    type: 'bridge_failure',
    severity: 'critical',
    protocol,
    chain,
    transactionHash: txHash,
    message: `Bridge transaction failed on ${protocol} (${chain}): ${txHash.slice(0, 10)}...`,
    data: {},
    acknowledged: false,
    triggeredAt: new Date(),
  };

  await storeAlert(alert);
  logger.error('Bridge failure alert triggered', { txHash, protocol, chain });

  return alert;
}

export async function checkMonitoredAddressActivity(
  txHash: string,
  sender: string,
  recipient: string,
  chain: Chain,
  protocol: BridgeProtocol,
  amount: string,
  asset: string,
): Promise<BridgeAlertEntry[]> {
  const alerts: BridgeAlertEntry[] = [];
  const addresses = [sender, recipient].filter(Boolean);

  if (addresses.length === 0) return alerts;

  const monitored = await prismaRead.monitoredAddress.findMany({
    where: {
      address: { in: addresses },
      chain,
      active: true,
    },
  });

  const monitoredMap = new Map(monitored.map((m) => [m.address, m]));

  for (const addr of addresses) {
    const record = monitoredMap.get(addr);
    if (!record) continue;

    const amountNum = parseFloat(amount);
    const minUsd = record.minAlertUsd ? Number(record.minAlertUsd) : undefined;
    if (minUsd !== undefined && amountNum < minUsd) continue;

    const severity: AlertSeverity =
      amountNum >= (minUsd ?? LARGE_TRANSFER_THRESHOLD_USD) * 5 ? 'critical' : 'warning';

    const alert: BridgeAlertEntry = {
      id: '',
      type: 'address_activity',
      severity,
      protocol,
      chain,
      address: addr,
      transactionHash: txHash,
      asset,
      amount,
      message: `Monitored address ${addr.slice(0, 10)}... activity on ${protocol}: ${amount} ${asset} (${chain})`,
      data: { sender, recipient, label: record.label },
      acknowledged: false,
      triggeredAt: new Date(),
    };

    alerts.push(alert);
    await storeAlert(alert);
    logger.info('Address activity alert triggered', { address: addr, protocol, amount });
  }

  return alerts;
}

async function storeAlert(alert: BridgeAlertEntry): Promise<string> {
  const created = await prisma.bridgeAlert.create({
    data: {
      type: alert.type,
      severity: alert.severity,
      protocol: alert.protocol ?? null,
      chain: alert.chain ?? null,
      address: alert.address ?? null,
      transactionHash: alert.transactionHash ?? null,
      asset: alert.asset ?? null,
      amount: alert.amount ?? null,
      message: alert.message,
      data: (alert.data ?? undefined) as any,
    },
  });
  return created.id;
}

export async function acknowledgeAlert(alertId: string): Promise<void> {
  await prisma.bridgeAlert.update({
    where: { id: alertId },
    data: { acknowledged: true },
  });
}

export async function getAlerts(
  options: {
    type?: AlertType;
    severity?: AlertSeverity;
    acknowledged?: boolean;
    limit?: number;
    offset?: number;
  } = {},
): Promise<{ alerts: BridgeAlertEntry[]; total: number }> {
  const where: Record<string, unknown> = {};
  if (options.type) where.type = options.type;
  if (options.severity) where.severity = options.severity;
  if (options.acknowledged !== undefined) where.acknowledged = options.acknowledged;

  const [alerts, total] = await Promise.all([
    prismaRead.bridgeAlert.findMany({
      where,
      orderBy: { triggeredAt: 'desc' },
      take: options.limit ?? 50,
      skip: options.offset ?? 0,
    }),
    prismaRead.bridgeAlert.count({ where }),
  ]);

  return {
    alerts: alerts.map((a) => ({
      id: a.id,
      type: a.type as AlertType,
      severity: a.severity as AlertSeverity,
      protocol: a.protocol ?? undefined,
      chain: a.chain ?? undefined,
      address: a.address ?? undefined,
      transactionHash: a.transactionHash ?? undefined,
      asset: a.asset ?? undefined,
      amount: a.amount?.toString(),
      message: a.message,
      data: a.data as Record<string, unknown> | undefined,
      acknowledged: a.acknowledged,
      triggeredAt: a.triggeredAt,
    })),
    total,
  };
}

// ── Monitored Address Management ────────────────────────────────────────────

export async function addMonitoredAddress(
  address: string,
  chain: Chain,
  options: {
    label?: string;
    minAlertUsd?: number;
    alertOnTx?: boolean;
    alertOnBridging?: boolean;
  } = {},
): Promise<MonitoredAddressEntry> {
  const created = await prisma.monitoredAddress.upsert({
    where: { address_chain: { address, chain } },
    update: {
      label: options.label ?? undefined,
      minAlertUsd: options.minAlertUsd ?? undefined,
      alertOnTx: options.alertOnTx ?? true,
      alertOnBridging: options.alertOnBridging ?? true,
      active: true,
    },
    create: {
      address,
      chain,
      label: options.label,
      minAlertUsd: options.minAlertUsd,
      alertOnTx: options.alertOnTx ?? true,
      alertOnBridging: options.alertOnBridging ?? true,
    },
  });

  return {
    id: created.id,
    address: created.address,
    chain: created.chain as Chain,
    label: created.label ?? undefined,
    minAlertUsd: created.minAlertUsd ? Number(created.minAlertUsd) : undefined,
    alertOnTx: created.alertOnTx,
    alertOnBridging: created.alertOnBridging,
    active: created.active,
  };
}

export async function removeMonitoredAddress(id: string): Promise<void> {
  await prisma.monitoredAddress.update({
    where: { id },
    data: { active: false },
  });
}

export async function listMonitoredAddresses(activeOnly = true): Promise<MonitoredAddressEntry[]> {
  const where: Record<string, unknown> = {};
  if (activeOnly) where.active = true;

  const records = await prismaRead.monitoredAddress.findMany({ where });
  return records.map((r) => ({
    id: r.id,
    address: r.address,
    chain: r.chain as Chain,
    label: r.label ?? undefined,
    minAlertUsd: r.minAlertUsd ? Number(r.minAlertUsd) : undefined,
    alertOnTx: r.alertOnTx,
    alertOnBridging: r.alertOnBridging,
    active: r.active,
  }));
}

export async function runAlertChecks(): Promise<number> {
  let alertCount = 0;

  // Check for stale/bridge delays
  const staleTxs = await prismaRead.bridgeTransaction.findMany({
    where: {
      status: { in: ['pending', 'detected', 'bridging'] },
      createdAt: { lt: new Date(Date.now() - MAX_DELAY_MINUTES * 60 * 1000) },
    },
    take: 100,
  });

  for (const tx of staleTxs) {
    try {
      const alert = await checkBridgeDelay(
        tx.transactionHash,
        tx.protocol as BridgeProtocol,
        tx.sourceChain as Chain,
        tx.destinationChain as Chain,
        tx.createdAt,
        tx.status,
      );
      if (alert) alertCount++;
    } catch (err) {
      logger.error('Alert check failed for stale tx', {
        txHash: tx.transactionHash,
        error: String(err),
      });
    }
  }

  // Check for failed transactions
  const failedTxs = await prismaRead.bridgeTransaction.findMany({
    where: { status: 'failed' },
    take: 50,
  });

  for (const tx of failedTxs) {
    try {
      // Check if we already alerted for this failure
      const existingAlert = await prismaRead.bridgeAlert.findFirst({
        where: { transactionHash: tx.transactionHash, type: 'bridge_failure' },
      });
      if (!existingAlert) {
        await checkBridgeFailure(
          tx.transactionHash,
          tx.protocol as BridgeProtocol,
          tx.sourceChain as Chain,
        );
        alertCount++;
      }
    } catch (err) {
      logger.error('Alert check failed for failed tx', {
        txHash: tx.transactionHash,
        error: String(err),
      });
    }
  }

  return alertCount;
}
