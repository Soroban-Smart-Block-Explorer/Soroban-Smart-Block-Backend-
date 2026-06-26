import { describe, it, expect, vi, beforeEach } from 'vitest';

// Use inline factory — vi.mock is hoisted so external variables are not yet initialised
vi.mock('../../src/db', () => {
  const mockFindFirst = vi.fn();
  const mockCreate = vi.fn();
  const mockUpdate = vi.fn();
  const mockFindMany = vi.fn();
  const mockDelete = vi.fn();

  return {
    prismaWrite: {
      failedItem: {
        findFirst: mockFindFirst,
        create: mockCreate,
        update: mockUpdate,
        findMany: mockFindMany,
        delete: mockDelete,
      },
    },
  };
});

import { enqueueFailure, retryFailures } from '../../src/indexer/errorQueue';
import { prismaWrite } from '../../src/db';

// Typed helpers to access the mocked methods
const db = prismaWrite.failedItem as {
  findFirst: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  findMany: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('enqueueFailure', () => {
  it('creates a new record when item does not exist', async () => {
    db.findFirst.mockResolvedValue(null);
    db.create.mockResolvedValue({});

    await enqueueFailure({
      itemType: 'transaction',
      itemId: 'tx-abc',
      ledger: 100,
      rawXdr: 'AAAA==',
      error: new Error('decode failed'),
    });

    expect(db.create).toHaveBeenCalledOnce();
    const data = db.create.mock.calls[0][0].data;
    expect(data.itemType).toBe('transaction');
    expect(data.itemId).toBe('tx-abc');
    expect(data.ledger).toBe(100);
    expect(data.retryCount).toBe(0);
    expect(data.dead).toBe(false);
  });

  it('increments retryCount on an existing item', async () => {
    db.findFirst.mockResolvedValue({ id: 1, retryCount: 1 });
    db.update.mockResolvedValue({});

    await enqueueFailure({
      itemType: 'event',
      itemId: 'ev-xyz',
      ledger: 200,
      error: 'bad format',
    });

    expect(db.update).toHaveBeenCalledOnce();
    const data = db.update.mock.calls[0][0].data;
    expect(data.retryCount).toBe(2);
    expect(data.dead).toBe(false);
  });

  it('marks item as dead when retryCount reaches MAX_RETRIES (3)', async () => {
    db.findFirst.mockResolvedValue({ id: 2, retryCount: 2 });
    db.update.mockResolvedValue({});

    await enqueueFailure({
      itemType: 'transaction',
      itemId: 'tx-dead',
      ledger: 300,
      error: new Error('persistent failure'),
    });

    const data = db.update.mock.calls[0][0].data;
    expect(data.retryCount).toBe(3);
    expect(data.dead).toBe(true);
  });

  it('converts non-Error errors to Error objects', async () => {
    db.findFirst.mockResolvedValue(null);
    db.create.mockResolvedValue({});

    await enqueueFailure({ itemType: 'event', itemId: 'ev-1', ledger: 1, error: 'string error' });

    const data = db.create.mock.calls[0][0].data;
    expect(data.errorMsg).toBe('string error');
  });
});

describe('retryFailures', () => {
  it('calls handler for each pending item and deletes on success', async () => {
    const pending = [
      { id: 10, itemType: 'transaction', itemId: 'tx-1', ledger: 1, rawXdr: null, context: null },
    ];
    db.findMany.mockResolvedValue(pending);
    db.delete.mockResolvedValue({});

    const handler = vi.fn().mockResolvedValue(undefined);
    await retryFailures(handler);

    expect(handler).toHaveBeenCalledOnce();
    expect(db.delete).toHaveBeenCalledWith({ where: { id: 10 } });
  });

  it('re-enqueues items that fail during retry', async () => {
    const pending = [
      { id: 11, itemType: 'event', itemId: 'ev-2', ledger: 5, rawXdr: 'XDR==', context: null },
    ];
    db.findMany.mockResolvedValue(pending);
    db.findFirst.mockResolvedValue(null);
    db.create.mockResolvedValue({});

    const handler = vi.fn().mockRejectedValue(new Error('still broken'));
    await retryFailures(handler);

    expect(db.delete).not.toHaveBeenCalled();
    expect(db.create).toHaveBeenCalledOnce();
  });

  it('does nothing when there are no pending items', async () => {
    db.findMany.mockResolvedValue([]);
    const handler = vi.fn();
    await retryFailures(handler);
    expect(handler).not.toHaveBeenCalled();
  });
});
