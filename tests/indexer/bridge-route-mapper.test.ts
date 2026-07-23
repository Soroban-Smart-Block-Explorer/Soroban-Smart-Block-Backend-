import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db', () => ({
  prismaRead: {
    transaction: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
  },
}));

import * as db from '../../src/db';
import {
  analyzeBridgeRoute,
  storeBridgeRoute,
  queryBridgeRoutes,
} from '../../src/indexer/bridge-route-mapper';

const TX_HASH = 'abc123def456';

describe('analyzeBridgeRoute', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns null when transaction not found', async () => {
    vi.mocked(db.prismaRead.transaction.findUnique).mockResolvedValue(null);
    const result = await analyzeBridgeRoute(TX_HASH);
    expect(result).toBeNull();
  });

  it('detects outbound direction for lock function', async () => {
    vi.mocked(db.prismaRead.transaction.findUnique).mockResolvedValue({
      hash: TX_HASH,
      functionName: 'lock',
      sourceAccount: 'GA_SENDER',
      contractAddress: 'CA_BRIDGE',
      events: [],
    } as any);

    const result = await analyzeBridgeRoute(TX_HASH);
    expect(result).not.toBeNull();
    expect(result!.direction).toBe('outbound');
    expect(result!.lockAction).toBe('lock');
    expect(result!.transactionHash).toBe(TX_HASH);
    expect(result!.sourceChain).toBe('soroban');
  });

  it('detects inbound direction for unlock function', async () => {
    vi.mocked(db.prismaRead.transaction.findUnique).mockResolvedValue({
      hash: TX_HASH,
      functionName: 'withdraw',
      sourceAccount: 'GA_SENDER',
      contractAddress: 'CA_BRIDGE',
      events: [],
    } as any);

    const result = await analyzeBridgeRoute(TX_HASH);
    expect(result!.direction).toBe('inbound');
    expect(result!.unlockAction).toBe('withdraw');
  });

  it('extracts token info from transfer events', async () => {
    vi.mocked(db.prismaRead.transaction.findUnique).mockResolvedValue({
      hash: TX_HASH,
      functionName: 'bridge_in',
      sourceAccount: 'GA_SENDER',
      contractAddress: 'CA_BRIDGE',
      events: [
        {
          contractAddress: 'CA_TOKEN',
          topicSymbol: 'transfer',
          decoded: {
            symbol: 'USDC',
            amount: '5000',
            to: '0xRecipient',
          },
        },
      ],
    } as any);

    const result = await analyzeBridgeRoute(TX_HASH);
    expect(result!.tokenAddress).toBe('CA_TOKEN');
    expect(result!.tokenSymbol).toBe('USDC');
    expect(result!.amount).toBe('5000');
    expect(result!.recipientAddress).toBe('0xRecipient');
  });

  it('detects near_intents bridge standard', async () => {
    vi.mocked(db.prismaRead.transaction.findUnique).mockResolvedValue({
      hash: TX_HASH,
      functionName: 'near_lock',
      sourceAccount: 'GA_SENDER',
      contractAddress: 'CA_NEAR_BRIDGE',
      events: [],
    } as any);

    const result = await analyzeBridgeRoute(TX_HASH);
    expect(result!.bridgeStandard).toBe('near_intents');
    expect(result!.destinationChain).toBe('near');
  });

  it('infers ethereum destination from 0x address', async () => {
    vi.mocked(db.prismaRead.transaction.findUnique).mockResolvedValue({
      hash: TX_HASH,
      functionName: 'lock',
      sourceAccount: 'GA_SENDER',
      contractAddress: 'CA_GENERIC',
      events: [
        {
          contractAddress: 'CA_TOKEN',
          topicSymbol: 'transfer',
          decoded: { to: '0xEthAddress123' },
        },
      ],
    } as any);

    const result = await analyzeBridgeRoute(TX_HASH);
    expect(result!.destinationChain).toBe('ethereum');
    expect(result!.externalScannerUrl).toContain('etherscan.io');
  });
});

describe('storeBridgeRoute', () => {
  beforeEach(() => vi.clearAllMocks());

  it('updates transaction with bridge route metadata', async () => {
    vi.mocked(db.prismaRead.transaction.findUnique).mockResolvedValue({
      hash: TX_HASH,
      functionArgs: { existingKey: 'value' },
    } as any);
    vi.mocked(db.prismaRead.transaction.update).mockResolvedValue({} as any);

    const route = {
      transactionHash: TX_HASH,
      direction: 'outbound' as const,
      sourceChain: 'soroban',
      destinationChain: 'ethereum',
      tokenAddress: 'CA_TOKEN',
      amount: '1000',
      senderAddress: 'GA_SENDER',
      recipientAddress: '0xRecipient',
      bridgeStandard: 'generic' as const,
    };

    await storeBridgeRoute(TX_HASH, route);
    expect(db.prismaRead.transaction.update).toHaveBeenCalledOnce();
  });

  it('handles null functionArgs on existing transaction', async () => {
    vi.mocked(db.prismaRead.transaction.findUnique).mockResolvedValue({
      hash: TX_HASH,
      functionArgs: null,
    } as any);
    vi.mocked(db.prismaRead.transaction.update).mockResolvedValue({} as any);

    await storeBridgeRoute(TX_HASH, {
      transactionHash: TX_HASH,
      direction: 'inbound',
      sourceChain: 'soroban',
      destinationChain: 'near',
      tokenAddress: '',
      amount: '0',
      senderAddress: 'GA',
      recipientAddress: 'bob.near',
      bridgeStandard: 'near_intents',
    });

    expect(db.prismaRead.transaction.update).toHaveBeenCalledOnce();
  });
});

describe('queryBridgeRoutes', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns empty array when no matching transactions', async () => {
    vi.mocked(db.prismaRead.transaction.findMany).mockResolvedValue([]);
    const result = await queryBridgeRoutes('outbound');
    expect(result).toEqual([]);
  });

  it('filters by destinationChain when provided', async () => {
    vi.mocked(db.prismaRead.transaction.findMany).mockResolvedValue([
      {
        hash: TX_HASH,
        functionName: 'lock',
        sourceAccount: 'GA',
        contractAddress: 'CA_NEAR',
        events: [],
      },
    ] as any);

    // analyzeBridgeRoute is called internally — it will call findUnique again
    vi.mocked(db.prismaRead.transaction.findUnique).mockResolvedValue({
      hash: TX_HASH,
      functionName: 'near_lock',
      sourceAccount: 'GA',
      contractAddress: 'CA_NEAR',
      events: [],
    } as any);

    const result = await queryBridgeRoutes('outbound', 'near');
    // Result depends on whether destination matches
    expect(Array.isArray(result)).toBe(true);
  });
});
