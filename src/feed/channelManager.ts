import { prismaWrite as prisma } from '../db';

export interface ChannelConfig {
  name: string;
  description?: string;
  category: 'transaction' | 'event' | 'ledger' | 'derived';
  schema: object;
  retentionDays?: number;
  enabled?: boolean;
}

export class ChannelManager {
  private static channels = new Map<string, ChannelConfig>();

  static async initializeDefaultChannels() {
    const defaultChannels: ChannelConfig[] = [
      {
        name: 'transactions',
        description: 'Full decoded transaction with args, events, footprints',
        category: 'transaction',
        schema: {
          type: 'object',
          properties: {
            hash: { type: 'string' },
            ledgerSequence: { type: 'number' },
            timestamp: { type: 'string' },
            sourceAccount: { type: 'string' },
            operations: { type: 'array' },
            status: { type: 'string' },
            fee: { type: 'string' },
          },
        },
      },
      {
        name: 'events',
        description: 'All contract events with decoded data and topic filters',
        category: 'event',
        schema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            contractAddress: { type: 'string' },
            eventType: { type: 'string' },
            decoded: { type: 'object' },
            timestamp: { type: 'string' },
          },
        },
      },
      {
        name: 'ledgers',
        description: 'Ledger metadata (sequence, timestamp, fee pool, tx set)',
        category: 'ledger',
        schema: {
          type: 'object',
          properties: {
            sequence: { type: 'number' },
            hash: { type: 'string' },
            closeTime: { type: 'string' },
            txCount: { type: 'number' },
          },
        },
      },
      {
        name: 'trades',
        description: 'Normalized DEX swap trades',
        category: 'derived',
        schema: {
          type: 'object',
          properties: {
            txHash: { type: 'string' },
            poolAddress: { type: 'string' },
            tokenIn: { type: 'string' },
            tokenOut: { type: 'string' },
            amountIn: { type: 'string' },
            amountOut: { type: 'string' },
            price: { type: 'string' },
            timestamp: { type: 'string' },
          },
        },
      },
      {
        name: 'liquidations',
        description: 'Liquidation events only — filtered high-value stream',
        category: 'event',
        schema: {
          type: 'object',
          properties: {
            txHash: { type: 'string' },
            liquidatedAccount: { type: 'string' },
            liquidator: { type: 'string' },
            collateralAmount: { type: 'string' },
            timestamp: { type: 'string' },
          },
        },
      },
      {
        name: 'metrics',
        description: 'Aggregated metrics (gas price, TPS, active accounts, TVL)',
        category: 'derived',
        schema: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            value: { type: 'number' },
            granularity: { type: 'string' },
            timestamp: { type: 'string' },
          },
        },
      },
      {
        name: 'contracts',
        description: 'New contract deployments and upgrades',
        category: 'event',
        schema: {
          type: 'object',
          properties: {
            address: { type: 'string' },
            eventType: { type: 'string' },
            wasmHash: { type: 'string' },
            deployer: { type: 'string' },
            timestamp: { type: 'string' },
          },
        },
      },
      {
        name: 'accounts',
        description: 'Account activity stream (nonce changes, balance changes)',
        category: 'event',
        schema: {
          type: 'object',
          properties: {
            address: { type: 'string' },
            activityType: { type: 'string' },
            balanceChange: { type: 'string' },
            timestamp: { type: 'string' },
          },
        },
      },
      {
        name: 'oracle',
        description: 'Price oracle updates and deviations',
        category: 'event',
        schema: {
          type: 'object',
          properties: {
            oracleAddress: { type: 'string' },
            priceUpdate: { type: 'number' },
            deviation: { type: 'number' },
            timestamp: { type: 'string' },
          },
        },
      },
      {
        name: 'governance',
        description: 'Proposal creation, voting, execution events',
        category: 'event',
        schema: {
          type: 'object',
          properties: {
            contractAddress: { type: 'string' },
            proposalId: { type: 'string' },
            eventType: { type: 'string' },
            voter: { type: 'string' },
            timestamp: { type: 'string' },
          },
        },
      },
    ];

    for (const channel of defaultChannels) {
      await this.registerChannel(channel);
      this.channels.set(channel.name, channel);
    }
  }

  static async registerChannel(config: ChannelConfig) {
    try {
      await prisma.feedChannel.upsert({
        where: { name: config.name },
        update: {
          description: config.description,
          category: config.category,
          schema: config.schema,
          retentionDays: config.retentionDays ?? 30,
          enabled: config.enabled ?? true,
        },
        create: {
          name: config.name,
          description: config.description,
          category: config.category,
          schema: config.schema,
          retentionDays: config.retentionDays ?? 30,
          enabled: config.enabled ?? true,
        },
      });
    } catch (error) {
      console.error(`Failed to register channel ${config.name}:`, error);
    }
  }

  static async getChannels() {
    return Array.from(this.channels.values());
  }

  static getChannel(name: string) {
    return this.channels.get(name);
  }

  static isValidChannel(name: string) {
    return this.channels.has(name);
  }
}
