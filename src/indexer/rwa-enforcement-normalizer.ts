/**
 * RWA Enforcement & Clawback Event Normalizer — Issue #174
 *
 * Parses raw Soroban XDR topics/data for enforcement events on tokenized
 * real-world assets (RWAs) and produces rich human-readable summaries:
 *   "Issuer executed a regulatory clawback of 2,500 tokenized treasury notes
 *    from address GABC... at ledger 4521983."
 *
 * Supported event symbols:
 *   clawback          — regulatory asset recovery
 *   freeze            — account freeze / asset lock
 *   seize             — forced asset seizure
 *   regulatory_action — generic compliance action
 */

import { xdr, scValToNative, Address } from '@stellar/stellar-sdk';
import { formatAmount } from './args-decoder';
import { trackRwaClawback } from './rwa-compliance-tracker';

// ─── Event definitions ────────────────────────────────────────────────────────

export type RwaEnforcementSymbol = 'clawback' | 'freeze' | 'seize' | 'regulatory_action';

interface RwaEventDef {
  /** topics[1..] layout after the symbol topic */
  topicParams: Array<{ name: string; type: 'address' | 'string' | 'symbol' }>;
  /** data field type */
  dataType: 'i128' | 'string' | 'symbol' | 'none';
  /** Template — {issuer}, {from}, {amount}, {asset}, {reason}, {action} */
  humanTemplate: string;
}

const RWA_EVENTS: Record<RwaEnforcementSymbol, RwaEventDef> = {
  clawback: {
    topicParams: [
      { name: 'issuer', type: 'address' },
      { name: 'from', type: 'address' },
    ],
    dataType: 'i128',
    humanTemplate:
      'Issuer {issuer} executed a regulatory clawback of {amount} {asset} from address {from}',
  },
  freeze: {
    topicParams: [
      { name: 'issuer', type: 'address' },
      { name: 'from', type: 'address' },
    ],
    dataType: 'string',
    humanTemplate: 'Issuer {issuer} froze {asset} holdings of address {from} — reason: {reason}',
  },
  seize: {
    topicParams: [
      { name: 'issuer', type: 'address' },
      { name: 'from', type: 'address' },
    ],
    dataType: 'i128',
    humanTemplate:
      'Issuer {issuer} seized {amount} {asset} from address {from} under regulatory order',
  },
  regulatory_action: {
    topicParams: [
      { name: 'issuer', type: 'address' },
      { name: 'from', type: 'address' },
    ],
    dataType: 'string',
    humanTemplate:
      'Issuer {issuer} executed regulatory action "{action}" against address {from} on {asset}',
  },
};

const RWA_EVENT_SYMBOLS = new Set<string>(Object.keys(RWA_EVENTS));

export function isRwaEnforcementEvent(symbol: string): boolean {
  return RWA_EVENT_SYMBOLS.has(symbol);
}

// ─── Parsed result ────────────────────────────────────────────────────────────

export interface RwaEnforcementEvent {
  symbol: RwaEnforcementSymbol;
  issuer: string;
  from: string;
  /** Formatted token amount (clawback / seize only) */
  amount?: string;
  /** Raw bigint amount */
  rawAmount?: bigint;
  /** Reason / action string (freeze / regulatory_action only) */
  reason?: string;
  humanReadable: string;
}

// ─── Parser ───────────────────────────────────────────────────────────────────

/**
 * Parse a raw Soroban enforcement event from base64-encoded XDR topics/data.
 *
 * @param topics      base64 XDR ScVal array (topics[0] = event symbol)
 * @param data        base64 XDR ScVal (event data)
 * @param assetSymbol display name for the asset (e.g. "tokenized treasury notes")
 * @param decimals    token decimal places (default 7)
 * @returns parsed event or null if not a recognised RWA enforcement event
 */
export function parseRwaEnforcementEvent(
  topics: string[],
  data: string,
  assetSymbol = 'RWA tokens',
  decimals = 7,
): RwaEnforcementEvent | null {
  if (topics.length < 3) return null;

  let symbol: string;
  try {
    const symVal = xdr.ScVal.fromXDR(topics[0], 'base64');
    symbol =
      symVal.switch().name === 'scvSymbol'
        ? symVal.sym().toString()
        : String(scValToNative(symVal));
  } catch {
    return null;
  }

  if (!isRwaEnforcementEvent(symbol)) return null;
  const def = RWA_EVENTS[symbol as RwaEnforcementSymbol];

  // Decode address topics
  const decodeAddress = (b64: string): string => {
    try {
      return Address.fromScVal(xdr.ScVal.fromXDR(b64, 'base64')).toString();
    } catch {
      return b64;
    }
  };

  const issuer = decodeAddress(topics[1]);
  const from = decodeAddress(topics[2]);

  // Decode data
  let amount: string | undefined;
  let rawAmount: bigint | undefined;
  let reason: string | undefined;

  if (def.dataType === 'i128') {
    try {
      const dataVal = xdr.ScVal.fromXDR(data, 'base64');
      rawAmount = scValToNative(dataVal) as bigint;
      amount = formatAmount(rawAmount, decimals);
    } catch {
      amount = '?';
    }
  } else if (def.dataType === 'string' || def.dataType === 'symbol') {
    try {
      reason = String(scValToNative(xdr.ScVal.fromXDR(data, 'base64')));
    } catch {
      reason = '';
    }
  }

  const humanReadable = renderTemplate(def.humanTemplate, {
    issuer,
    from,
    amount: amount ?? '',
    asset: assetSymbol,
    reason: reason ?? '',
    action: reason ?? '',
  });

  return {
    symbol: symbol as RwaEnforcementSymbol,
    issuer,
    from,
    ...(amount !== undefined && { amount, rawAmount }),
    ...(reason !== undefined && { reason }),
    humanReadable,
  };
}

// ─── Processor ────────────────────────────────────────────────────────────────

/**
 * Process a raw enforcement event and persist it via rwa-compliance-tracker.
 * Call this from the indexer event loop when `isRwaEnforcementEvent` is true.
 */
export async function processRwaEnforcementEvent(
  topics: string[],
  data: string,
  context: {
    transactionHash: string;
    ledgerSequence: number;
    ledgerCloseTime: Date;
    assetContractAddress: string;
    assetSymbol?: string;
    decimals?: number;
  },
): Promise<RwaEnforcementEvent | null> {
  const parsed = parseRwaEnforcementEvent(topics, data, context.assetSymbol, context.decimals);
  if (!parsed) return null;

  await trackRwaClawback(
    context.transactionHash,
    context.ledgerSequence,
    context.ledgerCloseTime,
    context.assetContractAddress,
    parsed.issuer,
    parsed.from,
    parsed.amount ?? '0',
    parsed.reason ?? parsed.symbol,
  );

  return parsed;
}

// ─── Template renderer ────────────────────────────────────────────────────────

function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key) => vars[key] ?? '');
}
