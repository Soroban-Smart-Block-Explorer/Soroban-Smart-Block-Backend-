import { xdr } from '@stellar/stellar-sdk';

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

// ── Main tracker ─────────────────────────────────────────────────────────────

/**
 * Detect ExtendFootprintTTLOp operations in a transaction envelope XDR and
 * compute how many ledgers were added to each entry's lifespan.
 *
 * @param envelopeXdr   Base64-encoded TransactionEnvelope XDR
 * @param feeCharged    Fee charged for the transaction in Stroops (from tx result)
 * @param minResourceFee Optional minResourceFee from simulation (Stroops string)
 * @param previousTtls  Optional map of ledgerKey hex → previous liveUntilLedger
 */
export function trackTtlChanges(
  envelopeXdr: string,
  feeCharged?: string | null,
  minResourceFee?: string | null,
  previousTtls?: Map<string, number>,
): TtlTrackingResult {
  let envelope: xdr.TransactionEnvelope;
  try {
    envelope = xdr.TransactionEnvelope.fromXDR(envelopeXdr, 'base64');
  } catch {
    return {
      hasExtendOp: false,
      extensions: [],
      rentPayment: null,
      summary: 'Could not parse transaction envelope',
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
    };
  }

  const extensions: TtlExtension[] = [];

  for (const op of extendOps) {
    const extendOp = op.body().extendFootprintTtlOp();
    const extendTo = extendOp.extendTo();

    // The footprint is embedded in the SorobanTransactionData of the tx
    // We extract it from the transaction's sorobanData field
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

    if (footprintKeys.length === 0) {
      // Record a single extension entry without specific key info
      extensions.push({
        ledgerKey: 'unknown',
        previousLiveUntilLedger: null,
        newLiveUntilLedger: extendTo,
        ledgersExtended: null,
      });
    } else {
      for (const key of footprintKeys) {
        const keyHex = ledgerKeyToHex(key);
        const prev = previousTtls?.get(keyHex) ?? null;
        extensions.push({
          ledgerKey: keyHex,
          previousLiveUntilLedger: prev,
          newLiveUntilLedger: extendTo,
          ledgersExtended: prev !== null ? extendTo - prev : null,
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

  const totalExtended = extensions.reduce((sum, e) => sum + (e.ledgersExtended ?? 0), 0);
  const summary =
    `Extended TTL for ${extensions.length} entr${extensions.length === 1 ? 'y' : 'ies'}` +
    (totalExtended > 0 ? ` (+${totalExtended} ledgers total)` : '') +
    (rentPayment ? `, rent paid: ${rentPayment.feeChargedXlm}` : '');

  return { hasExtendOp: true, extensions, rentPayment, summary };
}
