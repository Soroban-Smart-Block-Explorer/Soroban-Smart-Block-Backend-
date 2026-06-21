/**
 * CAP-0077 — Consensus Asset-Freeze Transaction Interceptor
 *
 * When validators vote to quarantine a compromised ledger key, this scanner:
 *  1. Maintains a registry of frozen ledger keys (FrozenLedgerKey table).
 *  2. Inspects each transaction's read/write footprint for frozen keys.
 *  3. Flags matching transactions with freezeViolation=true and logs a
 *     FreezeViolation record so the block explorer can display:
 *     "Transaction Rejected: Operation touches a consensus-frozen ledger key."
 */
import { xdr } from '@stellar/stellar-sdk';
import { prismaWrite as prisma } from '../db';

// ── In-memory cache of active frozen keys ────────────────────────────────────

let frozenKeyCache: Set<string> = new Set();
let cacheLoadedAt = 0;
const CACHE_TTL_MS = 60_000; // refresh every 60 s

async function loadFrozenKeys(): Promise<Set<string>> {
  const now = Date.now();
  if (frozenKeyCache.size > 0 && now - cacheLoadedAt < CACHE_TTL_MS) {
    return frozenKeyCache;
  }
  const rows = await prisma.frozenLedgerKey.findMany({
    where: { active: true },
    select: { ledgerKey: true },
  });
  frozenKeyCache = new Set(rows.map((r) => r.ledgerKey));
  cacheLoadedAt = now;
  return frozenKeyCache;
}

/** Invalidate the in-memory cache (call after registering a new frozen key). */
export function invalidateFreezeCache(): void {
  cacheLoadedAt = 0;
}

// ── Footprint extraction ─────────────────────────────────────────────────────

/**
 * Extract all ledger keys (read-only + read-write) from a transaction envelope
 * XDR as base64 strings. Returns an empty array if the XDR cannot be parsed
 * or the transaction has no Soroban footprint.
 */
export function extractFootprintKeys(envelopeXdrBase64: string): string[] {
  try {
    const envelope = xdr.TransactionEnvelope.fromXDR(envelopeXdrBase64, 'base64');
    const tx = envelope.switch().name === 'envelopeTypeTx' ? envelope.v1().tx() : null;
    if (!tx) return [];

    const ops = tx.operations();
    const keys: string[] = [];

    for (const op of ops) {
      const body = op.body();
      if (body.switch().name !== 'invokeHostFunction') continue;

      const ext = tx.ext();
      if ((ext.switch() as unknown as number) !== 1) continue; // no SorobanTransactionData

      const sorobanData = ext.sorobanData();
      const footprint = sorobanData.resources().footprint();

      for (const key of [...footprint.readOnly(), ...footprint.readWrite()]) {
        keys.push(key.toXDR('base64'));
      }
    }
    return keys;
  } catch {
    return [];
  }
}

// ── Core scanner ─────────────────────────────────────────────────────────────

export interface FreezeScanResult {
  frozen: boolean;
  matchedKeys: string[];
}

/**
 * Scan a transaction's footprint against the active frozen-key registry.
 * Returns which (if any) frozen keys the transaction touches.
 */
export async function scanForFrozenKeys(envelopeXdrBase64: string): Promise<FreezeScanResult> {
  const footprintKeys = extractFootprintKeys(envelopeXdrBase64);
  if (footprintKeys.length === 0) return { frozen: false, matchedKeys: [] };

  const frozen = await loadFrozenKeys();
  const matchedKeys = footprintKeys.filter((k) => frozen.has(k));
  return { frozen: matchedKeys.length > 0, matchedKeys };
}

// ── Violation persistence ────────────────────────────────────────────────────

/**
 * Persist a freeze violation and mark the transaction record.
 * Safe to call multiple times — upserts on transactionHash.
 */
export async function recordFreezeViolation(
  transactionHash: string,
  contractAddress: string | null,
  ledgerSequence: number,
  ledgerCloseTime: Date,
  frozenKeys: string[],
): Promise<void> {
  const numKeys = frozenKeys.length;
  const severity = numKeys > 10 ? 'critical' : numKeys > 5 ? 'high' : numKeys > 2 ? 'medium' : 'low';

  await Promise.all([
    prisma.freezeViolation.upsert({
      where: { transactionHash },
      update: { frozenKeys, severity },
      create: {
        transactionHash,
        contractAddress,
        ledgerSequence,
        ledgerCloseTime,
        frozenKeys,
        severity,
        resolution: 'pending',
      },
    }),
    prisma.transaction.updateMany({
      where: { hash: transactionHash },
      data: { freezeViolation: true },
    }),
  ]);

  if (severity === 'critical') {
    const webhookUrl = process.env.FREEZE_ALERT_WEBHOOK_URL;
    if (webhookUrl) {
      fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          alert: 'CRITICAL_FREEZE_VIOLATION',
          transactionHash,
          contractAddress,
          frozenKeys,
          ledgerSequence,
        })
      }).catch(err => console.error('[freeze-scanner] Failed to send alert webhook', err));
    } else {
      console.warn(`[freeze-scanner] CRITICAL VIOLATION DETECTED for tx ${transactionHash}`);
    }
  }
}

// ── Frozen key registry management ──────────────────────────────────────────

/**
 * Register a new consensus-frozen ledger key.
 * Extracts the contract address from the key XDR when possible.
 */
export async function registerFrozenKey(
  ledgerKey: string,
  frozenAtLedger: number,
  frozenAtTime: Date,
  reason?: string,
): Promise<void> {
  const contractAddress = extractContractAddressFromKey(ledgerKey);
  await prisma.frozenLedgerKey.upsert({
    where: { ledgerKey },
    update: { active: true, reason: reason ?? null },
    create: { ledgerKey, contractAddress, frozenAtLedger, frozenAtTime, reason: reason ?? null },
  });
  invalidateFreezeCache();
  console.log(
    `[freeze-scanner] Registered frozen key for contract ${contractAddress ?? 'unknown'} at ledger ${frozenAtLedger}`,
  );
}

/**
 * Lift (thaw) a previously frozen ledger key.
 */
export async function thawFrozenKey(ledgerKey: string): Promise<void> {
  await prisma.frozenLedgerKey.updateMany({
    where: { ledgerKey },
    data: { active: false },
  });
  invalidateFreezeCache();
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function extractContractAddressFromKey(ledgerKeyBase64: string): string | null {
  try {
    const key = xdr.LedgerKey.fromXDR(ledgerKeyBase64, 'base64');
    const switchName = key.switch().name;
    if (switchName === 'contractData') {
      return key.contractData().contract().contractId().toString('hex');
    }
    if (switchName === 'contractCode') {
      return key.contractCode().hash().toString('hex');
    }
    return null;
  } catch {
    return null;
  }
}
