import { xdr, scValToNative } from '@stellar/stellar-sdk';
import { getContractAbi, decodeArgs, renderHuman } from './registry';
import { parseInvokeHostFunction } from './xdr-parser';
import { prismaRead as prisma } from '../db';

export interface DecodedTransaction {
  contractAddress: string | null;
  functionName: string | null;
  functionArgs: Record<string, unknown> | null;
  humanReadable: string | null;
}

/**
 * Decode a raw transaction XDR into human-readable form.
 */
export async function decodeTransaction(rawXdr: string): Promise<DecodedTransaction> {
  const parsed = parseInvokeHostFunction(rawXdr);
  if (!parsed) {
    return { contractAddress: null, functionName: null, functionArgs: null, humanReadable: null };
  }

  const { contractId: contractAddress, functionName } = parsed;

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

  const abi = await getContractAbi(contractAddress);
  if (!abi) {
    return { contractAddress, functionName, functionArgs: null, humanReadable: `Called ${functionName} on ${contractAddress}` };
  }

  const contract = await prisma.contract.findUnique({ where: { address: contractAddress } });
  const decoded = decodeArgs(functionName, rawArgs, abi, contract?.tokenDecimals ?? undefined);
  const human = decoded
    ? renderHuman(functionName, decoded, abi, contract?.name, contract?.tokenDecimals ?? undefined)
    : `Called ${functionName} on ${contract?.name ?? contractAddress}`;

  return { contractAddress, functionName, functionArgs: decoded, humanReadable: human };
}

/**
 * Decode a Soroban event topic/data into a human-readable event.
 */
export function decodeEvent(
  topics: string[],
  data: string,
  _contractName?: string | null
): { eventType: string; decoded: Record<string, unknown> } {
  try {
    const topicVals = topics.map((t) => xdr.ScVal.fromXDR(t, 'base64'));
    const dataVal = xdr.ScVal.fromXDR(data, 'base64');

    // First topic is usually the event name symbol
    const eventType = topicVals[0]
      ? String(scValToNative(topicVals[0]))
      : 'unknown';

    const decoded: Record<string, unknown> = { event: eventType };

    // SEP-41 transfer event: topics = [Symbol("transfer"), from, to], data = amount
    if (eventType === 'transfer' && topicVals.length >= 3) {
      decoded.from = String(scValToNative(topicVals[1]));
      decoded.to = String(scValToNative(topicVals[2]));
      decoded.amount = String(scValToNative(dataVal));
    } else if (eventType === 'mint' && topicVals.length >= 2) {
      decoded.to = String(scValToNative(topicVals[1]));
      decoded.amount = String(scValToNative(dataVal));
    } else if (eventType === 'burn' && topicVals.length >= 2) {
      decoded.from = String(scValToNative(topicVals[1]));
      decoded.amount = String(scValToNative(dataVal));
    } else {
      // Generic: decode all topics and data
      decoded.topics = topicVals.map((t) => scValToNative(t));
      decoded.data = scValToNative(dataVal);
    }

    return { eventType: normalizeEventType(eventType), decoded };
  } catch {
    return { eventType: 'unknown', decoded: { raw: { topics, data } } };
  }
}

function normalizeEventType(raw: string): string {
  const known = ['transfer', 'mint', 'burn', 'swap', 'approve', 'add_liquidity', 'remove_liquidity'];
  return known.includes(raw.toLowerCase()) ? raw.toLowerCase() : 'custom';
}
