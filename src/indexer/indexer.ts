import WebSocket from 'ws';
import { xdr } from '@stellar/stellar-sdk';
import { prismaRead, prismaWrite, prismaWrite as prisma } from '../db';
import { config } from '../config';
import {
  indexerPipelineStageDuration,
  indexerPipelineStageLag,
  indexerPipelineStageProcessedTotal,
} from '../metrics';
import {
  fetchEvents,
  getLatestLedger,
  getRpcWebsocketUrl,
  getTransaction,
  getTransactionFromHorizon,
  type LedgerEvent,
  fetchLedgerMetadata,
} from './rpc';
import { decodeTransaction, decodeEvent } from './decoder';
import { decodeZkpVerification, recordZkpVerification } from './zkp-verifier';
import { processAaTransaction } from './aa-indexer';
import { feedOrchestrator } from '../feed/orchestrator';
import { enqueueInitialAudit } from './audit-pipeline';
import { amIResponsibleFor, getRangeCursor, isP2pEnabled, setRangeCursor } from '../p2p';
import { logger } from '../logger';
import { uuidv7 } from '../utils/uuidv7';

const BATCH = config.indexerBatchSize;
const WORKERS = config.indexerCatchupWorkers;

// ---------------------------------------------------------------------------
// IndexerState helpers & High Availability (HA) Leader Election
// ---------------------------------------------------------------------------

const getActiveNetwork = (): string => process.env.STELLAR_NETWORK ?? 'mainnet';

export async function getLastIndexedLedger(network = getActiveNetwork()): Promise<number> {
  if (isP2pEnabled()) {
    return getLastIndexedLedgerP2p();
  }
  const state = await prisma.indexerState.findFirst({
    where: { network, id: 'singleton' },
  });
  if (!state) {
    const created = await prisma.indexerState.create({
      data: {
        id: 'singleton',
        network,
        lastLedger: config.indexerStartLedger,
        version: 0,
      },
    });
    return created.lastLedger;
  }
  return state.lastLedger;
}

async function getLastIndexedLedgerP2p(): Promise<number> {
  return getRangeCursor(config.indexerStartLedger);
}

export async function setLastIndexedLedger(
  ledger: number,
  network = getActiveNetwork(),
): Promise<void> {
  if (isP2pEnabled()) {
    await setRangeCursor(ledger, ledger);
    return;
  }

  // Optimistic concurrency CAS guard
  const existing = await prisma.indexerState.findFirst({
    where: { network, id: 'singleton' },
  });

  if (!existing) {
    await prisma.indexerState.create({
      data: {
        id: 'singleton',
        network,
        lastLedger: ledger,
        version: 1,
      },
    });
    return;
  }

  // Compare-and-swap update
  const updated = await prisma.indexerState.updateMany({
    where: {
      network,
      id: 'singleton',
      version: existing.version,
    },
    data: {
      lastLedger: ledger,
      version: existing.version + 1,
    },
  });

  if (updated.count === 0) {
    logger.warn(
      `[IndexerState] Optimistic concurrency lock conflict detected for network '${network}' when setting cursor to ${ledger}. Retrying update...`,
    );
    // Fallback upsert on conflict
    await prisma.indexerState.updateMany({
      where: { network, id: 'singleton' },
      data: { lastLedger: ledger, version: { increment: 1 } },
    });
  }
}

/**
 * Acquire leader lease for HA multi-instance deployments.
 */
export async function acquireLeaderLease(
  nodeId: string,
  network = getActiveNetwork(),
  ttlMs = 30000,
): Promise<boolean> {
  const now = new Date();
  const leaseExpiresAt = new Date(now.getTime() + ttlMs);

  // Read state
  const state = await prisma.indexerState.findFirst({
    where: { network, id: 'singleton' },
  });

  if (!state) {
    await prisma.indexerState.create({
      data: {
        id: 'singleton',
        network,
        lastLedger: config.indexerStartLedger,
        leaderId: nodeId,
        leaderLeaseExpiresAt: leaseExpiresAt,
        version: 1,
      },
    });
    return true;
  }

  // Check if current lease is expired or owned by nodeId
  const isExpired = !state.leaderLeaseExpiresAt || state.leaderLeaseExpiresAt < now;
  const isSelf = state.leaderId === nodeId;

  if (isExpired || isSelf) {
    const res = await prisma.indexerState.updateMany({
      where: {
        network,
        id: 'singleton',
        version: state.version,
      },
      data: {
        leaderId: nodeId,
        leaderLeaseExpiresAt: leaseExpiresAt,
        version: state.version + 1,
      },
    });
    return res.count > 0;
  }

  return false;
}

/** Release leader lease */
export async function releaseLeaderLease(
  nodeId: string,
  network = getActiveNetwork(),
): Promise<void> {
  await prisma.indexerState.updateMany({
    where: { network, id: 'singleton', leaderId: nodeId },
    data: { leaderId: null, leaderLeaseExpiresAt: null },
  });
}

export async function rollbackLedgers(sequences: number[]) {
  logger.info(`⚠️ Rollback triggered for ledgers: ${sequences.join(', ')}`);

  await prismaWrite.$transaction([
    // Delete SessionAuthorizations related to these ledgers
    prismaWrite.sessionAuthorization.deleteMany({
      where: {
        startLedger: { in: sequences },
      },
    }),

    // Delete Events for these ledgers
    prismaWrite.event.deleteMany({
      where: {
        ledgerSequence: { in: sequences },
      },
    }),

    // Delete Transactions for these ledgers
    prismaWrite.transaction.deleteMany({
      where: {
        ledgerSequence: { in: sequences },
      },
    }),

    // Delete WasmUpgradeHistory for these ledgers
    prismaWrite.wasmUpgradeHistory.deleteMany({
      where: {
        ledgerSequence: { in: sequences },
      },
    }),

    // Delete Ledgers themselves
    prismaWrite.ledger.deleteMany({
      where: {
        sequence: { in: sequences },
      },
    }),
  ]);
}

export async function processLedgerRange(
  start: number,
  end: number,
  opts: { force?: boolean } = {},
) {
  logger.info(`Indexing ledgers ${start} → ${end}`);

  // Stage lag metrics update
  try {
    const latestTip = await getLatestLedger().catch(() => end);
    const lag = Math.max(0, latestTip - end);
    indexerPipelineStageLag.set({ stage: 'fetch' }, lag);
    indexerPipelineStageLag.set({ stage: 'decode' }, lag);
    indexerPipelineStageLag.set({ stage: 'persist' }, lag);
    indexerPipelineStageLag.set({ stage: 'enrich' }, lag);
  } catch (err) {
    // Non-blocking metrics gauge catch
  }

  // Stage 1: FETCH metadata & Reorg check
  const stopFetchTimer = indexerPipelineStageDuration.startTimer({ stage: 'fetch' });

  for (let seq = start; seq <= end; seq++) {
    if (!opts.force && !(await amIResponsibleFor(seq))) {
      continue;
    }
    const ledgerMeta = await fetchLedgerMetadata(seq);

    // Deep Reorg Check & Extended Backtracking
    const prevSeq = seq - 1;
    const prevLedger = await prismaRead.ledger.findUnique({ where: { sequence: prevSeq } });

    if (prevLedger && prevLedger.hash !== ledgerMeta.previousLedgerHash) {
      logger.warn(
        `🚨 REORG DETECTED at ledger ${seq}! Local hash ${prevLedger.hash} vs network expected ${ledgerMeta.previousLedgerHash}`,
      );

      const maxDepth = config.indexerReorgProtectionDepth || 100;
      const rolledBackSequences: number[] = [prevSeq];
      let commonAncestorFound = false;
      let commonAncestorSeq = prevSeq - 1;

      // Backtrack up to maxDepth ledgers to locate common ancestor
      for (let depth = 1; depth < maxDepth; depth++) {
        const checkSeq = prevSeq - depth;
        if (checkSeq <= 0) break;

        const localCheckLedger = await prismaRead.ledger.findUnique({
          where: { sequence: checkSeq },
        });
        if (!localCheckLedger) break;

        let remoteCheckMeta = null;
        try {
          remoteCheckMeta = await fetchLedgerMetadata(checkSeq);
        } catch (e) {
          logger.error(
            `Failed to fetch remote metadata for deep reorg check at ledger ${checkSeq}`,
            e,
          );
          break;
        }

        if (localCheckLedger.hash === remoteCheckMeta.hash) {
          commonAncestorFound = true;
          commonAncestorSeq = checkSeq;
          logger.info(`Found common ancestor at ledger sequence ${checkSeq} (depth: ${depth})`);
          break;
        } else {
          rolledBackSequences.push(checkSeq);
        }
      }

      if (!commonAncestorFound) {
        logger.error(
          `🚨 DEEP REORG EXCEEDS SAFETY THRESHOLD (${maxDepth} ledgers). Performing safety rollback for ${rolledBackSequences.length} ledgers.`,
        );
      }

      // Record Reorg event and perform atomic single DB transaction rollback
      await prismaWrite.reorgEvent.create({
        data: {
          ledgerSequence: seq,
          expectedHash: prevLedger.hash,
          actualHash: ledgerMeta.previousLedgerHash,
          previousHash: prevLedger.previousLedgerHash ?? '',
          rolledBackLedgers: rolledBackSequences,
        },
      });

      await rollbackLedgers(rolledBackSequences);
      await setLastIndexedLedger(commonAncestorSeq);

      throw new Error(
        `Reorg detected at ledger ${seq}. Rolled back ${rolledBackSequences.length} ledgers (${rolledBackSequences.join(', ')}). Resuming from common ancestor ${commonAncestorSeq}.`,
      );
    }

    // Persist Ledger record
    const stopPersistLedgerTimer = indexerPipelineStageDuration.startTimer({ stage: 'persist' });
    await prismaWrite.ledger.upsert({
      where: { sequence: seq },
      update: {
        hash: ledgerMeta.hash,
        previousLedgerHash: ledgerMeta.previousLedgerHash,
        closeTime: ledgerMeta.closeTime,
        txCount: ledgerMeta.txCount,
      },
      create: {
        sequence: seq,
        hash: ledgerMeta.hash,
        previousLedgerHash: ledgerMeta.previousLedgerHash,
        closeTime: ledgerMeta.closeTime,
        txCount: ledgerMeta.txCount,
      },
    });
    stopPersistLedgerTimer();
    indexerPipelineStageProcessedTotal.inc({ stage: 'persist', status: 'success' });
  }

  // Complete Stage 1 (Fetch)
  stopFetchTimer();
  indexerPipelineStageProcessedTotal.inc({ stage: 'fetch', status: 'success' });

  // Stage 2 & 3: FETCH events & DECODE / PERSIST / ENRICH events and transactions
  const stopEventsFetchTimer = indexerPipelineStageDuration.startTimer({ stage: 'fetch' });
  const events = await fetchEvents(start, end);
  stopEventsFetchTimer();

  for (const event of events) {
    const stopPersistContractTimer = indexerPipelineStageDuration.startTimer({ stage: 'persist' });
    await prismaWrite.contract.upsert({
      where: { address: event.contractId },
      update: {},
      create: { address: event.contractId },
    });
    stopPersistContractTimer();

    // Enrich Stage: Queue initial audit
    const stopEnrichAuditTimer = indexerPipelineStageDuration.startTimer({ stage: 'enrich' });
    enqueueInitialAudit(event.contractId);
    stopEnrichAuditTimer();
    indexerPipelineStageProcessedTotal.inc({ stage: 'enrich', status: 'success' });

    const existingTx = await prisma.transaction.findUnique({
      where: { hash: event.transactionHash },
    });

    if (!existingTx) {
      // Decode Stage
      const stopDecodeTxTimer = indexerPipelineStageDuration.startTimer({ stage: 'decode' });
      const txResult = await getTransaction(event.transactionHash).catch(() =>
        getTransactionFromHorizon(event.transactionHash).catch(() => null),
      );
      const rawXdr = (txResult as any)?.envelopeXdr?.toXDR('base64') ?? '';
      const decoded = rawXdr
        ? await decodeTransaction(rawXdr)
        : {
            contractAddress: event.contractId,
            functionName: null,
            functionArgs: null,
            humanReadable: null,
          };
      stopDecodeTxTimer();
      indexerPipelineStageProcessedTotal.inc({ stage: 'decode', status: 'success' });

      // Persist Stage
      const stopPersistTxTimer = indexerPipelineStageDuration.startTimer({ stage: 'persist' });
      const transaction = await prismaWrite.transaction.upsert({
        where: { hash: event.transactionHash },
        update: {},
        create: {
          id: uuidv7(),
          hash: event.transactionHash,
          ledgerSequence: event.ledgerSequence,
          ledgerCloseTime: event.ledgerCloseTime,
          sourceAccount: (txResult as any)?.sourceAccount ?? 'unknown',
          contractAddress: decoded.contractAddress,
          functionName: decoded.functionName,
          functionArgs: (decoded.functionArgs as object) ?? undefined,
          rawXdr,
          status: (txResult as any)?.status === 'SUCCESS' ? 'success' : 'failed',
          humanReadable: decoded.humanReadable,
          feeCharged: String((txResult as any)?.feeCharged ?? ''),
        },
      });
      stopPersistTxTimer();
      indexerPipelineStageProcessedTotal.inc({ stage: 'persist', status: 'success' });

      // Enrich Stage: ZKP & AA & Feeds
      const stopEnrichTxTimer = indexerPipelineStageDuration.startTimer({ stage: 'enrich' });
      try {
        if (rawXdr && decoded.functionName && decoded.contractAddress) {
          const envelope = xdr.TransactionEnvelope.fromXDR(rawXdr, 'base64');
          const ops =
            envelope.switch().name === 'envelopeTypeTx'
              ? envelope.v1().tx().operations()
              : envelope.v0().tx().operations();
          const invokeOp = ops.find((op) => op.body().switch().name === 'invokeHostFunction');
          const scArgs = invokeOp
            ? invokeOp.body().invokeHostFunctionOp().hostFunction().invokeContract().args()
            : [];
          const zkpData = decodeZkpVerification(decoded.functionName, scArgs);
          if (zkpData) {
            await recordZkpVerification(
              transaction.hash,
              decoded.contractAddress,
              zkpData,
              transaction.ledgerSequence,
              transaction.ledgerCloseTime,
            );
          }
        }
      } catch (zkpErr) {
        logger.error('ZKP recording error:', zkpErr);
      }

      try {
        void processAaTransaction(
          transaction.hash,
          transaction.sourceAccount,
          rawXdr,
          transaction.ledgerSequence,
          transaction.ledgerCloseTime,
          transaction.feeCharged ?? undefined,
        );
      } catch (err) {
        logger.error('AA processing error:', err);
      }

      await feedOrchestrator
        .publishTransaction(transaction)
        .catch((err) => logger.error('publishTransaction error:', err));

      stopEnrichTxTimer();
      indexerPipelineStageProcessedTotal.inc({ stage: 'enrich', status: 'success' });
    }

    // Decode & Persist Event
    const stopDecodeEventTimer = indexerPipelineStageDuration.startTimer({ stage: 'decode' });
    const { eventType, decoded } = decodeEvent(event.topics, event.data);
    stopDecodeEventTimer();
    indexerPipelineStageProcessedTotal.inc({ stage: 'decode', status: 'success' });

    const positionKey = event.pagingToken || `${event.ledgerSequence}-${events.indexOf(event)}`;
    const eventId = `${event.transactionHash}-${positionKey}`;

    const stopPersistEventTimer = indexerPipelineStageDuration.startTimer({ stage: 'persist' });
    const savedEvent = await prismaWrite.event.upsert({
      where: { id: eventId },
      update: {},
      create: {
        id: eventId,
        transactionHash: event.transactionHash,
        contractAddress: event.contractId,
        eventType,
        topics: event.topics,
        data: { raw: event.data },
        decoded: decoded as object,
        ledgerSequence: event.ledgerSequence,
        ledgerCloseTime: event.ledgerCloseTime,
      },
    });
    stopPersistEventTimer();
    indexerPipelineStageProcessedTotal.inc({ stage: 'persist', status: 'success' });

    // Enrich Event: Feeds & Session Authorization
    const stopEnrichEventTimer = indexerPipelineStageDuration.startTimer({ stage: 'enrich' });
    await feedOrchestrator
      .publishEvent(savedEvent)
      .catch((err) => logger.error('publishEvent error:', err));

    await processSessionAuthorization(event, eventType, decoded, eventId);
    stopEnrichEventTimer();
    indexerPipelineStageProcessedTotal.inc({ stage: 'enrich', status: 'success' });
  }
}

/**
 * Indexes exactly one ledger regardless of range ownership — used as the
 * P2P "graceful degradation" on-the-fly indexing fallback (design doc §1.3)
 * when a query's range owners are all unreachable.
 */
export async function indexSingleLedger(ledgerSeq: number): Promise<void> {
  await processLedgerRange(ledgerSeq, ledgerSeq, { force: true });
}

// ---------------------------------------------------------------------------
// Parallel catch-up with per-batch checkpointing (issue #881)
// ---------------------------------------------------------------------------

/**
 * Split [from, to] into at most `n` equal-sized chunks.
 */
function chunkRange(from: number, to: number, n: number): Array<[number, number]> {
  const total = to - from + 1;
  const size = Math.ceil(total / n);
  const chunks: Array<[number, number]> = [];
  for (let start = from; start <= to; start += size) {
    chunks.push([start, Math.min(start + size - 1, to)]);
  }
  return chunks;
}

/**
 * Persist a CatchUpCheckpoint row for a worker's chunk.
 *
 * Uses upsert so a crash-then-restart path finds the existing row and reads
 * `lastCommittedLedger` to resume mid-batch instead of re-fetching from
 * `rangeStart`.
 */
async function upsertCheckpoint(
  rangeStart: number,
  rangeEnd: number,
  lastCommittedLedger: number | null,
  completed: boolean,
): Promise<void> {
  const db = prismaWrite as any;
  try {
    await db.catchUpCheckpoint.upsert({
      where: { rangeStart_rangeEnd: { rangeStart, rangeEnd } },
      create: {
        id: uuidv7(),
        rangeStart,
        rangeEnd,
        lastCommittedLedger,
        completed,
      },
      update: {
        lastCommittedLedger,
        completed,
      },
    });
  } catch (err) {
    // Best-effort: checkpoint failure must not abort the indexing work
    logger.warn(`[catch-up] checkpoint upsert failed for ${rangeStart}-${rangeEnd}: ${err}`);
  }
}

/**
 * Look up the resume cursor for a chunk from a persisted checkpoint.
 * Returns the last committed ledger + 1 (i.e. where to resume from), or
 * `rangeStart` if no checkpoint exists yet.
 */
async function getChunkResumeCursor(rangeStart: number, rangeEnd: number): Promise<number> {
  const db = prismaWrite as any;
  try {
    const row: { lastCommittedLedger: number | null; completed: boolean } | null =
      await db.catchUpCheckpoint.findUnique({
        where: { rangeStart_rangeEnd: { rangeStart, rangeEnd } },
        select: { lastCommittedLedger: true, completed: true },
      });
    if (!row) return rangeStart;
    if (row.completed) {
      logger.info(`[catch-up] chunk ${rangeStart}-${rangeEnd} already completed — skipping`);
      return rangeEnd + 1; // signals "nothing to do"
    }
    if (row.lastCommittedLedger !== null) {
      const resume = row.lastCommittedLedger + 1;
      if (resume <= rangeEnd) {
        logger.info(
          `[catch-up] resuming chunk ${rangeStart}-${rangeEnd} from ledger ${resume} ` +
            `(last committed: ${row.lastCommittedLedger})`,
        );
        return resume;
      }
    }
  } catch (err) {
    logger.warn(`[catch-up] checkpoint read failed for ${rangeStart}-${rangeEnd}: ${err}`);
  }
  return rangeStart;
}

/**
 * Process a single worker chunk [rangeStart, rangeEnd] with intra-chunk
 * checkpointing every BATCH ledgers.
 *
 * After each BATCH-ledger sub-range completes, the progress is persisted to
 * CatchUpCheckpoint.  On crash-restart `getChunkResumeCursor` picks up the
 * last committed position so at most BATCH ledgers are re-processed.
 */
async function processChunkWithCheckpointing(rangeStart: number, rangeEnd: number): Promise<void> {
  // Resume from last checkpoint rather than rangeStart
  const resumeFrom = await getChunkResumeCursor(rangeStart, rangeEnd);
  if (resumeFrom > rangeEnd) {
    // Chunk already completed in a previous run
    return;
  }

  // Write an initial "in-progress" checkpoint so a crash before the first
  // sub-batch flush is also detectable (lastCommittedLedger = null means
  // "started but nothing committed yet").
  await upsertCheckpoint(
    rangeStart,
    rangeEnd,
    resumeFrom > rangeStart ? resumeFrom - 1 : null,
    false,
  );

  // Process in BATCH-sized sub-ranges, persisting progress after each one
  for (let subStart = resumeFrom; subStart <= rangeEnd; subStart += BATCH) {
    const subEnd = Math.min(subStart + BATCH - 1, rangeEnd);
    await processLedgerRange(subStart, subEnd);
    // Flush checkpoint after each successful sub-batch
    await upsertCheckpoint(rangeStart, rangeEnd, subEnd, subEnd >= rangeEnd);
    logger.debug(
      `[catch-up] checkpoint flushed for chunk ${rangeStart}-${rangeEnd}: committed ${subEnd}`,
    );
  }
}

/**
 * Run parallel workers over [from, to], then advance IndexerState to `to`.
 * Workers process non-overlapping chunks concurrently, each with its own
 * intra-chunk checkpoint.  The global cursor write is serialised after all
 * workers succeed so a partial failure leaves the cursor unchanged and the
 * whole round retries safely (upserts are idempotent).
 *
 * On restart after a crash, each worker resumes from its last persisted
 * CatchUpCheckpoint rather than re-fetching from the chunk start.
 */
async function catchUp(from: number, to: number): Promise<void> {
  const chunks = chunkRange(from, to, WORKERS);
  logger.info(
    `[catch-up] ${chunks.length} worker(s) covering ledgers ${from}–${to} ` +
      `(chunk size ~${chunks[0][1] - chunks[0][0] + 1})`,
  );
  await Promise.all(chunks.map(([s, e]) => processChunkWithCheckpointing(s, e)));
  await setLastIndexedLedger(to);
  logger.info(`[catch-up] done — cursor advanced to ${to}`);
}

async function processSessionAuthorization(
  event: LedgerEvent,
  eventType: string,
  decoded: Record<string, unknown>,
  eventId: string,
) {
  const knownAuthEvents = new Set([
    'session_authorization',
    'authorize_session',
    'hot_signer_authorized',
    'ephemeral_key_auth',
    'authorization_window',
  ]);
  if (!knownAuthEvents.has(eventType)) {
    return;
  }

  const hotSigner = extractHotSigner(decoded, event.topics);
  const startLedger = extractStartLedger(decoded, event.ledgerSequence);
  const expiryLedger = extractExpiryLedger(decoded, startLedger);
  if (!hotSigner || expiryLedger === undefined || expiryLedger <= startLedger) {
    return;
  }

  const allocatedBlocks = Math.max(0, expiryLedger - startLedger);

  await prismaWrite.sessionAuthorization.upsert({
    where: { eventId },
    update: {
      hotSigner,
      authorizationType: eventType,
      startLedger,
      expiryLedger,
      allocatedBlocks,
      contractAddress: event.contractId,
    },
    create: {
      eventId,
      contractAddress: event.contractId,
      hotSigner,
      authorizationType: eventType,
      startLedger,
      expiryLedger,
      allocatedBlocks,
    },
  });
}

function extractHotSigner(decoded: Record<string, unknown>, topics: string[]) {
  if (decoded?.hotSigner) {
    return String(decoded.hotSigner);
  }
  if (decoded?.authorizedSigner) {
    return String(decoded.authorizedSigner);
  }
  if (decoded?.data && typeof decoded.data === 'object' && decoded.data !== null) {
    const candidate = getNumericOrStringField(decoded.data as Record<string, unknown>, [
      'hotSigner',
      'authorizedSigner',
      'signer',
      'address',
    ]);
    if (candidate) {
      return String(candidate);
    }
  }
  if (Array.isArray(decoded.topics) && decoded.topics[1] != null) {
    return String(decoded.topics[1]);
  }
  if (topics[1]) {
    return topics[1];
  }
  return undefined;
}

function extractStartLedger(decoded: Record<string, unknown>, defaultLedger: number) {
  const rawStart =
    decoded?.data && typeof decoded.data === 'object'
      ? getNumericOrStringField(decoded.data as Record<string, unknown>, [
          'startLedger',
          'start_block',
          'fromLedger',
        ])
      : undefined;
  const parsed = rawStart !== undefined ? Number(rawStart) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultLedger;
}

function extractExpiryLedger(decoded: Record<string, unknown>, startLedger: number) {
  const data = decoded?.data;
  const rawExpiry =
    typeof data === 'object' && data !== null
      ? getNumericOrStringField(data as Record<string, unknown>, [
          'expiryLedger',
          'expiresAtLedger',
          'expires_at_ledger',
          'expirationLedger',
          'validUntilLedger',
          'expiresAtBlock',
          'expiryBlock',
        ])
      : undefined;

  if (rawExpiry !== undefined) {
    const expiry = Number(rawExpiry);
    if (Number.isFinite(expiry) && expiry > 0) {
      return expiry;
    }
  }

  const duration =
    typeof data === 'object' && data !== null
      ? getNumericOrStringField(data as Record<string, unknown>, [
          'durationBlocks',
          'allocatedBlocks',
          'windowBlocks',
          'expiresInBlocks',
        ])
      : undefined;
  const parsedDuration = duration !== undefined ? Number(duration) : NaN;
  if (Number.isFinite(parsedDuration) && parsedDuration > 0) {
    return startLedger + parsedDuration;
  }

  return undefined;
}

function getNumericOrStringField(source: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined && value !== null) {
      return value;
    }
  }
  return undefined;
}
// ---------------------------------------------------------------------------
// Worker class (live tail + catch-up orchestration)
// ---------------------------------------------------------------------------

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

let currentWorker: SorobanEventWorker | null = null;

export async function runIndexer() {
  await startIndexerService();
}

export async function startIndexerService() {
  const worker = new SorobanEventWorker();
  currentWorker = worker;
  await worker.start();
}

export function stopIndexerService(): void {
  if (currentWorker) {
    currentWorker.stop();
    currentWorker = null;
  }
}

export class SorobanEventWorker {
  private websocket?: WebSocket;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private reconnectDelayMs = 1000;
  private isProcessing = false;
  private shouldStop = false;

  stop(): void {
    this.shouldStop = true;
    if (this.websocket) {
      this.websocket.close();
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  async start() {
    logger.info('🔍 Soroban event worker starting...');
    this.connectWebsocket();

    while (!this.shouldStop) {
      try {
        if (this.isProcessing) {
          await sleep(config.indexerPollIntervalMs);
          continue;
        }

        const latest = await getLatestLedger();
        await this.syncToLatest(latest);
      } catch (err) {
        logger.error('Indexer error:', err);
        await sleep(config.indexerPollIntervalMs);
      }
    }
  }

  private async syncToLatest(targetLedger: number) {
    if (this.isProcessing) return;
    this.isProcessing = true;
    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const last = await getLastIndexedLedger();
        if (last >= targetLedger) return;

        // --- GAP DETECTION & BACKFILL ---
        if (last < targetLedger - 1) {
          const gapStart = last + 1;
          const gapEnd = targetLedger - 1;
          logger.warn(
            `⚠️ Ledger gap detected: expected next ledger to be ${targetLedger}, but last indexed is ${last}. Gap range: ${gapStart} → ${gapEnd}`,
          );

          // Record LedgerGap in the database
          await prismaWrite.ledgerGap.create({
            data: {
              startSequence: gapStart,
              endSequence: gapEnd,
              resolved: false,
            },
          });

          // Attempt to backfill the gap
          try {
            logger.info(`🔄 Attempting to backfill gap ${gapStart} → ${gapEnd}...`);
            if (gapEnd - gapStart >= BATCH && WORKERS > 1) {
              await catchUp(gapStart, gapEnd);
            } else {
              await processLedgerRange(gapStart, gapEnd);
              await setLastIndexedLedger(gapEnd);
            }

            // Mark the gap as resolved
            await prismaWrite.ledgerGap.updateMany({
              where: {
                startSequence: gapStart,
                endSequence: gapEnd,
                resolved: false,
              },
              data: { resolved: true },
            });
            logger.info(
              `✅ Ledger gap ${gapStart} → ${gapEnd} successfully backfilled and resolved.`,
            );
          } catch (backfillErr) {
            logger.error(`❌ Failed to backfill ledger gap ${gapStart} → ${gapEnd}:`, backfillErr);
            throw backfillErr;
          }

          // Refresh last indexed ledger after backfill
          continue;
        }

        const gap = targetLedger - last;
        if (gap > BATCH && WORKERS > 1) {
          await catchUp(last + 1, targetLedger);
          return;
        }

        const end = Math.min(last + BATCH, targetLedger);
        await processLedgerRange(last + 1, end);
        await setLastIndexedLedger(end);
      }
    } finally {
      this.isProcessing = false;
    }
  }

  // -------------------------------------------------------------------------
  // WebSocket live-tail (triggers onLedgerClose for real-time updates)
  // -------------------------------------------------------------------------

  private connectWebsocket() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }

    const url = getRpcWebsocketUrl();
    logger.info(`Connecting Soroban RPC websocket to ${url}`);
    try {
      this.websocket = new WebSocket(url);
      this.websocket.on('open', () => this.handleWsOpen());
      this.websocket.on('message', (data) => this.handleWsMessage(data));
      this.websocket.on('close', (code, reason) => this.handleWsClose(code, reason.toString()));
      this.websocket.on('error', (error) => this.handleWsError(error));
    } catch (error) {
      logger.error('Failed to establish websocket connection:', error);
      this.scheduleReconnect();
    }
  }

  private handleWsOpen() {
    logger.info('Soroban RPC websocket connected');
    this.reconnectDelayMs = 1000;
    this.subscribeLedgerClose();
  }

  private subscribeLedgerClose() {
    if (!this.websocket || this.websocket.readyState !== WebSocket.OPEN) return;
    this.websocket.send(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'subscribe',
        params: { topic: 'ledger' },
        id: 1,
      }),
    );
  }

  private handleWsMessage(data: WebSocket.Data) {
    const payload = this.dataToString(data);
    if (!payload) return;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const message: any = JSON.parse(payload);
      const ledgerNumber = this.extractLedgerNumber(message);
      if (typeof ledgerNumber === 'number') {
        this.onLedgerClose(ledgerNumber).catch((err) =>
          logger.error('Ledger close handler failed:', err),
        );
      }
    } catch (error) {
      logger.warn('Failed to parse websocket event payload:', error);
    }
  }

  private extractLedgerNumber(message: any): number | undefined {
    const candidate =
      message?.params?.ledger?.sequence ??
      message?.params?.ledger_sequence ??
      message?.params?.sequence ??
      message?.result?.sequence ??
      message?.result?.ledger?.sequence ??
      message?.ledger;
    const ledger = Number(candidate);
    return Number.isFinite(ledger) && ledger > 0 ? ledger : undefined;
  }

  private async onLedgerClose(ledger: number) {
    if (this.isProcessing) return;
    logger.info(`Ledger close event received for ledger ${ledger}`);
    await this.syncToLatest(ledger);
  }

  private handleWsClose(code: number, reason: string) {
    logger.warn(`Soroban RPC websocket closed (${code}) ${reason}`);
    this.scheduleReconnect();
  }

  private handleWsError(error: Error) {
    logger.error('Soroban RPC websocket error:', error.message ?? error);
    this.websocket?.close();
  }

  private scheduleReconnect() {
    if (this.shouldStop) return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
    this.reconnectTimer = setTimeout(() => {
      this.connectWebsocket();
      this.reconnectTimer = undefined;
    }, this.reconnectDelayMs);
    this.reconnectDelayMs = Math.min(30000, this.reconnectDelayMs * 2);
  }

  private dataToString(raw: WebSocket.Data): string {
    if (typeof raw === 'string') return raw;
    if (raw instanceof Buffer) return raw.toString('utf8');
    if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString('utf8');
    if (Array.isArray(raw)) return Buffer.concat(raw).toString('utf8');
    return '';
  }
}
