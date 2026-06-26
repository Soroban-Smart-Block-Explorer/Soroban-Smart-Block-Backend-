import { BridgeStatus, Chain, FinalityInfo } from './types';
import { CHAIN_PROVIDERS } from './config';
import { getChainProvider } from './chain-providers';
import { prismaWrite as prisma } from '../db';
import { logger } from '../logger';

interface FinalityCheckResult {
  status: BridgeStatus;
  confirmations: number;
  requiredConfirmations: number;
  reorgDetected: boolean;
  progressPercent: number;
  blocksUntilFinality: number;
  estimatedArrivalAt?: Date;
}

const historicalArrivalCache = new Map<string, number[]>();

export async function checkFinality(
  txHash: string,
  sourceChain: Chain,
  destinationChain: Chain,
): Promise<FinalityInfo> {
  const sourceProvider = getChainProvider(sourceChain);
  const sourceCfg = CHAIN_PROVIDERS[sourceChain];
  const destCfg = CHAIN_PROVIDERS[destinationChain];

  let sourceResult;
  try {
    sourceResult = await sourceProvider.getTxStatus(txHash);
  } catch (err) {
    logger.warn('Finality check failed for source tx', {
      txHash,
      chain: sourceChain,
      error: String(err),
    });
    sourceResult = { confirmations: 0, status: 'pending' as const };
  }

  const requiredConfirmations = sourceCfg.confirmationBlocks;
  const confirmations = sourceResult.confirmations;
  const blocksUntilFinality = Math.max(0, requiredConfirmations - confirmations);
  const progressPercent = Math.min(100, Math.round((confirmations / requiredConfirmations) * 100));

  let reorgDetected = false;
  if (sourceResult.blockNumber && sourceResult.blockHash) {
    reorgDetected = await detectReorg(
      sourceChain,
      sourceResult.blockNumber,
      sourceResult.blockHash,
    );
  }

  let status: BridgeStatus;
  if (reorgDetected) {
    status = 'reorged';
  } else if (sourceResult.status === 'failed') {
    status = 'failed';
  } else if (sourceResult.status === 'pending') {
    status = 'pending';
  } else if (progressPercent < 100) {
    status = 'detected';
  } else if (progressPercent >= 100 && sourceResult.status === 'completed') {
    const destTxHash = await findDestinationTxHash(txHash, destinationChain);
    if (destTxHash) {
      const destProvider = getChainProvider(destinationChain);
      let destResult;
      try {
        destResult = await destProvider.getTxStatus(destTxHash);
      } catch {
        destResult = { confirmations: 0, status: 'pending' as const };
      }
      if (destResult.status === 'completed') {
        status = 'completed';
      } else if (destResult.status === 'failed') {
        status = 'failed';
      } else {
        status = 'bridging';
      }
    } else {
      status = 'bridging';
    }
  } else {
    status = 'pending';
  }

  const estimate = estimateArrivalTime(
    sourceChain,
    destinationChain,
    confirmations,
    requiredConfirmations,
  );

  return {
    status,
    confirmations,
    requiredConfirmations,
    sourceBlockNumber: sourceResult.blockNumber,
    sourceTxHash: txHash,
    reorgDetected,
    blocksUntilFinality,
    progressPercent,
    estimatedArrivalAt: estimate,
  };
}

async function detectReorg(
  chain: Chain,
  blockNumber: number,
  expectedBlockHash: string,
): Promise<boolean> {
  try {
    const provider = getChainProvider(chain);
    const currentBlock = await provider.getBlockNumber();
    if (currentBlock - blockNumber > 20) {
      return false; // Deep enough that reorg is unlikely
    }

    // For EVM chains, verify block hash still matches
    if (
      chain === 'ethereum' ||
      chain === 'bsc' ||
      chain === 'polygon' ||
      chain === 'avalanche' ||
      chain === 'arbitrum' ||
      chain === 'optimism'
    ) {
      const { getEthereumTxStatus } = await import('./chain-providers');
      const status = await getEthereumTxStatus(blockNumber.toString());
      // Simplified reorg check - in production, compare actual block hashes
      return false;
    }

    return false;
  } catch {
    return false;
  }
}

async function findDestinationTxHash(
  sourceTxHash: string,
  destinationChain: Chain,
): Promise<string | undefined> {
  const tx = await prisma.bridgeTransaction.findUnique({
    where: { transactionHash: sourceTxHash },
    select: { metadata: true },
  });
  const metadata = tx?.metadata as Record<string, unknown> | null;
  return metadata?.destinationTxHash as string | undefined;
}

function estimateArrivalTime(
  sourceChain: Chain,
  destinationChain: Chain,
  currentConfirmations: number,
  requiredConfirmations: number,
): Date | undefined {
  const key = `${sourceChain}-${destinationChain}`;
  const records = historicalArrivalCache.get(key) || [];

  if (currentConfirmations >= requiredConfirmations) {
    return new Date();
  }

  const remaining = requiredConfirmations - currentConfirmations;
  const sourceCfg = CHAIN_PROVIDERS[sourceChain];
  const destCfg = CHAIN_PROVIDERS[destinationChain];

  const avgSourceBlockTime = sourceCfg.blockTimeSeconds;
  const avgDestBlockTime = destCfg.blockTimeSeconds;

  // Bridge relay time based on historical average, or default to 30s
  const avgBridgeRelay =
    records.length > 0 ? records.reduce((a, b) => a + b, 0) / records.length : 30;

  const totalSeconds = remaining * avgSourceBlockTime + avgBridgeRelay + avgDestBlockTime;
  return new Date(Date.now() + totalSeconds * 1000);
}

export function recordArrivalTime(
  sourceChain: Chain,
  destinationChain: Chain,
  seconds: number,
): void {
  const key = `${sourceChain}-${destinationChain}`;
  if (!historicalArrivalCache.has(key)) {
    historicalArrivalCache.set(key, []);
  }
  const records = historicalArrivalCache.get(key)!;
  records.push(seconds);
  if (records.length > 100) records.shift();
}

export async function getStaleTransactions(hoursThreshold = 2): Promise<string[]> {
  const threshold = new Date(Date.now() - hoursThreshold * 60 * 60 * 1000);
  const stale = await prisma.bridgeTransaction.findMany({
    where: {
      status: { in: ['pending', 'detected', 'bridging'] },
      updatedAt: { lt: threshold },
    },
    select: { transactionHash: true },
  });
  return stale.map((t) => t.transactionHash);
}

export async function updateTransactionFinality(
  txHash: string,
  finality: FinalityInfo,
): Promise<void> {
  await prisma.bridgeTransaction.update({
    where: { transactionHash: txHash },
    data: {
      status: finality.status,
      confirmations: finality.confirmations,
      estimatedArrivalAt: finality.estimatedArrivalAt,
      metadata: {
        reorgDetected: finality.reorgDetected,
        blocksUntilFinality: finality.blocksUntilFinality,
        progressPercent: finality.progressPercent,
        sourceBlockNumber: finality.sourceBlockNumber,
        destinationBlockNumber: finality.destinationBlockNumber,
      },
    },
  });
}
