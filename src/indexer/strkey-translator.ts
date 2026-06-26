/**
 * Muxed & Contract Strkey Dynamic Translator — Issue #169 (CAP-0079)
 *
 * Universal address normalization parser that decodes multiplexed (M...)
 * and contract (C...) Stellar addresses into their canonical forms.
 *
 * CAP-0079 introduced muxed accounts: a single G-address (master key) can
 * be multiplexed into many virtual sub-accounts identified by a 64-bit memo
 * ID, encoded as an M-address. Cross-chain bridge protocols and Soroban
 * contracts may route funds to M-addresses; this module resolves them back
 * to the underlying master public key (G-address) for identity tracking.
 *
 * Reference: https://github.com/stellar/stellar-protocol/blob/master/core/cap-0079.md
 */

import { MuxedAccount, StrKey } from '@stellar/stellar-sdk';

// ── Types ─────────────────────────────────────────────────────────────────────

/** Canonical address types recognised by the translator. */
export type AddressKind = 'ed25519' | 'muxed' | 'contract' | 'unknown';

export interface TranslatedAddress {
  /** The original address as supplied by the caller. */
  original: string;
  /** Detected address kind. */
  kind: AddressKind;
  /**
   * The canonical G-address (Ed25519 public key) that is the routing identity.
   * - For G-addresses: same as `original`.
   * - For M-addresses: the underlying master public key.
   * - For C-addresses: null (contracts have no underlying G-address).
   * - For unknown: null.
   */
  masterKey: string | null;
  /**
   * The mux ID embedded in an M-address (64-bit unsigned integer as string).
   * Null for all other address kinds.
   */
  muxId: string | null;
  /**
   * The C-address strkey for contract addresses, or null for non-contract kinds.
   */
  contractAddress: string | null;
}

// ── Translator ────────────────────────────────────────────────────────────────

/**
 * Translate any Stellar address string into its canonical components.
 *
 * Handles:
 *  - G... (Ed25519 public key)  → identity pass-through
 *  - M... (muxed account)       → resolves to master G-address + mux ID
 *  - C... (contract strkey)     → validates and returns contract address
 *  - anything else              → kind = 'unknown', all fields null
 *
 * @param address - Raw address string from a Soroban event, bridge call, etc.
 */
export function translateAddress(address: string): TranslatedAddress {
  if (!address || typeof address !== 'string') {
    return {
      original: address,
      kind: 'unknown',
      masterKey: null,
      muxId: null,
      contractAddress: null,
    };
  }

  const trimmed = address.trim();

  // ── G-address: standard Ed25519 public key ────────────────────────────────
  if (trimmed.startsWith('G')) {
    try {
      if (StrKey.isValidEd25519PublicKey(trimmed)) {
        return {
          original: trimmed,
          kind: 'ed25519',
          masterKey: trimmed,
          muxId: null,
          contractAddress: null,
        };
      }
    } catch {
      // fall through to unknown
    }
  }

  // ── M-address: CAP-0079 muxed account ────────────────────────────────────
  if (trimmed.startsWith('M')) {
    try {
      if (StrKey.isValidMed25519PublicKey(trimmed)) {
        const muxed = MuxedAccount.fromAddress(trimmed, '0');
        const masterKey = muxed.baseAccount().accountId();
        const muxId = muxed.id();
        return {
          original: trimmed,
          kind: 'muxed',
          masterKey,
          muxId: muxId !== undefined ? String(muxId) : null,
          contractAddress: null,
        };
      }
    } catch {
      // fall through to unknown
    }
  }

  // ── C-address: Soroban contract strkey ───────────────────────────────────
  if (trimmed.startsWith('C')) {
    try {
      if (StrKey.isValidContract(trimmed)) {
        return {
          original: trimmed,
          kind: 'contract',
          masterKey: null,
          muxId: null,
          contractAddress: trimmed,
        };
      }
    } catch {
      // fall through to unknown
    }
  }

  return {
    original: trimmed,
    kind: 'unknown',
    masterKey: null,
    muxId: null,
    contractAddress: null,
  };
}

/**
 * Resolve an address to its routing identity (master G-address).
 *
 * - G-address → returned as-is.
 * - M-address → underlying master G-address.
 * - C-address → returned as-is (contracts route to themselves).
 * - unknown   → returned as-is (caller decides how to handle).
 */
export function resolveRoutingIdentity(address: string): string {
  const translated = translateAddress(address);
  if (translated.kind === 'muxed' && translated.masterKey) {
    return translated.masterKey;
  }
  return address;
}

/**
 * Normalise an array of addresses, resolving any M-addresses to their master
 * keys. Useful for batch-processing bridge call participants.
 */
export function normalizeAddresses(addresses: string[]): string[] {
  return addresses.map(resolveRoutingIdentity);
}

/**
 * Returns true if the address is a valid Stellar address of any supported kind
 * (G, M, or C).
 */
export function isValidAnyAddress(address: string): boolean {
  const { kind } = translateAddress(address);
  return kind !== 'unknown';
}
