import { xdr } from '@stellar/stellar-sdk';
import { prismaRead } from '../db';

// ── Constants ────────────────────────────────────────────────────────────────

const STROOPS_PER_XLM = 10_000_000n;

// ── Types ────────────────────────────────────────────────────────────────────

export interface TtlExtension {
  /** Hex-encoded ledger key whose TTL was extended */
  ledgerKey: string;
  /** Ledger sequence before the extension (null if unknown) */
  previousLiveUntilLedger: number | null;
  /** Ledger sequence after the extension */
  newLiveUntilLedger: number;
  /** Number of ledgers added to the entry's lifespan */
  ledgersExtended: number | null;
  /**
   * True when this extension key matches a WASM code entry that was recently
   * upgraded (cross-checked against WasmUpgradeHistory within ±5 ledgers).
   */
  isWasmUpgradeExtension: boolean;
  /** Contract address if this key is a ContractCode entry, else null */
  relatedContractAddress: string | null;
}

export interface RentPayment {
  /** Total fee charged for the transaction (in Stroops) */
  feeChargedStroops: bigint;
  /** Estimated rent portion (minResourceFee from simulation, in Stroops) */
  minResourceFeeStroops: bigint | null;
  /** Human-readable XLM equivalent */
  feeChargedXlm: string;
}

export interface TtlTrackingResult {
  hasExtendOp: boolean;
  extensions: TtlExtension[];
  rentPayment: RentPayment | null;
  summary: string;
  /** Number of extensions that correlate with WASM upgrade events */
  wasmUpgradeExtensionCount: number;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function ledgerKeyToHex(key: xdr.LedgerKey): string {
  try {
    return key.toXDR('hex');
  } catch {
    return 'unknown';
  }
}

function stroopsToXlm(stroops: bigint): string {
  const whole = stroops / STROOPS_PER_XLM;
  const frac = stroops % STROOPS_PER_XLM;
  return `${whole}.${frac.toString().padStart(7, '0')} XLM`;
}

/**
 * Extract the WASM hash hex from a ContractCode ledger key.
 * Returns null for non-ContractCode keys.
 */
function extractWasmHashFromKey(key: xdr.LedgerKey): string | null {
  try {
    if (key.switch().name === 'contractCode') {
      return Buffer.from(key.contractCode().hash()).toString('hex');
    }
  } catch {
    // ignore
  }
  return null;
}

/**
 * Extract the contract address (strkey) from a ContractData ledger key.
 * Returns null for other key types.
 */
function extractContractAddressFromKey(key: xdr.LedgerKey): string | null {
  try {
    if (key.switch().name === 'contractData') {
      const contract = key.contractData().contract();
      if (contract.switch().name === 'scAddressTypeContract') {
        return contract.contractId().toString('hex');
      }
    }
  } catch {
    // ignore
  }
  return null;
}

/**
 * Look up WasmUpgradeHistory records for a set of WASM hash hex strings near a
 * given ledger sequence (±5 ledgers).  Returns a Set of wasm hashes that have
 * a matching upgrade record.
 *
 * This cross-check ties bulk TTL extensions following a wasm upgrade to the
 * upgrade event — closing the gap between upgrade-detector.ts and the TTL
 * tracker (issue #880).
 */
async function fetchRecentUpgradeHashes(
  wasmHashes: string[],
  nearLedger: number,
): Promise<Set<string>> {
  if (wasmHashes.length === 0) return new Set();
  const db = prismaRead as any;
  try {
    const rows: Array<{ newWasmHash: string }> = await db.wasmUpgradeHistory.findMany({
      where: {
        newWasmHash: { in: wasmHashes },
        ledgerSequence: { gte: nearLedger - 5, lte: nearLedger + 5 },
      },
      select: { newWasmHash: true },
    });
    return new Set(rows.map((r) => r.newWasmHash.toLowerCase()));
  } catch {
    // Best-effort: if the DB is unavailable don't fail the main flow
    return new Set();
  }
}

// ── Main tracker ─────────────────────────────────────────────────────────────

/**
 * Detect **all** ExtendFootprintTTLOp operations in a transaction envelope XDR,
 * compute how many ledgers were added to each entry's lifespan, and
 * cross-check the extended keys against WasmUpgradeHistory to flag bulk
 * extensions that follow WASM upgrades.
 *
 * ### What changed vs the original (issue #880)
 *
 * Previously the code extracted `sorobanData` once at the transaction level and
 * applied the *same* footprint to every `ExtendFootprintTTLOp` found in the
 * operation list.  In practice a single Soroban transaction carries exactly one
 * `SorobanTransactionData` and therefore one footprint, but bulk upgrade
 * patterns submit *multiple transactions* — each with its own footprint — in a
 * single ledger.  The fix ensures:
 *
 * 1. For each `ExtendFootprintTTLOp` we resolve its `extendTo` value from the
 *    op body (unchanged) **and** the shared `sorobanData` footprint, yielding a
 *    `TtlExtension` record per footprint entry per op (not just per op).
 *
 * 2. ContractCode entries in the footprint are matched against
 *    `WasmUpgradeHistory` (±5 ledgers) so callers know which extensions are
 *    upgrade-related.
 *
 * @param envelopeXdr    Base64-encoded TransactionEnvelope XDR
 * @param feeCharged     Fee charged for the transaction in Stroops (from tx result)
 * @param minResourceFee Optional minResourceFee from simulation (Stroops string)
 * @param previousTtls   Optional map of ledgerKey hex → previous liveUntilLedger
 * @param ledgerSequence Ledger sequence of the transaction (used for upgrade cross-check)
 */
export async function trackTtlChanges(
  envelopeXdr: string,
  feeCharged?: string | null,
  minResourceFee?: string | null,
  previousTtls?: Map<string, number>,
  ledgerSequence?: number,
): Promise<TtlTrackingResult> {
  let envelope: xdr.TransactionEnvelope;
  try {
    envelope = xdr.TransactionEnvelope.fromXDR(envelopeXdr, 'base64');
  } catch {
    return {
      hasExtendOp: false,
      extensions: [],
      rentPayment: null,
      summary: 'Could not parse transaction envelope',
      wasmUpgradeExtensionCount: 0,
    };
  }

  const switchName = envelope.switch().name;
  const ops: xdr.Operation[] =
    switchName === 'envelopeTypeTx'
      ? envelope.v1().tx().operations()
      : switchName === 'envelopeTypeTxV0'
        ? envelope.v0().tx().operations()
        : [];

  const extendOps = ops.filter((op) => op.body().switch().name === 'extendFootprintTtl');

  if (extendOps.length === 0) {
    return {
      hasExtendOp: false,
      extensions: [],
      rentPayment: null,
      summary: 'No ExtendFootprintTTLOp found',
      wasmUpgradeExtensionCount: 0,
    };
  }

  // The SorobanTransactionData (and its footprint) is embedded once per
  // transaction, shared by all operations. Extract it once.
  let sorobanData: xdr.SorobanTransactionData | null = null;
  try {
    if (switchName === 'envelopeTypeTx') {
      const ext = envelope.v1().tx().ext();
      if ((ext.switch() as unknown as number) === 1) {
        sorobanData = ext.sorobanData();
      }
    }
  } catch {
    // sorobanData not available
  }

  const footprintKeys: xdr.LedgerKey[] = sorobanData
    ? [
        ...sorobanData.resources().footprint().readOnly(),
        ...sorobanData.resources().footprint().readWrite(),
      ]
    : [];

  // Collect WASM hashes present in the footprint for upgrade cross-check
  const wasmHashesInFootprint: string[] = footprintKeys
    .map(extractWasmHashFromKey)
    .filter((h): h is string => h !== null);

  // Async upgrade cross-check (best-effort, doesn't block on failure)
  const upgradeHashes = await fetchRecentUpgradeHashes(wasmHashesInFootprint, ledgerSequence ?? 0);

  const extensions: TtlExtension[] = [];

  for (const op of extendOps) {
    const extendOp = op.body().extendFootprintTtlOp();
    const extendTo = extendOp.extendTo();

    if (footprintKeys.length === 0) {
      // No footprint available — record a single placeholder entry
      extensions.push({
        ledgerKey: 'unknown',
        previousLiveUntilLedger: null,
        newLiveUntilLedger: extendTo,
        ledgersExtended: null,
        isWasmUpgradeExtension: false,
        relatedContractAddress: null,
      });
    } else {
      // Record one extension entry per footprint key per op. In almost all
      // real transactions there is exactly one ExtendFootprintTTLOp, so this
      // is equivalent to the original behaviour for the common case.  For the
      // rare multi-op case it correctly captures every entry.
      for (const key of footprintKeys) {
        const keyHex = ledgerKeyToHex(key);
        const prev = previousTtls?.get(keyHex) ?? null;
        const wasmHash = extractWasmHashFromKey(key);
        const isWasmUpgradeExtension =
          wasmHash !== null && upgradeHashes.has(wasmHash.toLowerCase());
        const relatedContractAddress = extractContractAddressFromKey(key);

        extensions.push({
          ledgerKey: keyHex,
          previousLiveUntilLedger: prev,
          newLiveUntilLedger: extendTo,
          ledgersExtended: prev !== null ? extendTo - prev : null,
          isWasmUpgradeExtension,
          relatedContractAddress,
        });
      }
    }
  }

  // Rent payment
  let rentPayment: RentPayment | null = null;
  if (feeCharged) {
    const feeStroops = BigInt(feeCharged);
    const minFeeStroops = minResourceFee ? BigInt(minResourceFee) : null;
    rentPayment = {
      feeChargedStroops: feeStroops,
      minResourceFeeStroops: minFeeStroops,
      feeChargedXlm: stroopsToXlm(feeStroops),
    };
  }

  const wasmUpgradeExtensionCount = extensions.filter((e) => e.isWasmUpgradeExtension).length;
  const totalExtended = extensions.reduce((sum, e) => sum + (e.ledgersExtended ?? 0), 0);
  const summary =
    `Extended TTL for ${extensions.length} entr${extensions.length === 1 ? 'y' : 'ies'}` +
    (totalExtended > 0 ? ` (+${totalExtended} ledgers total)` : '') +
    (wasmUpgradeExtensionCount > 0
      ? `, ${wasmUpgradeExtensionCount} WASM upgrade extension(s)`
      : '') +
    (rentPayment ? `, rent paid: ${rentPayment.feeChargedXlm}` : '');

  return {
    hasExtendOp: true,
    extensions,
    rentPayment,
    summary,
    wasmUpgradeExtensionCount,
  };
}
