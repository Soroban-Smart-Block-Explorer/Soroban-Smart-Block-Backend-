/**
 * Micro-Block Time Sync Polling Handler (#192)
 *
 * Polls the RPC node every MICRO_BLOCK_POLL_INTERVAL_MS (default 2500 ms) to
 * match Stellar's ~2.5-second block close times. On each new ledger it fetches
 * events and broadcasts them to all connected SSE and WebSocket clients with
 * minimal overhead.
 */

import { config } from '../config';
import { getLatestLedger, fetchEvents } from './rpc';
import { broadcastSSEEvent } from '../api/sse';
import { broadcastEvent } from '../ws/eventBroadcaster';

let lastBroadcastLedger = 0;
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let running = false;

async function poll(): Promise<void> {
  try {
    const latest = await getLatestLedger();
    if (latest <= lastBroadcastLedger) return;

    const from = lastBroadcastLedger > 0 ? lastBroadcastLedger + 1 : latest;
    const events = await fetchEvents(from, latest);

    for (const ev of events) {
      const payload = {
        id: `${ev.transactionHash}-${ev.topics[0] ?? '0'}`,
        contractAddress: ev.contractId,
        eventType: 'raw',
        decoded: { topics: ev.topics, data: ev.data },
        ledger: ev.ledgerSequence,
        ledgerCloseTime: ev.ledgerCloseTime,
        transactionHash: ev.transactionHash,
      };
      broadcastSSEEvent(payload);
      broadcastEvent(payload);
    }

    lastBroadcastLedger = latest;
  } catch (err) {
    // Non-fatal: log and continue polling
    console.error('[microBlockPoller] poll error:', (err as Error).message ?? err);
  }
}

function schedule(): void {
  if (!running) return;
  pollTimer = setTimeout(async () => {
    await poll();
    schedule();
  }, config.microBlockPollIntervalMs);
}

/**
 * Start the micro-block polling loop.
 * Safe to call multiple times — subsequent calls are no-ops.
 */
export function startMicroBlockPoller(): void {
  if (!config.microBlockSyncEnabled) {
    console.log('[microBlockPoller] disabled (MICRO_BLOCK_SYNC_ENABLED=false)');
    return;
  }
  if (running) return;
  running = true;
  console.log(`[microBlockPoller] started (interval=${config.microBlockPollIntervalMs}ms)`);
  schedule();
}

/**
 * Stop the polling loop (useful for graceful shutdown / tests).
 */
export function stopMicroBlockPoller(): void {
  running = false;
  if (pollTimer !== null) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}
