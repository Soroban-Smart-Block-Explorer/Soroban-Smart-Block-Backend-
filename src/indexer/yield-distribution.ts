import { xdr, scValToNative } from '@stellar/stellar-sdk';
import { prismaWrite as prisma } from '../db';
import { fetchEvents, type LedgerEvent } from './rpc';

const DISTRIBUTION_TOPICS = new Set([
  'distribute',
  'distribute_yield',
  'distribute_yields',
  'yield_payout',
  'yield_distribution',
  'dividend',
  'dividend_payout',
  'reward_payout',
  'batch_distribute',
]);

interface DistributionData {
  recipient: string;
  amount: string;
  tokenSymbol?: string;
  distributionId?: string;
}

export function extractDistributionData(
  decoded: Record<string, unknown> | null,
): DistributionData | null {
  if (!decoded) return null;

  const data =
    decoded && typeof decoded === 'object' && 'data' in decoded
      ? (decoded as Record<string, unknown>).data
      : decoded;

  const d = data && typeof data === 'object' ? (data as Record<string, unknown>) : decoded;

  const recipient = String(d.recipient ?? d.to ?? d.address ?? d.account ?? '');
  const amount = String(d.amount ?? d.value ?? d.quantity ?? d.yield ?? '');

  if (!recipient || !amount || amount === '0' || amount === '0n') return null;

  const tokenSymbol = d.token ? String(d.token) : d.tokenSymbol ? String(d.tokenSymbol) : undefined;

  const distributionId = d.distributionId
    ? String(d.distributionId)
    : d.batchId
      ? String(d.batchId)
      : d.payoutId
        ? String(d.payoutId)
        : undefined;

  return { recipient, amount, tokenSymbol, distributionId };
}

/**
 * Called from the real-time event ingestion pipeline after an event is stored.
 * Detects distribution events and upserts individual YieldDistribution rows.
 */
export async function processYieldEvent(
  transactionHash: string,
  contractAddress: string,
  topicSymbol: string | null,
  decoded: Record<string, unknown> | null,
  ledgerSequence: number,
  ledgerCloseTime: Date,
): Promise<void> {
  if (!topicSymbol || !DISTRIBUTION_TOPICS.has(topicSymbol)) return;

  const data = extractDistributionData(decoded);
  if (!data) return;

  const windowLabel = 'Corporate Yield Distribution Sync';
  const id = `${transactionHash}-${contractAddress}-${data.recipient}-${topicSymbol}`;

  await prisma.yieldDistribution.upsert({
    where: { id },
    update: {},
    create: {
      id,
      transactionHash,
      contractAddress,
      distributionId: data.distributionId,
      recipient: data.recipient,
      amount: data.amount,
      tokenSymbol: data.tokenSymbol,
      windowLabel,
      ledgerSequence,
      ledgerCloseTime,
    },
  });
}

/**
 * Backfill processor that scans a ledger range for distribution events.
 * Can be run as a scheduled job or on-demand.
 */
export async function backfillYieldDistributions(
  startLedger: number,
  endLedger: number,
): Promise<number> {
  const events = await fetchEvents(startLedger, endLedger);
  let stored = 0;

  for (const event of events) {
    const topics = event.topics;
    if (!topics.length) continue;

    let topicSymbol: string | null = null;
    try {
      const scVal = xdr.ScVal.fromXDR(topics[0], 'base64');
      if (scVal.switch().name === 'scvSymbol') {
        topicSymbol = (scVal as any).sym()?.toString() ?? null;
      }
    } catch {
      continue;
    }

    if (!topicSymbol || !DISTRIBUTION_TOPICS.has(topicSymbol)) continue;

    let decoded: Record<string, unknown> | null = null;
    try {
      const dataScVal = xdr.ScVal.fromXDR(event.data, 'base64');
      const native = scValToNative(dataScVal);
      decoded = (
        typeof native === 'object' && native !== null ? native : { value: String(native) }
      ) as Record<string, unknown>;
    } catch {
      decoded = null;
    }

    const extracted = extractDistributionData(decoded);
    if (!extracted) continue;

    const windowLabel = 'Corporate Yield Distribution Sync';
    const id = `${event.transactionHash}-${event.contractId}-${extracted.recipient}-${topicSymbol}`;

    await prisma.yieldDistribution.upsert({
      where: { id },
      update: {},
      create: {
        id,
        transactionHash: event.transactionHash,
        contractAddress: event.contractId,
        distributionId: extracted.distributionId,
        recipient: extracted.recipient,
        amount: extracted.amount,
        tokenSymbol: extracted.tokenSymbol,
        windowLabel,
        ledgerSequence: event.ledgerSequence,
        ledgerCloseTime: event.ledgerCloseTime,
      },
    });

    stored++;
  }

  return stored;
}
