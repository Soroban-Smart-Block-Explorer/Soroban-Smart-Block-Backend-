import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  saveBlockSnapshot,
  loadBlockSnapshot,
  listSnapshots,
  deleteSnapshot,
  replaySnapshot,
  type BlockChunk,
} from '../src/indexer/blockSnapshot';

const TEST_DIR = path.join(os.tmpdir(), `block-snapshots-test-${process.pid}`);

const sampleChunk: BlockChunk = {
  ledger: 4521983,
  transactions: [
    { hash: 'abc123', rawXdr: 'AAAA==', contractId: 'CXXX', closeTime: 1700000000 },
  ],
  capturedAt: new Date().toISOString(),
};

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('saveBlockSnapshot', () => {
  it('creates the snapshot directory and file', () => {
    const filePath = saveBlockSnapshot(sampleChunk, TEST_DIR);
    expect(fs.existsSync(filePath)).toBe(true);
    expect(filePath).toContain(`${sampleChunk.ledger}.json`);
  });

  it('persists the chunk data correctly', () => {
    saveBlockSnapshot(sampleChunk, TEST_DIR);
    const raw = fs.readFileSync(path.join(TEST_DIR, `${sampleChunk.ledger}.json`), 'utf8');
    const parsed = JSON.parse(raw) as BlockChunk;
    expect(parsed.ledger).toBe(sampleChunk.ledger);
    expect(parsed.transactions).toHaveLength(1);
    expect(parsed.transactions[0].hash).toBe('abc123');
  });
});

describe('loadBlockSnapshot', () => {
  it('returns null when snapshot does not exist', () => {
    expect(loadBlockSnapshot(9999999, TEST_DIR)).toBeNull();
  });

  it('returns the saved chunk', () => {
    saveBlockSnapshot(sampleChunk, TEST_DIR);
    const loaded = loadBlockSnapshot(sampleChunk.ledger, TEST_DIR);
    expect(loaded).not.toBeNull();
    expect(loaded!.ledger).toBe(sampleChunk.ledger);
  });
});

describe('listSnapshots', () => {
  it('returns empty array when directory does not exist', () => {
    expect(listSnapshots(TEST_DIR)).toEqual([]);
  });

  it('returns sorted ledger numbers', () => {
    saveBlockSnapshot({ ...sampleChunk, ledger: 300 }, TEST_DIR);
    saveBlockSnapshot({ ...sampleChunk, ledger: 100 }, TEST_DIR);
    saveBlockSnapshot({ ...sampleChunk, ledger: 200 }, TEST_DIR);
    expect(listSnapshots(TEST_DIR)).toEqual([100, 200, 300]);
  });
});

describe('deleteSnapshot', () => {
  it('returns false when snapshot does not exist', () => {
    expect(deleteSnapshot(9999999, TEST_DIR)).toBe(false);
  });

  it('deletes the file and returns true', () => {
    saveBlockSnapshot(sampleChunk, TEST_DIR);
    expect(deleteSnapshot(sampleChunk.ledger, TEST_DIR)).toBe(true);
    expect(loadBlockSnapshot(sampleChunk.ledger, TEST_DIR)).toBeNull();
  });
});

describe('replaySnapshot', () => {
  it('throws when snapshot does not exist', () => {
    expect(() => replaySnapshot(9999999, (c) => c, TEST_DIR)).toThrow('No snapshot found');
  });

  it('passes the chunk to the parser and returns its result', () => {
    saveBlockSnapshot(sampleChunk, TEST_DIR);
    const txCount = replaySnapshot(sampleChunk.ledger, (c) => c.transactions.length, TEST_DIR);
    expect(txCount).toBe(1);
  });

  it('does not modify the snapshot file during replay', () => {
    saveBlockSnapshot(sampleChunk, TEST_DIR);
    replaySnapshot(sampleChunk.ledger, (c) => c, TEST_DIR);
    const loaded = loadBlockSnapshot(sampleChunk.ledger, TEST_DIR);
    expect(loaded!.ledger).toBe(sampleChunk.ledger);
  });
});
