import { xdr, scValToNative } from '@stellar/stellar-sdk';
import { getContractAbi, decodeArgs, renderHuman } from './registry';
import { parseInvokeHostFunction } from './xdr-parser';
import { parseSep41Event, isSep41Event } from './sep41-parser';
import { parseRwaEnforcementEvent, isRwaEnforcementEvent } from './rwa-enforcement-normalizer';
import { prismaRead as prisma } from '../db';
import { decodeMastercardFlags } from './identity-verifier';

/**
 * Look up a custom EventDefinition for a given contract + topic symbol.
 * Returns the humanTemplate string if found, otherwise null.
 */
export async function lookupCustomEventTemplate(
  contractAddress: string,
  topicSymbol: string
): Promise<string | null> {
  const def = await prisma.eventDefinition.findUnique({
    where: { contractAddress_topicSymbol: { contractAddress, topicSymbol } },
    select: { humanTemplate: true },
  });
  return def?.humanTemplate ?? null;
}

/**
 * Render a custom template by substituting {{data.key}} and {{topics.N}} placeholders.
 * Supports: {{data.key}}, {{topics.0}}, {{topics.1}}, etc.
 */
export function renderCustomTemplate(
  template: string,
  topicValues: unknown[],
  dataValue: unknown
): string {
  return template.replace(/\{\{([\w.]+)\}\}/g, (_match, path: string) => {
    const parts = path.split('.');
    if (parts[0] === 'topics' && parts[1] !== undefined) {
      return String(topicValues[Number(parts[1])] ?? '');
    }
    if (parts[0] === 'data') {
      const val = parts[1] !== undefined && typeof dataValue === 'object' && dataValue !== null
        ? (dataValue as Record<string, unknown>)[parts[1]]
        : dataValue;
      return String(val ?? '');
    }
    return _match;
  });
}

export interface DecodedTransaction {
  contractAddress: string | null;
  functionName: string | null;
  functionArgs: Record<string, unknown> | null;
  humanReadable: string | null;
}

/**
 * Decode a raw transaction XDR into human-readable form.
 *
 * Handles envelopeTypeTx (v1), envelopeTypeTxV0 (v0), and
 * envelopeTypeTxFeeBump by extracting the inner transaction and
 * prefixing the human-readable output with "(fee-bump)".
 */
export async function decodeTransaction(rawXdr: string): Promise<DecodedTransaction> {
  // ── fee-bump fast path ────────────────────────────────────────────────────
  try {
    const envelope = xdr.TransactionEnvelope.fromXDR(rawXdr, 'base64');
    if (envelope.switch().name === 'envelopeTypeTxFeeBump') {
      // The inner transaction is itself a TransactionEnvelope (v1).
      const innerEnvelope = envelope.feeBump().tx().innerTx();
      const innerXdr = innerEnvelope.toXDR('base64');
      const inner = await decodeTransaction(innerXdr);
      return {
        contractAddress: inner.contractAddress,
        functionName: inner.functionName,
        functionArgs: inner.functionArgs,
        humanReadable: inner.humanReadable
          ? `(fee-bump) ${inner.humanReadable}`
          : '(fee-bump)',
      };
    }
  } catch {
    // Not a valid fee-bump envelope — fall through to standard decode
  }

  // ── standard v1 / v0 path ─────────────────────────────────────────────────
  const parsed = parseInvokeHostFunction(rawXdr);
  if (!parsed) {
    return { contractAddress: null, functionName: null, functionArgs: null, humanReadable: null };
  }

  const { contractId: contractAddress, functionName, args } = parsed;

  // Re-parse raw args as xdr.ScVal[] for the existing registry helpers
  let rawArgs: xdr.ScVal[];
  try {
    const envelope = xdr.TransactionEnvelope.fromXDR(rawXdr, 'base64');
    const ops = envelope.switch().name === 'envelopeTypeTx'
      ? envelope.v1().tx().operations()
      : envelope.v0().tx().operations();
    const invokeOp = ops.find((op) => op.body().switch().name === 'invokeHostFunction')!;
    rawArgs = invokeOp.body().invokeHostFunctionOp().hostFunction().invokeContract().args();
  } catch {
    rawArgs = [];
  }

  // Check for compliance flags if it's a mastercard contract
  let complianceMessage = '';
  if (contractAddress.includes('mastercard') || functionName.includes('mastercard')) {
     const compliance = decodeMastercardFlags(args);
     if (compliance) {
         complianceMessage = ` | ${compliance.complianceMessage}`;
     }
  }

  const abi = await getContractAbi(contractAddress);
  if (!abi) {
    return { contractAddress, functionName, functionArgs: null, humanReadable: `Called ${functionName} on ${contractAddress}${complianceMessage}` };
  }

  const contract = await prisma.contract.findUnique({ where: { address: contractAddress } });
  const decoded = decodeArgs(functionName, rawArgs, abi, contract?.tokenDecimals ?? undefined);
  const human = decoded
    ? renderHuman(functionName, decoded, abi, contract?.name, contract?.tokenDecimals ?? undefined) + complianceMessage
    : `Called ${functionName} on ${contract?.name ?? contractAddress}` + complianceMessage;

  return { contractAddress, functionName, functionArgs: decoded, humanReadable: human };
}

/**
 * Decode a Soroban event topic/data into a human-readable event.
 */
export function decodeEvent(
  topics: string[],
  data: string,
  contractName?: string | null
): { eventType: string; topicSymbol: string | null; decoded: Record<string, unknown> } {
  try {
    const topicVals = topics.map((t) => xdr.ScVal.fromXDR(t, 'base64'));

    // First topic is usually the event name symbol
    const rawSymbol = topicVals[0]
      ? String(scValToNative(topicVals[0]))
      : 'unknown';

    // ── SEP-41 fast path ────────────────────────────────────────────────────
    if (isSep41Event(rawSymbol)) {
      const parsed = parseSep41Event(topics, data);
      if (parsed) {
        // Flatten { raw, formatted } entries to their formatted strings for
        // storage compatibility, and keep the full structured fields too.
        const decoded: Record<string, unknown> = {
          event: rawSymbol,
          humanReadable: parsed.humanReadable,
          ...Object.fromEntries(
            Object.entries(parsed.fields).map(([k, v]) => [k, v.formatted])
          ),
        };
        return { eventType: normalizeEventType(rawSymbol), topicSymbol: rawSymbol, decoded };
      }
    }

    // ── RWA enforcement fast path ───────────────────────────────────────────
    if (isRwaEnforcementEvent(rawSymbol)) {
      const parsed = parseRwaEnforcementEvent(topics, data);
      if (parsed) {
        return {
          eventType: rawSymbol,
          topicSymbol: rawSymbol,
          decoded: {
            event: rawSymbol,
            humanReadable: parsed.humanReadable,
            issuer: parsed.issuer,
            from: parsed.from,
            ...(parsed.amount !== undefined && { amount: parsed.amount }),
            ...(parsed.reason !== undefined && { reason: parsed.reason }),
          },
        };
      }
    }

    // ── Generic fallback ────────────────────────────────────────────────────
    const dataVal = xdr.ScVal.fromXDR(data, 'base64');
    const decoded: Record<string, unknown> = {
      event: rawSymbol,
      topics: topicVals.map((t) => scValToNative(t)),
      data: scValToNative(dataVal),
    };

    return { eventType: normalizeEventType(rawSymbol), topicSymbol: rawSymbol, decoded };
  } catch {
    return { eventType: 'unknown', topicSymbol: null, decoded: { raw: { topics, data } } };
  }
}

function normalizeEventType(raw: string): string {
  const known = [
    'transfer',
    'mint',
    'burn',
    'swap',
    'approve',
    'clawback',
    'set_admin',
    'add_liquidity',
    'remove_liquidity',
    'session_authorization',
    'authorize_session',
    'hot_signer_authorized',
    'ephemeral_key_auth',
    'authorization_window',
    'freeze',
    'seize',
    'regulatory_action',
  ];
  const normalized = raw.toLowerCase();
  return known.includes(normalized) ? normalized : 'custom';
}
