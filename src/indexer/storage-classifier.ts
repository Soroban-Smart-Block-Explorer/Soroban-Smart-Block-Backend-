import { xdr, SorobanDataBuilder } from '@stellar/stellar-sdk';
import { SorobanRpc } from '@stellar/stellar-sdk';

// ── Types ────────────────────────────────────────────────────────────────────

export type StorageType = 'INSTANCE' | 'PERSISTENT' | 'TEMPORARY';

export interface StorageEntry {
  key: string; // hex-encoded ledger key
  storageType: StorageType;
  isReadOnly: boolean;
}

export interface StorageClassification {
  instance: StorageEntry[];
  persistent: StorageEntry[];
  temporary: StorageEntry[];
  summary: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function ledgerKeyToHex(key: xdr.LedgerKey): string {
  try {
    return key.toXDR('hex');
  } catch {
    return 'unknown';
  }
}

/**
 * Map an XDR LedgerKey to its Soroban storage durability type.
 *
 * Soroban contract data entries carry a `durability` field:
 *   - contractDataDurabilityPersistent  → PERSISTENT
 *   - contractDataDurabilityTemporary   → TEMPORARY
 *
 * ContractCode and ContractInstance entries are always INSTANCE-level
 * (they live as long as the contract exists).
 */
function classifyLedgerKey(key: xdr.LedgerKey): StorageType {
  const switchName = key.switch().name;

  if (switchName === 'contractCode') return 'INSTANCE';
  if (switchName === 'contractData') {
    const durabilityName = key.contractData().durability().name as string;
    if (durabilityName === 'contractDataDurabilityTemporary') return 'TEMPORARY';
    return 'PERSISTENT';
  }
  return 'PERSISTENT';
}

// ── Main classifier ──────────────────────────────────────────────────────────

/**
 * Classify all ledger entries in a transaction footprint by storage durability.
 *
 * Accepts either:
 *   - A successful SimulateTransactionResponse (pre-simulation)
 *   - A raw SorobanDataBuilder (already extracted)
 */
export function classifyStorageEntries(
  source: SorobanRpc.Api.SimulateTransactionSuccessResponse | SorobanDataBuilder,
): StorageClassification {
  const builder =
    source instanceof SorobanDataBuilder ? source : (source.transactionData as SorobanDataBuilder);

  const readOnlyKeys: xdr.LedgerKey[] = builder.getReadOnly();
  const readWriteKeys: xdr.LedgerKey[] = builder.getReadWrite();

  const entries: StorageEntry[] = [
    ...readOnlyKeys.map((k) => ({
      key: ledgerKeyToHex(k),
      storageType: classifyLedgerKey(k),
      isReadOnly: true,
    })),
    ...readWriteKeys.map((k) => ({
      key: ledgerKeyToHex(k),
      storageType: classifyLedgerKey(k),
      isReadOnly: false,
    })),
  ];

  const instance = entries.filter((e) => e.storageType === 'INSTANCE');
  const persistent = entries.filter((e) => e.storageType === 'PERSISTENT');
  const temporary = entries.filter((e) => e.storageType === 'TEMPORARY');

  const parts: string[] = [];
  if (instance.length) parts.push(`${instance.length} instance`);
  if (persistent.length) parts.push(`${persistent.length} persistent`);
  if (temporary.length) parts.push(`${temporary.length} temporary`);
  const summary = parts.length
    ? `Footprint: ${parts.join(', ')} storage entr${entries.length === 1 ? 'y' : 'ies'}`
    : 'No storage entries in footprint';

  return { instance, persistent, temporary, summary };
}

/**
 * Parse a raw SorobanTransactionData XDR string and classify its entries.
 */
export function classifyStorageFromXdr(sorobanDataXdr: string): StorageClassification {
  const txData = xdr.SorobanTransactionData.fromXDR(sorobanDataXdr, 'base64');
  const builder = new SorobanDataBuilder(txData.toXDR('base64'));
  return classifyStorageEntries(builder);
}
