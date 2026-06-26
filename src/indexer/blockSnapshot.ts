import * as fs from 'fs';
import * as path from 'path';

export interface BlockChunk {
  ledger: number;
  transactions: Array<{
    hash: string;
    rawXdr: string;
    contractId: string;
    closeTime: number;
  }>;
  capturedAt: string;
}

const DEFAULT_SNAPSHOT_DIR = path.join(process.cwd(), '.block-snapshots');

/**
 * Save a raw block chunk to disk for local simulated parsing.
 * Files are stored as JSON under `<snapshotDir>/<ledger>.json`.
 */
export function saveBlockSnapshot(chunk: BlockChunk, snapshotDir = DEFAULT_SNAPSHOT_DIR): string {
  fs.mkdirSync(snapshotDir, { recursive: true });
  const filePath = path.join(snapshotDir, `${chunk.ledger}.json`);
  fs.writeFileSync(filePath, JSON.stringify(chunk, null, 2), 'utf8');
  return filePath;
}

/**
 * Load a previously saved block chunk from disk.
 * Returns null if the snapshot does not exist.
 */
export function loadBlockSnapshot(
  ledger: number,
  snapshotDir = DEFAULT_SNAPSHOT_DIR,
): BlockChunk | null {
  const filePath = path.join(snapshotDir, `${ledger}.json`);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as BlockChunk;
}

/**
 * List all saved snapshot ledger numbers, sorted ascending.
 */
export function listSnapshots(snapshotDir = DEFAULT_SNAPSHOT_DIR): number[] {
  if (!fs.existsSync(snapshotDir)) return [];
  return fs
    .readdirSync(snapshotDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => parseInt(f.replace('.json', ''), 10))
    .filter((n) => !isNaN(n))
    .sort((a, b) => a - b);
}

/**
 * Delete a snapshot file. Returns true if deleted, false if it didn't exist.
 */
export function deleteSnapshot(ledger: number, snapshotDir = DEFAULT_SNAPSHOT_DIR): boolean {
  const filePath = path.join(snapshotDir, `${ledger}.json`);
  if (!fs.existsSync(filePath)) return false;
  fs.unlinkSync(filePath);
  return true;
}

/**
 * Run a simulated parse pass over a saved snapshot using the provided parser.
 * Returns the parser's output without touching the live network or database.
 */
export function replaySnapshot<T>(
  ledger: number,
  parser: (chunk: BlockChunk) => T,
  snapshotDir = DEFAULT_SNAPSHOT_DIR,
): T {
  const chunk = loadBlockSnapshot(ledger, snapshotDir);
  if (!chunk) throw new Error(`No snapshot found for ledger ${ledger}`);
  return parser(chunk);
}
