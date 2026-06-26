import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock DB & RPC
// ---------------------------------------------------------------------------

vi.mock('../../src/db', () => {
  const mockPrisma = {
    indexerState: {
      upsert: vi.fn().mockResolvedValue({ lastLedger: 0 }),
    },
    ledger: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
      create: vi.fn(),
      deleteMany: vi.fn(),
      findMany: vi.fn(),
    },
    reorgEvent: {
      create: vi.fn(),
      findFirst: vi.fn(),
      deleteMany: vi.fn(),
    },
    ledgerGap: {
      create: vi.fn(),
      updateMany: vi.fn(),
      deleteMany: vi.fn(),
      findFirst: vi.fn(),
    },
    sessionAuthorization: {
      deleteMany: vi.fn(),
    },
    event: {
      deleteMany: vi.fn(),
      upsert: vi.fn(),
    },
    transaction: {
      deleteMany: vi.fn(),
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
    wasmUpgradeHistory: {
      deleteMany: vi.fn(),
    },
    $transaction: vi.fn((arg) => {
      if (typeof arg === 'function') {
        return arg(mockPrisma);
      }
      return Promise.all(arg);
    }),
    $connect: vi.fn(),
    $disconnect: vi.fn(),
  };
  return {
    prismaRead: mockPrisma,
    prismaWrite: mockPrisma,
  };
});

vi.mock('../../src/indexer/rpc', () => ({
  fetchLedgerMetadata: vi.fn(),
  fetchEvents: vi.fn().mockResolvedValue([]),
  getTransaction: vi.fn(),
  getTransactionFromHorizon: vi.fn(),
  getLatestLedger: vi.fn(),
}));

import { prismaWrite as prisma } from '../../src/db';
import * as rpc from '../../src/indexer/rpc';
import {
  processLedgerRange,
  SorobanEventWorker,
} from '../../src/indexer/indexer';
import { adminRouter } from '../../src/api/admin';
import request from 'supertest';
import express from 'express';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Ledger Reorg & Consistency Verification', () => {
  it('triggers rollback and records ReorgEvent when hash mismatch occurs', async () => {
    const seq1 = 80001;
    const seq2 = 80002;
    const hash1 = 'hash-canonical-1';

    // 1. Mock DB returns L1
    vi.mocked(prisma.ledger.findUnique).mockResolvedValue({
      sequence: seq1,
      hash: hash1,
      previousLedgerHash: 'hash-0',
      closeTime: new Date(),
      txCount: 0,
      createdAt: new Date(),
    } as any);

    // 2. Mock fetchLedgerMetadata for seq2 returning mismatched previousLedgerHash
    vi.mocked(rpc.fetchLedgerMetadata).mockResolvedValue({
      sequence: seq2,
      hash: 'hash-fork-2',
      previousLedgerHash: 'hash-fork-1-mismatch', // Mismatch!
      closeTime: new Date(),
      txCount: 0,
    });

    // Mock upsert for last ledger state update
    vi.mocked(prisma.indexerState.upsert).mockResolvedValue({
      lastLedger: seq1 - 1,
    } as any);

    // 3. Running processLedgerRange(seq2, seq2) should detect reorg, rollback L1, and throw
    await expect(processLedgerRange(seq2, seq2)).rejects.toThrow(/Reorg detected/);

    // 4. Verify ReorgEvent was written
    expect(prisma.reorgEvent.create).toHaveBeenCalledWith({
      data: {
        ledgerSequence: seq2,
        expectedHash: hash1,
        actualHash: 'hash-fork-1-mismatch',
        previousHash: 'hash-0',
        rolledBackLedgers: [seq1],
      },
    });

    // 5. Verify rollback of L1 was triggered via transaction
    expect(prisma.ledger.deleteMany).toHaveBeenCalledWith({
      where: {
        sequence: { in: [seq1] },
      },
    });

    // 6. Verify indexer state was decremented
    expect(prisma.indexerState.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: { lastLedger: seq1 - 1 },
      }),
    );
  });

  it('detects ledger gaps, logs a warning, records LedgerGap and backfills them', async () => {
    const seq1 = 81001;
    const seq2 = 81002;
    const seq3 = 81003;

    // Reset ledger.findUnique to return null so no false reorg is detected
    vi.mocked(prisma.ledger.findUnique).mockResolvedValue(null);

    // Set last indexed ledger mock
    vi.mocked(prisma.indexerState.upsert)
      .mockResolvedValueOnce({ lastLedger: seq1 } as any) // first call in syncToLatest -> getLastIndexedLedger
      .mockResolvedValueOnce({ lastLedger: seq2 } as any) // after backfill processLedgerRange
      .mockResolvedValueOnce({ lastLedger: seq2 } as any) // check last in loop
      .mockResolvedValueOnce({ lastLedger: seq3 } as any); // after final end processLedgerRange

    // Mock fetchLedgerMetadata for seq2 and seq3
    vi.mocked(rpc.fetchLedgerMetadata).mockResolvedValue({
      sequence: seq2,
      hash: 'hash-seq-2',
      previousLedgerHash: 'hash-seq-1',
      closeTime: new Date(),
      txCount: 0,
    });

    // Trigger syncToLatest to seq3 (creating gap at seq2)
    const worker = new SorobanEventWorker();
    await worker.syncToLatest(seq3);

    // Verify LedgerGap was recorded
    expect(prisma.ledgerGap.create).toHaveBeenCalledWith({
      data: {
        startSequence: seq2,
        endSequence: seq2,
        resolved: false,
      },
    });

    // Verify LedgerGap was resolved
    expect(prisma.ledgerGap.updateMany).toHaveBeenCalledWith({
      where: {
        startSequence: seq2,
        endSequence: seq2,
        resolved: false,
      },
      data: { resolved: true },
    });
  });

  it('returns consistency report from consistency-check endpoint', async () => {
    // Mock DB ledgers with an inconsistency
    vi.mocked(prisma.ledger.findMany).mockResolvedValue([
      {
        sequence: 100,
        hash: 'hash-100',
        previousLedgerHash: 'hash-99-mismatch', // Mismatch!
        closeTime: new Date(),
        txCount: 0,
        createdAt: new Date(),
      },
      {
        sequence: 99,
        hash: 'hash-99-original',
        previousLedgerHash: 'hash-98',
        closeTime: new Date(),
        txCount: 0,
        createdAt: new Date(),
      },
    ] as any);

    const app = express();
    app.use(express.json());
    app.use('/api/v1/admin', adminRouter);

    const res = await request(app).post('/api/v1/admin/consistency-check').send({ limit: 5 });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(false);
    expect(res.body.scannedCount).toBe(2);
    expect(res.body.inconsistenciesCount).toBe(1);
    expect(res.body.inconsistencies[0].sequence).toBe(100);
    expect(res.body.inconsistencies[0].expectedPreviousHash).toBe('hash-99-original');
    expect(res.body.inconsistencies[0].actualPreviousHash).toBe('hash-99-mismatch');
  });
});
