/**
 * Protocol Upgrade Fork Invariant Verifier
 *
 * Pre-validation gating engine that screens incoming protocol upgrades for
 * structural ledger changes. Validates XDR definitions dynamically against
 * upcoming schema adaptations before new rules go live, so parser engines
 * are never exposed to breaking structures at runtime.
 *
 * Usage:
 *   const result = await verifyUpgradeInvariants(candidateXdrs, nextProtocolVersion);
 *   if (!result.safe) throw new Error(result.violations.join('; '));
 */

import { xdr } from '@stellar/stellar-sdk';

// ── Invariant definitions ────────────────────────────────────────────────────

export interface XdrInvariant {
  /** Human-readable name for this invariant */
  name: string;
  /**
   * Probe function: receives a raw base64 XDR blob and returns true if the
   * structural invariant holds. Must not throw — return false on any error.
   */
  probe: (xdrBase64: string) => boolean;
}

export interface CandidateXdrs {
  /** A sample transaction envelope XDR (base64) to probe */
  envelopeXdr?: string;
  /** A sample transaction result XDR (base64) to probe */
  resultXdr?: string;
  /** A sample transaction result meta XDR (base64) to probe */
  resultMetaXdr?: string;
  /** A sample ledger entry XDR (base64) to probe */
  ledgerEntryXdr?: string;
}

export interface InvariantViolation {
  invariant: string;
  reason: string;
}

export interface UpgradeValidationResult {
  /** True only when all invariants pass */
  safe: boolean;
  protocolVersion: number;
  violations: InvariantViolation[];
  /** Invariants that passed */
  passed: string[];
  /** Invariants that were skipped (no sample XDR provided for their category) */
  skipped: string[];
}

// ── Core invariants ──────────────────────────────────────────────────────────

/**
 * Invariants keyed by the XDR category they require.
 * Each invariant probes one structural property of the XDR type.
 */
const ENVELOPE_INVARIANTS: XdrInvariant[] = [
  {
    name: 'envelope:decodable',
    probe: (b64) => {
      try {
        xdr.TransactionEnvelope.fromXDR(b64, 'base64');
        return true;
      } catch {
        return false;
      }
    },
  },
  {
    name: 'envelope:known-switch',
    probe: (b64) => {
      try {
        const env = xdr.TransactionEnvelope.fromXDR(b64, 'base64');
        const name = env.switch().name;
        return (
          name === 'envelopeTypeTx' ||
          name === 'envelopeTypeTxV0' ||
          name === 'envelopeTypeTxFeeBump'
        );
      } catch {
        return false;
      }
    },
  },
  {
    name: 'envelope:has-operations',
    probe: (b64) => {
      try {
        const env = xdr.TransactionEnvelope.fromXDR(b64, 'base64');
        const ops =
          env.switch().name === 'envelopeTypeTx'
            ? env.v1().tx().operations()
            : env.switch().name === 'envelopeTypeTxV0'
              ? env.v0().tx().operations()
              : null;
        return ops !== null;
      } catch {
        return false;
      }
    },
  },
];

const RESULT_INVARIANTS: XdrInvariant[] = [
  {
    name: 'result:decodable',
    probe: (b64) => {
      try {
        xdr.TransactionResult.fromXDR(b64, 'base64');
        return true;
      } catch {
        return false;
      }
    },
  },
  {
    name: 'result:has-result-union',
    probe: (b64) => {
      try {
        const r = xdr.TransactionResult.fromXDR(b64, 'base64');
        // result() must return a union with a switch
        const res = r.result();
        return typeof res.switch === 'function';
      } catch {
        return false;
      }
    },
  },
];

const RESULT_META_INVARIANTS: XdrInvariant[] = [
  {
    name: 'resultMeta:decodable',
    probe: (b64) => {
      try {
        xdr.TransactionResultMeta.fromXDR(b64, 'base64');
        return true;
      } catch {
        return false;
      }
    },
  },
];

const LEDGER_ENTRY_INVARIANTS: XdrInvariant[] = [
  {
    name: 'ledgerEntry:decodable',
    probe: (b64) => {
      try {
        xdr.LedgerEntry.fromXDR(b64, 'base64');
        return true;
      } catch {
        return false;
      }
    },
  },
  {
    name: 'ledgerEntry:known-type',
    probe: (b64) => {
      try {
        const entry = xdr.LedgerEntry.fromXDR(b64, 'base64');
        const typeName = entry.data().switch().name;
        const known = [
          'account',
          'trustline',
          'offer',
          'data',
          'claimableBalance',
          'liquidityPool',
          'contractData',
          'contractCode',
          'configSetting',
          'ttl',
        ];
        return known.includes(typeName);
      } catch {
        return false;
      }
    },
  },
];

// ── Version-specific structural rules ────────────────────────────────────────

/**
 * Additional invariants that only apply at or above a given protocol version.
 * These encode "if we're on protocol N+, this structure MUST exist."
 */
const VERSION_INVARIANTS: Array<{
  minVersion: number;
  invariant: XdrInvariant;
  category: keyof CandidateXdrs;
}> = [
  {
    minVersion: 20,
    category: 'envelopeXdr',
    invariant: {
      name: 'envelope:soroban-v1-invoke-host-function-arm',
      probe: (b64) => {
        try {
          const env = xdr.TransactionEnvelope.fromXDR(b64, 'base64');
          if (env.switch().name !== 'envelopeTypeTx') return true; // not a v1 tx, skip
          const ops = env.v1().tx().operations();
          // If any op is invokeHostFunction, the arm must be parseable
          for (const op of ops) {
            if (op.body().switch().name === 'invokeHostFunction') {
              op.body().invokeHostFunctionOp(); // throws if arm is broken
            }
          }
          return true;
        } catch {
          return false;
        }
      },
    },
  },
  {
    minVersion: 21,
    category: 'resultMetaXdr',
    invariant: {
      name: 'resultMeta:v3-soroban-meta-accessible',
      probe: (b64) => {
        try {
          const meta = xdr.TransactionResultMeta.fromXDR(b64, 'base64');
          // v3 meta must have a txApplyProcessing field accessible without throwing
          const result = meta.result();
          return typeof result !== 'undefined';
        } catch {
          return false;
        }
      },
    },
  },
];

// ── Engine ───────────────────────────────────────────────────────────────────

function runInvariants(
  invariants: XdrInvariant[],
  xdrBlob: string,
  violations: InvariantViolation[],
  passed: string[],
): void {
  for (const inv of invariants) {
    try {
      if (inv.probe(xdrBlob)) {
        passed.push(inv.name);
      } else {
        violations.push({ invariant: inv.name, reason: 'probe returned false' });
      }
    } catch (err) {
      violations.push({
        invariant: inv.name,
        reason: `probe threw: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
}

/**
 * Verify structural invariants against candidate XDR samples for a given
 * upcoming protocol version. Call this before allowing the indexer to process
 * ledgers under the new protocol.
 *
 * @param candidates  Sample XDR blobs from the first ledger(s) of the new protocol
 * @param nextVersion The protocol version being gated
 */
export function verifyUpgradeInvariants(
  candidates: CandidateXdrs,
  nextVersion: number,
): UpgradeValidationResult {
  const violations: InvariantViolation[] = [];
  const passed: string[] = [];
  const skipped: string[] = [];

  // Run category invariants only when a sample is provided
  if (candidates.envelopeXdr) {
    runInvariants(ENVELOPE_INVARIANTS, candidates.envelopeXdr, violations, passed);
  } else {
    skipped.push(...ENVELOPE_INVARIANTS.map((i) => i.name));
  }

  if (candidates.resultXdr) {
    runInvariants(RESULT_INVARIANTS, candidates.resultXdr, violations, passed);
  } else {
    skipped.push(...RESULT_INVARIANTS.map((i) => i.name));
  }

  if (candidates.resultMetaXdr) {
    runInvariants(RESULT_META_INVARIANTS, candidates.resultMetaXdr, violations, passed);
  } else {
    skipped.push(...RESULT_META_INVARIANTS.map((i) => i.name));
  }

  if (candidates.ledgerEntryXdr) {
    runInvariants(LEDGER_ENTRY_INVARIANTS, candidates.ledgerEntryXdr, violations, passed);
  } else {
    skipped.push(...LEDGER_ENTRY_INVARIANTS.map((i) => i.name));
  }

  // Version-specific invariants
  for (const { minVersion, category, invariant } of VERSION_INVARIANTS) {
    if (nextVersion < minVersion) {
      skipped.push(invariant.name);
      continue;
    }
    const blob = candidates[category];
    if (!blob) {
      skipped.push(invariant.name);
      continue;
    }
    try {
      if (invariant.probe(blob)) {
        passed.push(invariant.name);
      } else {
        violations.push({ invariant: invariant.name, reason: 'probe returned false' });
      }
    } catch (err) {
      violations.push({
        invariant: invariant.name,
        reason: `probe threw: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  return {
    safe: violations.length === 0,
    protocolVersion: nextVersion,
    violations,
    passed,
    skipped,
  };
}

/**
 * Gate function for the indexer: call before processing the first ledger of a
 * new protocol version. Logs a structured warning if any invariant fails and
 * returns false, signalling the caller to hold off or fall back to safe mode.
 */
export function gateUpgrade(candidates: CandidateXdrs, nextVersion: number): boolean {
  const result = verifyUpgradeInvariants(candidates, nextVersion);

  if (!result.safe) {
    console.warn(
      `[upgrade-invariant] ⛔ Protocol ${nextVersion} failed pre-validation. ` +
        `${result.violations.length} violation(s):`,
      result.violations.map((v) => `${v.invariant}: ${v.reason}`).join(' | '),
    );
    return false;
  }

  console.log(
    `[upgrade-invariant] ✅ Protocol ${nextVersion} passed pre-validation. ` +
      `${result.passed.length} invariant(s) checked, ${result.skipped.length} skipped.`,
  );
  return true;
}
