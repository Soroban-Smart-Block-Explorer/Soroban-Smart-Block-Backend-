/**
 * #912 — Indexer error-queue retries and poison (dead-lettered) items must be
 * visible in /metrics: indexer_error_queue_depth gauges, an
 * indexer_error_retries_total counter, and an indexer_error_dlq_total counter
 * labelled with a bounded reason derived via failure-parser.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db', () => {
  const mockFindFirst = vi.fn();
  const mockCreate = vi.fn();
  const mockUpdate = vi.fn();
  const mockFindMany = vi.fn();
  const mockDelete = vi.fn();
  const mockCount = vi.fn();
  const mockDeadCreate = vi.fn();
  const mockDeadCount = vi.fn();

  return {
    prismaWrite: {
      failedItem: {
        findFirst: mockFindFirst,
        create: mockCreate,
        update: mockUpdate,
        findMany: mockFindMany,
        delete: mockDelete,
        count: mockCount,
      },
      deadLetterItem: {
        create: mockDeadCreate,
        count: mockDeadCount,
      },
    },
  };
});

import {
  enqueueFailure,
  retryFailures,
  getQueueBackpressureStatus,
  classifyFailureReason,
} from '../../src/indexer/errorQueue';
import { prismaWrite } from '../../src/db';
import { registry } from '../../src/metrics';

const db = prismaWrite.failedItem as unknown as {
  findFirst: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  findMany: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  count: ReturnType<typeof vi.fn>;
};

const deadDb = prismaWrite.deadLetterItem as unknown as {
  create: ReturnType<typeof vi.fn>;
  count: ReturnType<typeof vi.fn>;
};

async function metricText(name: string): Promise<string> {
  return registry.getSingleMetricAsString(name);
}

beforeEach(() => {
  vi.clearAllMocks();
  registry.resetMetrics();
});

describe('error queue metrics (#912)', () => {
  it('increments retries counter when an existing item is re-enqueued', async () => {
    db.findFirst.mockResolvedValue({ id: 1, retryCount: 1 });
    db.update.mockResolvedValue({});

    await enqueueFailure({
      itemType: 'transaction',
      itemId: 'tx-abc',
      ledger: 100,
      error: new Error('decode failed'),
    });

    const out = await metricText('indexer_error_retries_total');
    expect(out).toContain('indexer_error_retries_total{type="transaction"} 1');
  });

  it('does not count the first failure as a retry', async () => {
    db.findFirst.mockResolvedValue(null);
    db.create.mockResolvedValue({});

    await enqueueFailure({
      itemType: 'event',
      itemId: 'ev-new',
      ledger: 200,
      error: new Error('bad format'),
    });

    const out = await metricText('indexer_error_retries_total');
    // HELP/TYPE headers exist, but no series was recorded for any item type.
    expect(out).not.toContain('{');
  });

  it('dead-letters poison items with a poison reason label', async () => {
    db.findFirst.mockResolvedValue(null);
    db.create.mockResolvedValue({});
    deadDb.create.mockResolvedValue({});

    await enqueueFailure({
      itemType: 'ledger',
      itemId: 'l-poison',
      ledger: 300,
      error: new Error('invalid xdr: cannot parse'),
    });

    const out = await metricText('indexer_error_dlq_total');
    expect(out).toContain('indexer_error_dlq_total{reason="poison"} 1');
  });

  it('dead-letters exhausted items with a retry_exhausted reason label', async () => {
    db.findFirst.mockResolvedValue({ id: 2, retryCount: 2 });
    db.update.mockResolvedValue({});
    deadDb.create.mockResolvedValue({});

    await enqueueFailure({
      itemType: 'transaction',
      itemId: 'tx-dead',
      ledger: 400,
      error: new Error('persistent failure'),
    });

    const out = await metricText('indexer_error_dlq_total');
    expect(out).toContain('indexer_error_dlq_total{reason="retry_exhausted"} 1');
  });

  it('updates queue depth gauges from backpressure reads', async () => {
    db.count.mockResolvedValue(42);
    deadDb.count.mockResolvedValue(7);

    const status = await getQueueBackpressureStatus();
    expect(status.pendingCount).toBe(42);
    expect(status.deadCount).toBe(7);

    const out = await metricText('indexer_error_queue_depth');
    expect(out).toContain('indexer_error_queue_depth{queue="pending"} 42');
    expect(out).toContain('indexer_error_queue_depth{queue="dead"} 7');
  });

  it('refreshes depth gauges at the end of a retryFailures cycle', async () => {
    db.findMany.mockResolvedValue([
      { id: 10, itemType: 'transaction', itemId: 'tx-1', ledger: 1, rawXdr: null, context: null },
    ]);
    db.delete.mockResolvedValue({});
    db.count.mockResolvedValue(0);
    deadDb.count.mockResolvedValue(0);

    const handler = vi.fn().mockResolvedValue(undefined);
    await retryFailures(handler);

    const out = await metricText('indexer_error_queue_depth');
    expect(out).toContain('indexer_error_queue_depth{queue="pending"} 0');
    expect(out).toContain('indexer_error_queue_depth{queue="dead"} 0');
  });

  it('classifies failure reasons into bounded buckets via failure-parser', () => {
    expect(classifyFailureReason(new Error('invalid xdr'))).toBe('poison');
    expect(classifyFailureReason(new Error('syntaxerror in payload'))).toBe('poison');
    expect(classifyFailureReason(new Error('request timed out after 30s'))).toBe('timeout');
    expect(classifyFailureReason(new Error('socket hang up'))).toBe('network');
    expect(classifyFailureReason(new Error('rate limit exceeded'))).toBe('rate_limit');
    expect(classifyFailureReason(new Error('unrelated issue'))).toBe('other');
  });
});
