import { Chain, ChainProviderConfig, BridgeEvent, BridgeStatus, BridgeProtocol } from './types';
import { CHAIN_PROVIDERS, BRIDGE_SCANNER_URLS } from './config';
import {
  getChainProvider,
} from './chain-providers';
import { prismaWrite as prisma } from '../db';
import { logger } from '../logger';

interface ResolvedTransaction {
  transactionHash: string;
  sourceChain: Chain;
  destinationChain: Chain;
  sourceStatus: BridgeStatus;
  destinationStatus: BridgeStatus;
  sourceConfirmations: number;
  destinationConfirmations: number;
  sourceBlockNumber?: number;
  destinationBlockNumber?: number;
  sourceTxHash: string;
  destinationTxHash?: string;
}

export async function resolveBridgeTransaction(
  bridgeTx: BridgeEvent,
): Promise<ResolvedTransaction> {
  const sourceProvider = getChainProvider(bridgeTx.sourceChain);

  let sourceResult: {
    confirmations: number;
    status: string;
    blockNumber?: number;
    blockHash?: string;
  };
  try {
    const result = await sourceProvider.getTxStatus(bridgeTx.transactionHash);
    sourceResult = result;
  } catch (err) {
    logger.warn('Failed to resolve source chain tx', {
      txHash: bridgeTx.transactionHash,
      chain: bridgeTx.sourceChain,
      error: String(err),
    });
    sourceResult = { confirmations: 0, status: 'pending' };
  }

  let overallStatus: BridgeStatus;
  if (sourceResult.status === 'failed') {
    overallStatus = 'failed';
  } else if (sourceResult.status === 'pending') {
    overallStatus = 'pending';
  } else if (sourceResult.status === 'completed' && sourceResult.confirmations < 12) {
    overallStatus = 'detected';
  } else {
    overallStatus = 'bridging';
  }

  // Try to find matching destination tx via event correlation
  let destResult: { confirmations: number; status: string; blockNumber?: number } = {
    confirmations: 0,
    status: 'pending',
  };
  let destTxHash: string | undefined;

  if (sourceResult.status === 'completed') {
    try {
      const destProvider = getChainProvider(bridgeTx.destinationChain);
      const correlatingTx = await findCorrelatingTx(bridgeTx);
      if (correlatingTx) {
        destTxHash = correlatingTx;
        const result = await destProvider.getTxStatus(correlatingTx);
        destResult = result;
        if (result.status === 'completed' && result.confirmations >= 1) {
          overallStatus = 'completed';
        } else if (result.status === 'failed') {
          overallStatus = 'failed';
        }
      }
    } catch (err) {
      logger.warn('Destination resolution failed', {
        txHash: bridgeTx.transactionHash,
        destChain: bridgeTx.destinationChain,
        error: String(err),
      });
    }
  }

  return {
    transactionHash: bridgeTx.transactionHash,
    sourceChain: bridgeTx.sourceChain,
    destinationChain: bridgeTx.destinationChain,
    sourceStatus: sourceResult.status as BridgeStatus,
    destinationStatus: destResult.status as BridgeStatus,
    sourceConfirmations: sourceResult.confirmations,
    destinationConfirmations: destResult.confirmations,
    sourceBlockNumber: sourceResult.blockNumber,
    destinationBlockNumber: destResult.blockNumber,
    sourceTxHash: bridgeTx.transactionHash,
    destinationTxHash: destTxHash,
  };
}

async function findCorrelatingTx(bridgeTx: BridgeEvent): Promise<string | undefined> {
  // In a production system, this would scan destination chain events
  // Looking for matching transfer events from the bridge contract
  // For now, return undefined (the worker will resolve this via polling)
  return undefined;
}

export async function storeBridgeTransaction(
  bridgeEvent: BridgeEvent,
  resolved: ResolvedTransaction,
): Promise<void> {
  try {
    const cfg = CHAIN_PROVIDERS[bridgeEvent.sourceChain];
    const destCfg = CHAIN_PROVIDERS[bridgeEvent.destinationChain];
    const sourceUrl = BRIDGE_SCANNER_URLS[bridgeEvent.sourceChain];
    const destUrl = BRIDGE_SCANNER_URLS[bridgeEvent.destinationChain];

    const status: BridgeStatus =
      resolved.sourceStatus === 'failed' || resolved.destinationStatus === 'failed'
        ? 'failed'
        : resolved.destinationStatus === 'completed'
          ? 'completed'
          : resolved.sourceStatus === 'pending'
            ? 'pending'
            : 'bridging';

    await prisma.bridgeTransaction.upsert({
      where: { transactionHash: bridgeEvent.transactionHash },
      update: {
        status,
        confirmations: resolved.sourceConfirmations,
        requiredConfirmations: cfg.confirmationBlocks,
        destinationTxUrl:
          resolved.destinationTxHash && destUrl
            ? `${destUrl}${resolved.destinationTxHash}`
            : undefined,
        estimatedArrivalAt: estimateArrival(bridgeEvent, resolved, cfg, destCfg),
        metadata: {
          sourceBlockNumber: resolved.sourceBlockNumber,
          destinationBlockNumber: resolved.destinationBlockNumber,
          sourceConfirmations: resolved.sourceConfirmations,
          destinationConfirmations: resolved.destinationConfirmations,
          sourceStatus: resolved.sourceStatus,
          destinationStatus: resolved.destinationStatus,
          destinationTxHash: resolved.destinationTxHash,
        },
      },
      create: {
        transactionHash: bridgeEvent.transactionHash,
        sourceChain: bridgeEvent.sourceChain,
        destinationChain: bridgeEvent.destinationChain,
        asset: bridgeEvent.asset,
        amount: bridgeEvent.amount,
        sender: bridgeEvent.sender,
        recipient: bridgeEvent.recipient,
        protocol: bridgeEvent.protocol,
        status,
        confirmations: resolved.sourceConfirmations,
        requiredConfirmations: cfg.confirmationBlocks,
        bridgeFee: bridgeEvent.fee || '0',
        sourceTxUrl: sourceUrl ? `${sourceUrl}${bridgeEvent.transactionHash}` : undefined,
        estimatedArrivalAt: estimateArrival(bridgeEvent, resolved, cfg, destCfg),
        metadata: {
          sourceBlockNumber: resolved.sourceBlockNumber,
          destinationBlockNumber: resolved.destinationBlockNumber,
          sourceConfirmations: resolved.sourceConfirmations,
          destinationConfirmations: resolved.destinationConfirmations,
          sourceStatus: resolved.sourceStatus,
          destinationStatus: resolved.destinationStatus,
          destinationTxHash: resolved.destinationTxHash,
        },
      },
    });
  } catch (err) {
    logger.error('Failed to store bridge transaction', {
      txHash: bridgeEvent.transactionHash,
      error: String(err),
    });
  }
}

function estimateArrival(
  event: BridgeEvent,
  resolved: ResolvedTransaction,
  sourceCfg: ChainProviderConfig,
  destCfg: ChainProviderConfig,
): Date | null {
  if (resolved.destinationStatus === 'completed') return new Date();

  const remainingSourceConfirmations = Math.max(
    0,
    sourceCfg.confirmationBlocks - resolved.sourceConfirmations,
  );
  const sourceTimeLeft = remainingSourceConfirmations * sourceCfg.blockTimeSeconds;

  // Bridge processing time (average ~30 seconds for message relay)
  const bridgeRelayTime = 30;

  // Destination confirmation time (1 block)
  const destTime = destCfg.blockTimeSeconds;

  const totalSeconds = sourceTimeLeft + bridgeRelayTime + destTime;
  return new Date(Date.now() + totalSeconds * 1000);
}

export async function pollAndResolvePending(limit = 50): Promise<number> {
  const pending = await prisma.bridgeTransaction.findMany({
    where: {
      status: { in: ['pending', 'detected', 'bridging'] },
    },
    orderBy: { createdAt: 'asc' },
    take: limit,
  });

  let resolved = 0;
  for (const tx of pending) {
    try {
      const event: BridgeEvent = {
        transactionHash: tx.transactionHash,
        sourceChain: tx.sourceChain as Chain,
        destinationChain: tx.destinationChain as Chain,
        asset: tx.asset,
        amount: tx.amount.toString(),
        sender: tx.sender,
        recipient: tx.recipient,
        protocol: tx.protocol as BridgeProtocol,
        blockNumber: 0,
      };

      const result = await resolveBridgeTransaction(event);
      await storeBridgeTransaction(event, result);
      resolved++;
    } catch (err) {
      logger.error('Bridge poll resolution failed', {
        txHash: tx.transactionHash,
        error: String(err),
      });
    }
  }

  if (resolved > 0) {
    logger.info(`Bridge resolver: resolved ${resolved}/${pending.length} pending transactions`);
  }

  return resolved;
}

export { ResolvedTransaction };
