import { xdr, scValToNative, Address } from '@stellar/stellar-sdk';
import type { AbiParam } from './registry';
import { isCheckedArithmeticFunction, analyzeCheckedArithmetic, checkedArithmeticToDecodedArg } from './checked-arithmetic-decoder';

export interface DecodedArg {
  raw: unknown;       // native JS value (BigInt, string, object, …)
  formatted: string;  // human-readable display string
}

/**
 * Decode a single ScVal according to its ABI param type.
 * Returns { raw, formatted } so callers can use either.
 */
export function decodeScVal(val: xdr.ScVal, param: AbiParam, decimals?: number): DecodedArg {
  const type = param.type.toLowerCase();

  try {
    switch (true) {
      // ── Integers ──────────────────────────────────────────────────────────
      case type === 'i128' || type === 'u128': {
        const raw = scValToNative(val) as bigint;
        return { raw, formatted: formatAmount(raw, decimals) };
      }

      case type === 'i64' || type === 'u64': {
        const raw = scValToNative(val) as bigint;
        return { raw, formatted: raw.toString() };
      }

      case type === 'i32' || type === 'u32': {
        const raw = scValToNative(val) as number;
        return { raw, formatted: String(raw) };
      }

      // ── 256-bit Integers ──────────────────────────────────────────────────
      case type === 'i256' || type === 'u256': {
        const raw = decode256BitInteger(val);
        return { raw, formatted: raw?.toString() ?? 'invalid' };
      }

      // ── Address ───────────────────────────────────────────────────────────
      case type === 'address': {
        try {
          const raw = Address.fromScVal(val).toString();
          return { raw, formatted: raw };
        } catch {
          const raw = String(scValToNative(val));
          return { raw, formatted: raw };
        }
      }

      // ── Bool ──────────────────────────────────────────────────────────────
      case type === 'bool': {
        const raw = scValToNative(val) as boolean;
        return { raw, formatted: String(raw) };
      }

      // ── Bytes / BytesN ────────────────────────────────────────────────────
      case type === 'bytes' || type.startsWith('bytesn'): {
        const raw = scValToNative(val) as Uint8Array;
        const hex = Buffer.from(raw).toString('hex');
        return { raw, formatted: `0x${hex}` };
      }

      // ── String ────────────────────────────────────────────────────────────
      case type === 'string': {
        const raw = scValToNative(val) as string;
        return { raw, formatted: raw };
      }

      // ── Symbol ────────────────────────────────────────────────────────────
      case type === 'symbol': {
        const raw = val.switch().name === 'scvSymbol'
          ? val.sym().toString()
          : String(scValToNative(val));
        return { raw, formatted: raw };
      }

      // ── Enum (Soroban tagged union — scvVec with one element map) ─────────
      case type === 'enum': {
        const raw = decodeEnum(val);
        return { raw, formatted: safeStringify(raw) };
      }

      // ── Struct (scvMap with named fields) ─────────────────────────────────
      case type === 'struct': {
        const raw = decodeStruct(val);
        return { raw, formatted: safeStringify(raw) };
      }

      // ── Map ───────────────────────────────────────────────────────────────
      case type === 'map': {
        const raw = decodeMap(val);
        return { raw, formatted: safeStringify(raw) };
      }

      // ── Vec / Array ───────────────────────────────────────────────────────
      case type === 'vec' || type.startsWith('vec<'): {
        const raw = (scValToNative(val) as unknown[]).map(String);
        return { raw, formatted: `[${raw.join(', ')}]` };
      }

      // ── Option<T> — scvVoid = None, otherwise unwrap ──────────────────────
      case type.startsWith('option'): {
        if (val.switch().name === 'scvVoid') return { raw: null, formatted: 'None' };
        const inner = type.slice(7, -1); // "option<T>" → "T"
        return decodeScVal(val, { name: param.name, type: inner }, decimals);
      }

      // ── Fallback ──────────────────────────────────────────────────────────
      default: {
        const raw = scValToNative(val);
        return { raw, formatted: String(raw) };
      }
    }
  } catch {
    const fallback = val.toXDR('base64');
    return { raw: fallback, formatted: fallback };
  }
}

/**
 * Decode all function arguments against their ABI params.
 * Returns a map of param name → DecodedArg.
 */
export function decodeTypedArgs(
  params: AbiParam[],
  rawArgs: xdr.ScVal[],
  decimals?: number
): Record<string, DecodedArg> {
  const result: Record<string, DecodedArg> = {};
  for (let i = 0; i < params.length; i++) {
    const val = rawArgs[i];
    if (!val) continue;
    result[params[i].name] = decodeScVal(val, params[i], decimals);
  }
  return result;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Extract a 256-bit integer from an ScVal.
 * Handles both i256 and u256 types.
 */
function decode256BitInteger(val: xdr.ScVal): bigint | null {
  const typeName = val.switch().name;

  if (typeName === 'scvI256') {
    const parts = val.i256();
    const hiHi = BigInt(parts.hiHi().toString());
    const hiLo = BigInt(parts.hiLo().toString());
    const loHi = BigInt(parts.loHi().toString());
    const loLo = BigInt(parts.loLo().toString());
    return (hiHi << 192n) | (hiLo << 128n) | (loHi << 64n) | loLo;
  }

  if (typeName === 'scvU256') {
    const parts = val.u256();
    const hiHi = BigInt(parts.hiHi().toString());
    const hiLo = BigInt(parts.hiLo().toString());
    const loHi = BigInt(parts.loHi().toString());
    const loLo = BigInt(parts.loLo().toString());
    return (hiHi << 192n) | (hiLo << 128n) | (loHi << 64n) | loLo;
  }

  return null;
}

/**
 * Format a bigint amount with 7 decimal places (Stellar standard) or custom decimals.
 * e.g. 100_000_000n with decimals=7 → "10.0000000"
 */
export function formatAmount(raw: bigint, decimals = 7): string {
  if (decimals === 0) return raw.toString();
  const divisor = BigInt(10 ** decimals);
  const whole = raw / divisor;
  const frac = raw % divisor;
  const fracStr = frac.toString().padStart(decimals, '0');
  return `${whole}.${fracStr}`;
}

/**
 * Decode a Soroban enum ScVal.
 * Soroban enums are encoded as scvVec([scvSymbol("VariantName")]) or
 * scvVec([scvSymbol("VariantName"), value]).
 */
function decodeEnum(val: xdr.ScVal): { variant: string; value?: unknown } {
  if (val.switch().name !== 'scvVec') {
    return { variant: String(scValToNative(val)) };
  }
  const items = val.vec()!;
  const variant = items[0]?.switch().name === 'scvSymbol'
    ? items[0].sym().toString()
    : String(scValToNative(items[0]));
  if (items.length === 1) return { variant };
  return { variant, value: scValToNative(items[1]) };
}

/**
 * Decode a Soroban struct ScVal (scvMap with symbol keys).
 */
function decodeStruct(val: xdr.ScVal): Record<string, unknown> {
  if (val.switch().name !== 'scvMap') return { raw: scValToNative(val) };
  const result: Record<string, unknown> = {};
  for (const entry of val.map()!) {
    const key = entry.key().switch().name === 'scvSymbol'
      ? entry.key().sym().toString()
      : String(scValToNative(entry.key()));
    result[key] = scValToNative(entry.val());
  }
  return result;
}

/**
 * Decode a generic ScVal map into a JS object with string keys.
 */
function decodeMap(val: xdr.ScVal): Record<string, unknown> {
  if (val.switch().name !== 'scvMap') return { raw: scValToNative(val) };
  const result: Record<string, unknown> = {};
  for (const entry of val.map()!) {
    const key = String(scValToNative(entry.key()));
    result[key] = scValToNative(entry.val());
  }
  return result;
}

/** JSON.stringify that serializes BigInt as string to avoid TypeError. */
function safeStringify(val: unknown): string {
  return JSON.stringify(val, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
}
