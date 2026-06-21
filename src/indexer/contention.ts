import { prismaWrite as prisma } from '../db';

// Soroban charges ~0.4ms per write-lock contention slot (approximate)
const DELAY_PER_CONFLICT_MS = 0.4;

interface TxFootprint {
  hash: string;
  contractAddress: string | null;
  // readWrite keys from the transaction's resource footprint (ledger keys as strings)
  writeKeys: string[];
}

/**
 * Parse resource footprint from raw XDR metadata.
 * The footprint is embedded in the transaction result XDR as
 * sorobanData.resources.footprint.readWrite[].
 * We extract a stable string key per ledger entry.
 */
function extractWriteKeys(rawXdr: string, contractAddress: string | null): string[] {
  if (!rawXdr || !contractAddress) return [];
  try {
    // Attempt to find ledger key patterns in the base64 XDR.
    // A full XDR decode would require @stellar/stellar-sdk xdr parsing;
    // we use a heuristic: hash the XDR segments that contain the contract address
    // to produce stable per-key identifiers.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { xdr } = require('@stellar/stellar-sdk');
    const envelope = xdr.TransactionEnvelope.fromXDR(rawXdr, 'base64');
    const ops = envelope.v1?.tx?.operations() ?? envelope.v0?.tx?.operations() ?? [];
    const keys: string[] = [];
    for (const op of ops) {
      const body = op.body();
      const invokeOp = body?.invokeHostFunction?.();
      if (!invokeOp) continue;
      const sorobanData = invokeOp.auth?.() ?? [];
      // Extract footprint from the operation's soroban resource data
      const resources = (invokeOp as any).resources?.();
      const footprint = resources?.footprint?.();
      const rwKeys: any[] = footprint?.readWrite?.() ?? [];
      for (const key of rwKeys) {
        keys.push(key.toXDR('base64'));
      }
    }
    return keys;
  } catch {
    // Fallback: use contract address as a single synthetic key
    return contractAddress ? [`contract:${contractAddress}`] : [];
  }
}

/**
 * Detect write conflicts across transactions in a ledger.
 * Two transactions contend if they both write to the same ledger key.
 */
export async function detectContention(
  ledgerSequence: number,
  txs: Array<{ hash: string; contractAddress: string | null; rawXdr: string }>,
): Promise<void> {
  // Build footprint map: key → list of tx hashes that write to it
  const keyToTxs = new Map<string, { hashes: string[]; contract: string }>();

  for (const tx of txs) {
    const writeKeys = extractWriteKeys(tx.rawXdr, tx.contractAddress);
    for (const key of writeKeys) {
      if (!keyToTxs.has(key)) {
        keyToTxs.set(key, { hashes: [], contract: tx.contractAddress ?? '' });
      }
      keyToTxs.get(key)!.hashes.push(tx.hash);
    }
  }

  // Only keys touched by >1 transaction are contended
  const contended = [...keyToTxs.entries()].filter(([, v]) => v.hashes.length > 1);
  if (contended.length === 0) return;

  for (const [stateKey, { hashes, contract }] of contended) {
    const conflictCount = hashes.length;
    const delayMs = parseFloat((conflictCount * DELAY_PER_CONFLICT_MS).toFixed(2));
    const delayLabel = `Delayed ${delayMs}ms due to high traffic on pool state`;

    await prisma.stateContention.upsert({
      where: {
        // Use a composite unique via a synthetic id
        id: `${ledgerSequence}:${stateKey.slice(0, 64)}`,
      },
      update: { conflictCount, delayMs, delayLabel, txHashes: hashes },
      create: {
        id: `${ledgerSequence}:${stateKey.slice(0, 64)}`,
        ledgerSequence,
        contractAddress: contract,
        stateKey,
        txHashes: hashes,
        conflictCount,
        delayMs,
        delayLabel,
      },
    });
  }
}
