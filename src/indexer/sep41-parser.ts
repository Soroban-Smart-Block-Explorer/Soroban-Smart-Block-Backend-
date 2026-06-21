/**
 * SEP-41 Token Standard Parser
 *
 * Soroban's ERC-20 equivalent. Spec:
 * https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0041.md
 *
 * All function and event signatures are hardcoded here so they can be decoded
 * and formatted instantly — no custom ABI upload required.
 *
 * Functions  : transfer, transfer_from, approve, balance_of, allowance,
 *              decimals, name, symbol, mint, burn, burn_from,
 *              clawback, set_admin, admin
 * Events     : transfer, mint, burn, approve, clawback, set_admin
 */

import { xdr, scValToNative, Address } from '@stellar/stellar-sdk';
import { decodeTypedArgs, formatAmount } from './args-decoder';
import type { AbiParam } from './registry';

// ─── Canonical function signatures ───────────────────────────────────────────

export interface Sep41FunctionDef {
  name: string;
  inputs: AbiParam[];
  /** Human-readable template using {param} placeholders. */
  humanTemplate: string;
}

/**
 * Complete SEP-41 function table.
 * Keyed by function name for O(1) lookup.
 */
export const SEP41_FUNCTIONS: Record<string, Sep41FunctionDef> = {
  transfer: {
    name: 'transfer',
    inputs: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'i128' },
    ],
    humanTemplate: '{from|truncate} transferred {amount} {token} to {to|truncate}',
  },
  transfer_from: {
    name: 'transfer_from',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'i128' },
    ],
    humanTemplate:
      '{spender|truncate} transferred {amount} {token} from {from|truncate} to {to|truncate}',
  },
  approve: {
    name: 'approve',
    inputs: [
      { name: 'from', type: 'address' },
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'i128' },
      { name: 'expiration_ledger', type: 'u32' },
    ],
    humanTemplate:
      '{from|truncate} approved {spender|truncate} to spend {amount} {token} (expires ledger {expiration_ledger})',
  },
  balance_of: {
    name: 'balance_of',
    inputs: [{ name: 'id', type: 'address' }],
    humanTemplate: 'Balance query for {id|truncate}',
  },
  allowance: {
    name: 'allowance',
    inputs: [
      { name: 'from', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    humanTemplate: 'Allowance query: {from|truncate} → {spender|truncate}',
  },
  decimals: {
    name: 'decimals',
    inputs: [],
    humanTemplate: 'Query token decimals',
  },
  name: {
    name: 'name',
    inputs: [],
    humanTemplate: 'Query token name',
  },
  symbol: {
    name: 'symbol',
    inputs: [],
    humanTemplate: 'Query token symbol',
  },
  mint: {
    name: 'mint',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'i128' },
    ],
    humanTemplate: 'Minted {amount} {token} to {to|truncate}',
  },
  burn: {
    name: 'burn',
    inputs: [
      { name: 'from', type: 'address' },
      { name: 'amount', type: 'i128' },
    ],
    humanTemplate: '{from|truncate} burned {amount} {token}',
  },
  burn_from: {
    name: 'burn_from',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'from', type: 'address' },
      { name: 'amount', type: 'i128' },
    ],
    humanTemplate: '{spender|truncate} burned {amount} {token} from {from|truncate}',
  },
  clawback: {
    name: 'clawback',
    inputs: [
      { name: 'from', type: 'address' },
      { name: 'amount', type: 'i128' },
    ],
    humanTemplate: 'Admin clawed back {amount} {token} from {from|truncate}',
  },
  set_admin: {
    name: 'set_admin',
    inputs: [{ name: 'new_admin', type: 'address' }],
    humanTemplate: 'Admin changed to {new_admin|truncate}',
  },
  admin: {
    name: 'admin',
    inputs: [],
    humanTemplate: 'Query token admin',
  },
};

/** Fast O(1) check — is this function name part of the SEP-41 standard? */
const SEP41_FUNCTION_NAMES = new Set(Object.keys(SEP41_FUNCTIONS));

export function isSep41Function(fnName: string): boolean {
  return SEP41_FUNCTION_NAMES.has(fnName);
}

// ─── Canonical event signatures ───────────────────────────────────────────────

export interface Sep41EventDef {
  /** Symbol emitted as the first topic. */
  symbol: string;
  /**
   * Expected topic layout (index 0 is the symbol itself).
   * Describes topics[1], topics[2], … in order.
   */
  topicParams: AbiParam[];
  /** Data field type (single value). */
  dataParam: AbiParam;
  humanTemplate: string;
}

/**
 * SEP-41 event table.
 * Keyed by the raw symbol string emitted as topics[0].
 */
export const SEP41_EVENTS: Record<string, Sep41EventDef> = {
  transfer: {
    symbol: 'transfer',
    topicParams: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
    ],
    dataParam: { name: 'amount', type: 'i128' },
    humanTemplate: '{from|truncate} → {to|truncate}: {amount} {token}',
  },
  mint: {
    symbol: 'mint',
    topicParams: [
      { name: 'admin', type: 'address' },
      { name: 'to', type: 'address' },
    ],
    dataParam: { name: 'amount', type: 'i128' },
    humanTemplate: 'Minted {amount} {token} to {to|truncate}',
  },
  burn: {
    symbol: 'burn',
    topicParams: [{ name: 'from', type: 'address' }],
    dataParam: { name: 'amount', type: 'i128' },
    humanTemplate: '{from|truncate} burned {amount} {token}',
  },
  approve: {
    symbol: 'approve',
    topicParams: [
      { name: 'from', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    dataParam: { name: 'amount', type: 'i128' },
    humanTemplate: '{from|truncate} approved {spender|truncate} for {amount} {token}',
  },
  clawback: {
    symbol: 'clawback',
    topicParams: [
      { name: 'admin', type: 'address' },
      { name: 'from', type: 'address' },
    ],
    dataParam: { name: 'amount', type: 'i128' },
    humanTemplate: 'Admin clawed back {amount} {token} from {from|truncate}',
  },
  set_admin: {
    symbol: 'set_admin',
    topicParams: [{ name: 'new_admin', type: 'address' }],
    dataParam: { name: 'new_admin', type: 'address' },
    humanTemplate: 'Token admin changed to {new_admin|truncate}',
  },
};

/** Fast O(1) check — is this event symbol a known SEP-41 event? */
const SEP41_EVENT_SYMBOLS = new Set(Object.keys(SEP41_EVENTS));

export function isSep41Event(symbol: string): boolean {
  return SEP41_EVENT_SYMBOLS.has(symbol);
}

// ─── Parsed result types ──────────────────────────────────────────────────────

export interface Sep41ParsedCall {
  functionName: string;
  /** Named decoded args, each with { raw, formatted }. */
  args: Record<string, { raw: unknown; formatted: string }>;
  /** Pre-rendered human-readable string. */
  humanReadable: string;
}

export interface Sep41ParsedEvent {
  symbol: string;
  /** Named decoded fields from topics + data. */
  fields: Record<string, { raw: unknown; formatted: string }>;
  /** Pre-rendered human-readable string. */
  humanReadable: string;
}

// ─── Call parser ─────────────────────────────────────────────────────────────

/**
 * Parse a SEP-41 function call from raw XDR ScVal arguments.
 *
 * Returns null if `fnName` is not a known SEP-41 function.
 * Never throws — falls back to raw XDR strings on individual arg decode errors.
 *
 * @param fnName   - The invoked function name (e.g. "transfer")
 * @param rawArgs  - The ScVal argument array from the transaction envelope
 * @param decimals - Token decimal places (default 7, Stellar standard)
 * @param tokenSymbol - Token symbol for display (e.g. "USDC")
 */
export function parseSep41Call(
  fnName: string,
  rawArgs: xdr.ScVal[],
  decimals = 7,
  tokenSymbol = '',
): Sep41ParsedCall | null {
  const def = SEP41_FUNCTIONS[fnName];
  if (!def) return null;

  const decoded = decodeTypedArgs(def.inputs, rawArgs, decimals);
  const human = renderSep41Template(def.humanTemplate, decoded, decimals, tokenSymbol);

  return { functionName: fnName, args: decoded, humanReadable: human };
}

// ─── Event parser ─────────────────────────────────────────────────────────────

/**
 * Parse a SEP-41 event from raw base64-encoded XDR topics and data.
 *
 * topics[0] must be a Symbol ScVal matching a known SEP-41 event name.
 * Returns null if the symbol is not a known SEP-41 event.
 * Never throws.
 *
 * @param topics      - Array of base64-encoded XDR ScVal strings (topics)
 * @param data        - Base64-encoded XDR ScVal string (event data)
 * @param decimals    - Token decimal places (default 7)
 * @param tokenSymbol - Token symbol for display
 */
export function parseSep41Event(
  topics: string[],
  data: string,
  decimals = 7,
  tokenSymbol = '',
): Sep41ParsedEvent | null {
  if (topics.length === 0) return null;

  let symbol: string;
  try {
    const symbolVal = xdr.ScVal.fromXDR(topics[0], 'base64');
    symbol =
      symbolVal.switch().name === 'scvSymbol'
        ? symbolVal.sym().toString()
        : String(scValToNative(symbolVal));
  } catch {
    return null;
  }

  const def = SEP41_EVENTS[symbol];
  if (!def) return null;

  const fields: Record<string, { raw: unknown; formatted: string }> = {};

  // Decode topic params (topics[1], topics[2], …)
  for (let i = 0; i < def.topicParams.length; i++) {
    const topicXdr = topics[i + 1];
    if (!topicXdr) continue;
    try {
      const val = xdr.ScVal.fromXDR(topicXdr, 'base64');
      const [decoded] = Object.values(decodeTypedArgs([def.topicParams[i]], [val], decimals));
      if (decoded) fields[def.topicParams[i].name] = decoded;
    } catch {
      fields[def.topicParams[i].name] = { raw: topicXdr, formatted: topicXdr };
    }
  }

  // Backward compatibility: some mint events only emit a single recipient topic.
  if (symbol === 'mint' && !fields.to && fields.admin) {
    fields.to = fields.admin;
    delete fields.admin;
  }

  // Decode data field
  try {
    const dataVal = xdr.ScVal.fromXDR(data, 'base64');
    const [decoded] = Object.values(decodeTypedArgs([def.dataParam], [dataVal], decimals));
    if (decoded) fields[def.dataParam.name] = decoded;
  } catch {
    fields[def.dataParam.name] = { raw: data, formatted: data };
  }

  const human = renderSep41Template(def.humanTemplate, fields, decimals, tokenSymbol);

  return { symbol, fields, humanReadable: human };
}

// ─── Template renderer ────────────────────────────────────────────────────────

/**
 * Render a SEP-41 template string.
 *
 * Placeholders:
 *   {key}          — resolved display value
 *   {key|truncate} — address truncated to first 6 + "…" + last 4 chars
 *   {token}        — tokenSymbol (empty string if not provided)
 */
export function renderSep41Template(
  template: string,
  args: Record<string, { raw: unknown; formatted: string }>,
  decimals = 7,
  tokenSymbol = '',
): string {
  return template.replace(/\{(\w+)(?:\|(\w+))?\}/g, (_match, key: string, modifier?: string) => {
    if (key === 'token') return tokenSymbol;

    const entry = args[key];
    if (!entry) return '';

    const display = entry.formatted;

    if (modifier === 'truncate' && display.length > 12) {
      return `${display.slice(0, 6)}…${display.slice(-4)}`;
    }
    return display;
  });
}

// ─── ABI export (for registry integration) ────────────────────────────────────

/**
 * Returns the full SEP-41 ABI in the ContractAbi shape used by registry.ts.
 * This is the single source of truth — registry.ts imports from here.
 */
export function getSep41Abi() {
  return {
    functions: Object.values(SEP41_FUNCTIONS).map((def) => ({
      name: def.name,
      inputs: def.inputs,
      humanTemplate: def.humanTemplate,
    })),
  };
}
