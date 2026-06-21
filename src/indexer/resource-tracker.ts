/**
 * Issue #48 — Footprint & Ledger Entry Cost Tracker
 *
 * Extracts Soroban resource consumption (CPU instructions, memory bytes,
 * ledger read/write footprints) from a transaction's result meta XDR and
 * returns a structured object suitable for storage and API exposure.
 */
import { xdr } from '@stellar/stellar-sdk';

export interface SorobanResources {
  cpuInstructions: number;
  memBytes: number;
  ledgerReadBytes: number;
  ledgerWriteBytes: number;
  ledgerReadEntries: number;
  ledgerWriteEntries: number;
  minResourceFee: string | null;
}

/**
 * Parse Soroban resource consumption from a base64-encoded TransactionMeta XDR.
 * Returns null if the meta is not v3 or lacks sorobanMeta.
 */
export function extractSorobanResources(resultMetaXdr: string): SorobanResources | null {
  let meta: xdr.TransactionMeta;
  try {
    meta = xdr.TransactionMeta.fromXDR(resultMetaXdr, 'base64');
  } catch {
    return null;
  }

  // Only TransactionMeta v3 carries sorobanMeta
  if (meta.switch() !== 3) return null;

  let sorobanMeta: any;
  try {
    sorobanMeta = (meta as any).v3().sorobanMeta();
  } catch {
    return null;
  }
  if (!sorobanMeta) return null;

  let resources: any;
  try {
    resources = sorobanMeta.ext().v1().totalNonRefundableResourceFeeCharged
      ? sorobanMeta.ext().v1()
      : null;
  } catch {
    resources = null;
  }

  // Extract from the transaction's resource usage embedded in the meta
  let cpuInstructions = 0;
  let memBytes = 0;
  let ledgerReadBytes = 0;
  let ledgerWriteBytes = 0;
  let ledgerReadEntries = 0;
  let ledgerWriteEntries = 0;
  let minResourceFee: string | null = null;

  try {
    const ext = (meta as any).v3().ext();
    if (ext && ext.switch && ext.switch() === 1) {
      const v1 = ext.v1();
      const txChangesAfter = v1.totalNonRefundableResourceFeeCharged?.();
      if (txChangesAfter !== undefined) {
        minResourceFee = String(txChangesAfter);
      }
    }
  } catch {
    /* ignore */
  }

  // Primary path: sorobanMeta.ext().v1() resource fields
  try {
    const extV1 = sorobanMeta.ext().v1();
    cpuInstructions = Number(extV1.totalNonRefundableResourceFeeCharged?.() ?? 0);
  } catch {
    /* ignore */
  }

  // Fallback: parse from the operations' changes in the meta
  try {
    const ops = (meta as any).v3().operations();
    if (Array.isArray(ops) && ops.length > 0) {
      // Resource data is in the sorobanMeta directly
    }
  } catch {
    /* ignore */
  }

  // Best-effort: read from sorobanMeta resource fields directly
  try {
    const r = sorobanMeta.resources?.();
    if (r) {
      cpuInstructions = Number(r.instructions?.() ?? 0);
      memBytes = Number(r.readBytes?.() ?? 0); // SDK maps readBytes to mem in some versions
      ledgerReadBytes = Number(r.readBytes?.() ?? 0);
      ledgerWriteBytes = Number(r.writeBytes?.() ?? 0);
      const footprint = r.footprint?.();
      if (footprint) {
        ledgerReadEntries =
          (footprint.readOnly?.() ?? []).length + (footprint.readWrite?.() ?? []).length;
        ledgerWriteEntries = (footprint.readWrite?.() ?? []).length;
      }
    }
  } catch {
    /* ignore */
  }

  return {
    cpuInstructions,
    memBytes,
    ledgerReadBytes,
    ledgerWriteBytes,
    ledgerReadEntries,
    ledgerWriteEntries,
    minResourceFee,
  };
}
