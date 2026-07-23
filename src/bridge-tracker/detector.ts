import { BridgeEvent, Chain, DetectionResult } from './types';
import { BRIDGE_CONTRACTS } from './config';
import { logger } from '../logger';

const WORMHOLE_TOPIC = '0x6eb224fb001ed210e379b335eef0b72c19e0c2d0cf80e2c6c7a26c5a8e7f5d6a';
const AXELAR_TOKEN_SENT_TOPIC = '0x9d1e4e2c2e5c0e5c7e3b3f8e5d6c4b3a2f1e0d9c8b7a6f5e4d3c2b1a0f9e8d';
const ALLBRIDGE_TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const STARGATE_SWAP_TOPIC = '0x8e5e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e';

interface ParsedEvent {
  transactionHash: string;
  blockNumber: number;
  address: string;
  topics: string[];
  data: string;
}

function decodeHexWithPadding(hex: string): string {
  const cleaned = hex.startsWith('0x') ? hex.slice(2) : hex;
  let result = '';
  for (let i = 0; i < cleaned.length; i += 2) {
    const code = parseInt(cleaned.substring(i, i + 2), 16);
    if (code >= 32 && code <= 126) result += String.fromCharCode(code);
  }
  return result.trim();
}

function parseAddressFromTopic(topic: string): string {
  const clean = topic.startsWith('0x') ? topic : `0x${topic}`;
  const padded = clean.padStart(66, '0');
  return `0x${padded.slice(26)}`;
}

function parseEventData(data: string, types: string[]): Record<string, string> {
  const clean = data.startsWith('0x') ? data.slice(2) : data;
  const result: Record<string, string> = {};
  let offset = 0;

  for (const type of types) {
    if (type === 'address') {
      result[type] = `0x${clean.slice(offset, offset + 40)}`;
      offset += 64;
    } else if (type === 'uint256') {
      result[type] = BigInt(`0x${clean.slice(offset, offset + 64)}`).toString();
      offset += 64;
    } else if (type === 'bytes32') {
      result[type] = `0x${clean.slice(offset, offset + 64)}`;
      offset += 64;
    } else {
      offset += 64;
    }
  }
  return result;
}

function detectWormhole(events: ParsedEvent[]): BridgeEvent[] {
  const results: BridgeEvent[] = [];
  for (const event of events) {
    if (!event.topics[0]?.toLowerCase().includes('logmessagepublished')) continue;
    const contract = BRIDGE_CONTRACTS.find(
      (c) => c.address.toLowerCase() === event.address.toLowerCase() && c.protocol === 'wormhole',
    );
    if (!contract) continue;

    const data = parseEventData(event.data, ['uint256', 'uint256', 'bytes32']);
    const sender = parseAddressFromTopic(event.topics[1] || '');
    const receiver = parseAddressFromTopic(event.topics[2] || '');

    const destChainId = parseInt(data['uint256'] || '0', 10);
    const destChainMap: Record<number, Chain> = {
      2: 'ethereum',
      4: 'bsc',
      6: 'polygon',
      1: 'solana',
      7: 'avalanche',
      23: 'arbitrum',
      24: 'optimism',
    };
    const destinationChain: Chain = destChainMap[destChainId] || 'ethereum';

    results.push({
      transactionHash: event.transactionHash,
      sourceChain: contract.chain,
      destinationChain,
      asset: 'WORMHOLE_WRAPPED',
      amount: data['uint256'] || '0',
      sender,
      recipient: receiver,
      protocol: 'wormhole',
      blockNumber: event.blockNumber,
    });
  }
  return results;
}

function detectAxelar(events: ParsedEvent[]): BridgeEvent[] {
  const results: BridgeEvent[] = [];
  for (const event of events) {
    const topic0 = event.topics[0]?.toLowerCase() || '';
    if (!topic0.includes('tokensent') && !topic0.includes('contractcall')) continue;
    const contract = BRIDGE_CONTRACTS.find(
      (c) => c.address.toLowerCase() === event.address.toLowerCase() && c.protocol === 'axelar',
    );
    if (!contract) continue;

    const data = parseEventData(event.data, ['bytes32', 'bytes32', 'uint256']);
    const sender = parseAddressFromTopic(event.topics[1] || '');

    results.push({
      transactionHash: event.transactionHash,
      sourceChain: contract.chain,
      destinationChain: contract.chain === 'ethereum' ? 'cosmos' : 'ethereum',
      asset: decodeHexWithPadding(event.topics[2] || ''),
      amount: data['uint256'] || '0',
      sender,
      recipient: decodeHexWithPadding(data['bytes32'] || ''),
      protocol: 'axelar',
      blockNumber: event.blockNumber,
    });
  }
  return results;
}

function detectAllbridge(events: ParsedEvent[]): BridgeEvent[] {
  const results: BridgeEvent[] = [];
  const transferEvents = events.filter(
    (e) => e.topics[0]?.toLowerCase() === ALLBRIDGE_TRANSFER_TOPIC.toLowerCase(),
  );
  if (transferEvents.length === 0) return results;

  const contractAddresses = new Set(
    BRIDGE_CONTRACTS.filter((c) => c.protocol === 'allbridge').map((c) => c.address.toLowerCase()),
  );

  for (const event of transferEvents) {
    if (!contractAddresses.has(event.address.toLowerCase())) continue;
    const contract = BRIDGE_CONTRACTS.find(
      (c) => c.address.toLowerCase() === event.address.toLowerCase(),
    );
    if (!contract) continue;

    const sender = parseAddressFromTopic(event.topics[1] || '');
    const recipient = parseAddressFromTopic(event.topics[2] || '');
    const amount = BigInt(event.data.startsWith('0x') ? event.data : `0x${event.data}`).toString();

    results.push({
      transactionHash: event.transactionHash,
      sourceChain: contract.chain,
      destinationChain: contract.chain === 'ethereum' ? 'solana' : 'ethereum',
      asset: 'ALLBRIDGE_TOKEN',
      amount,
      sender,
      recipient,
      protocol: 'allbridge',
      blockNumber: event.blockNumber,
    });
  }
  return results;
}

function detectStargate(events: ParsedEvent[]): BridgeEvent[] {
  const results: BridgeEvent[] = [];
  for (const event of events) {
    const topic0 = event.topics[0]?.toLowerCase() || '';
    if (!topic0.includes('swap') && !topic0.includes('swapremote')) continue;
    const contract = BRIDGE_CONTRACTS.find(
      (c) => c.address.toLowerCase() === event.address.toLowerCase() && c.protocol === 'stargate',
    );
    if (!contract) continue;

    const data = parseEventData(event.data, ['uint256', 'uint256', 'uint256', 'address']);
    const amount = data['uint256'] || '0';
    const sender = parseAddressFromTopic(event.topics[1] || '');
    const chainIdMap: Record<number, Chain> = {
      101: 'ethereum',
      102: 'bsc',
      106: 'polygon',
      109: 'avalanche',
      110: 'arbitrum',
      111: 'optimism',
    };
    const destChainId = parseInt(event.topics[2] || '0', 16);
    const destinationChain: Chain = chainIdMap[destChainId] || 'ethereum';

    results.push({
      transactionHash: event.transactionHash,
      sourceChain: contract.chain,
      destinationChain,
      asset: 'STARGATE_TOKEN',
      amount,
      sender,
      recipient: data['address'] || sender,
      protocol: 'stargate',
      blockNumber: event.blockNumber,
    });
  }
  return results;
}

export async function detectBridgeTransactions(
  events: Array<{
    transactionHash: string;
    blockNumber: number;
    contractAddress: string;
    topic0?: string;
    topics: string[];
    data: string;
  }>,
): Promise<DetectionResult> {
  const parsed: ParsedEvent[] = events.map((e) => ({
    transactionHash: e.transactionHash,
    blockNumber: e.blockNumber,
    address: e.contractAddress,
    topics: e.topics,
    data: e.data,
  }));

  const results: BridgeEvent[] = [
    ...detectWormhole(parsed),
    ...detectAxelar(parsed),
    ...detectAllbridge(parsed),
    ...detectStargate(parsed),
  ];

  if (results.length > 0) {
    logger.info(`Bridge detector: found ${results.length} bridge event(s)`, {
      protocols: [...new Set(results.map((r) => r.protocol))],
    });
  }

  return {
    detected: results.length > 0,
    protocol: results.length > 0 ? results[0].protocol : undefined,
    events: results,
  };
}

export async function scanBlockForBridges(
  blockNumber: number,
  blockEvents: Array<{
    transactionHash: string;
    contractAddress: string;
    topics: string[];
    data: string;
  }>,
): Promise<BridgeEvent[]> {
  const knownContracts = new Set(BRIDGE_CONTRACTS.map((c) => c.address.toLowerCase()));
  const relevantEvents = blockEvents.filter((e) =>
    knownContracts.has(e.contractAddress.toLowerCase()),
  );

  if (relevantEvents.length === 0) return [];

  const parsed: ParsedEvent[] = relevantEvents.map((e) => ({
    transactionHash: e.transactionHash,
    blockNumber,
    address: e.contractAddress,
    topics: e.topics,
    data: e.data,
  }));

  return [
    ...detectWormhole(parsed),
    ...detectAxelar(parsed),
    ...detectAllbridge(parsed),
    ...detectStargate(parsed),
  ];
}

export { ParsedEvent };
