import { prismaRead } from '../../db';
import { logger } from '../../logger';
import { recordAudit } from './audit';

export interface Anomaly {
  id: string;
  type: string;
  severity: string;
  description: string;
  addresses: string[];
  txHashes: string[];
  score: number;
  detectedAt: string;
  status: 'open' | 'investigating' | 'resolved' | 'false_positive';
  reviewedBy?: string;
  reviewedAt?: string;
  notes?: string;
}

const anomalies: Anomaly[] = [];

function detectStructuring(address: string, recentTxs: any[]): Anomaly | null {
  const largeTxs = recentTxs.filter((tx: any) => {
    const fee = parseFloat(tx.feeCharged ?? '0');
    return fee > 0.1;
  });

  if (largeTxs.length >= 5) {
    const timeWindows = largeTxs.map((tx: any) => new Date(tx.createdAt).getTime());
    const sortedWindows = [...timeWindows].sort((a, b) => a - b);
    const spans: number[] = [];
    for (let i = 1; i < sortedWindows.length; i++) {
      spans.push(sortedWindows[i] - sortedWindows[i - 1]);
    }

    if (spans.length > 0) {
      const avgSpan = spans.reduce((a, b) => a + b, 0) / spans.length;
      if (avgSpan < 3600000 && avgSpan > 60000) {
        return {
          id: `anom_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          type: 'structuring',
          severity: 'high',
          description: `Potential transaction structuring detected: ${largeTxs.length} large transactions in short time window`,
          addresses: [address],
          txHashes: largeTxs.map((tx: any) => tx.hash).filter(Boolean),
          score: 75,
          detectedAt: new Date().toISOString(),
          status: 'open',
        };
      }
    }
  }

  return null;
}

function detectRoundTrip(address: string, recentTxs: any[]): Anomaly | null {
  const txsByContract = new Map<string, any[]>();
  for (const tx of recentTxs) {
    const contract = tx.contractAddress;
    if (contract) {
      if (!txsByContract.has(contract)) txsByContract.set(contract, []);
      txsByContract.get(contract)!.push(tx);
    }
  }

  for (const [, txs] of txsByContract) {
    if (txs.length >= 3) {
      const sources = new Set(txs.map((tx: any) => tx.sourceAccount));
      if (sources.size >= 3 && sources.has(address)) {
        return {
          id: `anom_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          type: 'round_trip',
          severity: 'medium',
          description: `Potential round-trip transaction pattern detected involving ${sources.size} addresses`,
          addresses: Array.from(sources) as string[],
          txHashes: txs.map((tx: any) => tx.hash).filter(Boolean),
          score: 60,
          detectedAt: new Date().toISOString(),
          status: 'open',
        };
      }
    }
  }

  return null;
}

function detectNewAddressPattern(address: string, recentTxs: any[]): Anomaly | null {
  const oldTxs = recentTxs.filter((tx: any) => {
    const age = Date.now() - new Date(tx.createdAt).getTime();
    return age > 86400000 * 7;
  });

  const newTxs = recentTxs.filter((tx: any) => {
    const age = Date.now() - new Date(tx.createdAt).getTime();
    return age <= 86400000 * 7;
  });

  if (oldTxs.length < 3 && newTxs.length >= 10) {
    return {
      id: `anom_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      type: 'new_address_emergence',
      severity: 'low',
      description: `Rapid activity from relatively new address: ${newTxs.length} transactions in last 7 days`,
      addresses: [address],
      txHashes: newTxs.map((tx: any) => tx.hash).filter(Boolean),
      score: 40,
      detectedAt: new Date().toISOString(),
      status: 'open',
    };
  }

  return null;
}

export async function detectAnomalies(address?: string): Promise<Anomaly[]> {
  const detected: Anomaly[] = [];

  try {
    const txs = await prismaRead.transaction.findMany({
      where: address ? { sourceAccount: address } : {},
      orderBy: { createdAt: 'desc' },
      take: 200,
    });

    const addressesToCheck = address ? [address] : [...new Set(txs.map(t => t.sourceAccount))].slice(0, 50);

    for (const addr of addressesToCheck) {
      const addrTxs = txs.filter(t => t.sourceAccount === addr);

      const structuring = detectStructuring(addr, addrTxs);
      if (structuring) {
        detected.push(structuring);
        anomalies.push(structuring);
      }

      const roundTrip = detectRoundTrip(addr, addrTxs);
      if (roundTrip) {
        detected.push(roundTrip);
        anomalies.push(roundTrip);
      }

      const newPattern = detectNewAddressPattern(addr, addrTxs);
      if (newPattern) {
        detected.push(newPattern);
        anomalies.push(newPattern);
      }
    }
  } catch (err) {
    logger.error('Anomaly detection failed', { error: (err as Error).message });
  }

  return detected;
}

export function listAnomalies(
  limit: number = 50,
  offset: number = 0,
  status?: string,
): { anomalies: Anomaly[]; total: number } {
  let filtered = [...anomalies];
  if (status) {
    filtered = filtered.filter(a => a.status === status);
  }
  filtered.sort((a, b) => new Date(b.detectedAt).getTime() - new Date(a.detectedAt).getTime());

  return {
    anomalies: filtered.slice(offset, offset + limit),
    total: filtered.length,
  };
}

export function reviewAnomaly(
  id: string,
  status: 'investigating' | 'resolved' | 'false_positive',
  reviewedBy?: string,
  notes?: string,
): Anomaly | null {
  const index = anomalies.findIndex(a => a.id === id);
  if (index === -1) return null;

  anomalies[index] = {
    ...anomalies[index],
    status,
    reviewedBy,
    reviewedAt: new Date().toISOString(),
    notes,
  };

  recordAudit({
    action: 'anomaly_review',
    resourceType: 'anomaly',
    resourceId: id,
    details: { status, reviewedBy },
  });

  return anomalies[index];
}
