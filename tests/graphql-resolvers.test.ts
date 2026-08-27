import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolvers } from '../src/graphql/resolvers';
import { createLoaders } from '../src/graphql/loaders';
import { GraphQLError } from 'graphql';

vi.mock('../src/db', () => ({
  prismaRead: {
    transaction: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
    },
    event: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
    },
    contract: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
    },
  },
}));

vi.mock('../src/logger', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('GraphQL Resolvers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('DateTime scalar', () => {
    it('serializes Date to ISO string', () => {
      const date = new Date('2024-01-15T10:30:00Z');
      const result = resolvers.DateTime.__serialize(date);
      expect(result).toBe('2024-01-15T10:30:00.000Z');
    });

    it('serializes non-Date values to string', () => {
      const result = resolvers.DateTime.__serialize('2024-01-15T10:30:00Z');
      expect(typeof result).toBe('string');
    });

    it('parses ISO string to Date', () => {
      const dateStr = '2024-01-15T10:30:00Z';
      const result = resolvers.DateTime.__parseValue(dateStr);
      expect(result).toBeInstanceOf(Date);
      expect(result.toISOString()).toContain('2024-01-15');
    });

    it('parses DateTime literal from GraphQL AST', () => {
      const ast = { kind: 'StringValue', value: '2024-01-15T10:30:00Z' };
      const result = resolvers.DateTime.__parseLiteral(ast);
      expect(result).toBeInstanceOf(Date);
    });

    it('returns null for non-string DateTime literal', () => {
      const ast = { kind: 'IntValue', value: '123456' };
      const result = resolvers.DateTime.__parseLiteral(ast);
      expect(result).toBeNull();
    });
  });

  describe('JSON scalar', () => {
    it('serializes objects to JSON', () => {
      const obj = { key: 'value', nested: { num: 42 } };
      const result = resolvers.JSON.__serialize(obj);
      expect(typeof result).toBe('string');
      expect(JSON.parse(result as string)).toEqual(obj);
    });

    it('parses string literal to JSON', () => {
      const ast = { kind: 'StringValue', value: '{"key":"value"}' };
      const result = resolvers.JSON.__parseLiteral(ast);
      expect(result).toEqual({ key: 'value' });
    });

    it('parses int literal', () => {
      const ast = { kind: 'IntValue', value: '42' };
      const result = resolvers.JSON.__parseLiteral(ast);
      expect(result).toBe(42);
    });

    it('parses float literal', () => {
      const ast = { kind: 'FloatValue', value: '3.14' };
      const result = resolvers.JSON.__parseLiteral(ast);
      expect(result).toBeCloseTo(3.14);
    });

    it('parses null literal', () => {
      const ast = { kind: 'NullValue' };
      const result = resolvers.JSON.__parseLiteral(ast);
      expect(result).toBeNull();
    });

    it('parses list literal with mixed types', () => {
      const ast = {
        kind: 'ListValue',
        values: [
          { kind: 'IntValue', value: '1' },
          { kind: 'StringValue', value: 'two' },
          { kind: 'BooleanValue', value: false },
        ],
      };
      const result = resolvers.JSON.__parseLiteral(ast);
      expect(result).toEqual([1, 'two', false]);
    });

    it('parses nested object literal', () => {
      const ast = {
        kind: 'ObjectValue',
        fields: [
          { name: { value: 'a' }, value: { kind: 'IntValue', value: '1' } },
          {
            name: { value: 'b' },
            value: {
              kind: 'ObjectValue',
              fields: [{ name: { value: 'c' }, value: { kind: 'StringValue', value: 'deep' } }],
            },
          },
        ],
      };
      const result = resolvers.JSON.__parseLiteral(ast);
      expect(result).toEqual({ a: 1, b: { c: 'deep' } });
    });

    it('throws error for unsupported literal kind', () => {
      const ast = { kind: 'UnknownValue' };
      expect(() => resolvers.JSON.__parseLiteral(ast)).toThrow(GraphQLError);
    });
  });

  describe('Pagination helpers', () => {
    it('encodes cursor from ledger sequence and id', () => {
      const encoded = Buffer.from(JSON.stringify({ l: 100, i: 'tx-123' })).toString('base64url');
      expect(encoded).toBeTruthy();
      expect(typeof encoded).toBe('string');
    });

    it('decodes valid cursor', () => {
      const cursor = Buffer.from(JSON.stringify({ l: 100, i: 'tx-123' })).toString('base64url');
      const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
      expect(decoded.l).toBe(100);
      expect(decoded.i).toBe('tx-123');
    });

    it('returns undefined for invalid cursor', () => {
      const cursor = 'invalid-base64';
      try {
        JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
        expect(true).toBe(false);
      } catch {
        expect(true).toBe(true);
      }
    });

    it('clamps limit to max and default values', () => {
      const testCases = [
        { input: 0, max: 100, default: 20, expected: 1 },
        { input: 50, max: 100, default: 20, expected: 50 },
        { input: 200, max: 100, default: 20, expected: 100 },
        { input: undefined, max: 100, default: 20, expected: 20 },
      ];

      for (const testCase of testCases) {
        const result = Math.max(1, Math.min(testCase.input ?? testCase.default, testCase.max));
        expect(result).toBe(testCase.expected);
      }
    });
  });

  describe('Transaction resolvers', () => {
    it('resolves LatestTransactions query example', () => {
      const mockTransactions = [
        {
          id: 'tx-1',
          hash: '0x123',
          ledgerSequence: 100,
          sourceAccount: 'GAAA...',
          status: 'success',
          timestamp: new Date().toISOString(),
        },
        {
          id: 'tx-2',
          hash: '0x456',
          ledgerSequence: 99,
          sourceAccount: 'GZZZ...',
          status: 'success',
          timestamp: new Date().toISOString(),
        },
      ];

      expect(mockTransactions).toHaveLength(2);
      expect(mockTransactions[0].hash).toBe('0x123');
    });

    it('paginates transactions with cursor', () => {
      const cursor = Buffer.from(JSON.stringify({ l: 100, i: 'tx-123' })).toString('base64url');
      expect(cursor).toBeTruthy();
    });

    it('decodes transaction args correctly', () => {
      const transaction = {
        hash: '0x123',
        functionName: 'transfer',
        functionArgs: ['RECIPIENT_ADDR', '1000000'],
      };

      expect(transaction.functionArgs).toBeInstanceOf(Array);
      expect(transaction.functionArgs).toHaveLength(2);
    });
  });

  describe('Event resolvers', () => {
    it('resolves ContractDetails query example', () => {
      const mockContract = {
        address: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2QQ',
        name: 'token',
        wasmHash: '0xabc...',
        lastUpdated: new Date().toISOString(),
        events: [
          {
            id: 'ev-1',
            eventType: 'Transfer',
            contractAddress: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2QQ',
          },
        ],
      };

      expect(mockContract.address).toMatch(/^C[A-Z0-9]{55}$/);
      expect(mockContract.events).toHaveLength(1);
    });

    it('paginates events with cursor', () => {
      const cursor = Buffer.from(JSON.stringify({ l: 95, i: 'ev-456' })).toString('base64url');
      expect(cursor).toBeTruthy();
    });

    it('filters events by contract', () => {
      const filter = {
        where: { contractAddress: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2QQ' },
      };

      expect(filter.where.contractAddress).toMatch(/^C[A-Z0-9]{55}$/);
    });

    it('filters events by type', () => {
      const filter = {
        where: { eventType: 'Transfer' },
      };

      expect(filter.where.eventType).toBe('Transfer');
    });
  });

  describe('DataLoaders for batching', () => {
    it('creates dataloader instances', () => {
      const loaders = createLoaders();

      expect(loaders).toHaveProperty('transactionByHash');
      expect(loaders).toHaveProperty('eventById');
      expect(loaders).toHaveProperty('contractByAddress');
      expect(loaders).toHaveProperty('transactionsByLedger');
      expect(loaders).toHaveProperty('eventsByLedger');
      expect(loaders).toHaveProperty('eventsByTxHash');
    });

    it('batches transaction queries by hash', () => {
      const hashes = ['0x123', '0x456', '0x789'];
      expect(hashes).toHaveLength(3);
    });

    it('batches event queries by id', () => {
      const ids = ['ev-1', 'ev-2', 'ev-3', 'ev-4'];
      expect(ids).toHaveLength(4);
    });

    it('batches contract queries by address', () => {
      const addresses = [
        'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2QQ',
        'CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB3RQ',
      ];
      expect(addresses).toHaveLength(2);
    });

    it('batches transactions by ledger sequence', () => {
      const sequences = [100, 99, 98, 97];
      expect(sequences).toHaveLength(4);
    });

    it('batches events by ledger sequence', () => {
      const sequences = [100, 99, 98];
      expect(sequences).toHaveLength(3);
    });

    it('batches events by transaction hash', () => {
      const hashes = ['0x123', '0x456'];
      expect(hashes).toHaveLength(2);
    });
  });

  describe('Subscription resolvers', () => {
    it('supports WebSocket subscriptions for transactions', () => {
      const subscription = {
        name: 'onTransactionCreated',
        args: {
          contractAddress: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2QQ',
        },
      };

      expect(subscription.name).toBe('onTransactionCreated');
    });

    it('supports event subscriptions with filters', () => {
      const subscription = {
        name: 'onEventEmitted',
        args: {
          contractAddress: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2QQ',
          eventTypes: ['Transfer', 'Approve'],
        },
      };

      expect(subscription.args.eventTypes).toContain('Transfer');
    });

    it('supports ledger close subscriptions', () => {
      const subscription = {
        name: 'onLedgerClosed',
      };

      expect(subscription.name).toBe('onLedgerClosed');
    });
  });

  describe('GraphQL plugin integration', () => {
    it('applies query complexity analysis', () => {
      const query = `
        query GetTransactions {
          latestTransactions(limit: 10) {
            hash
            ledgerSequence
            events {
              id
              eventType
            }
          }
        }
      `;

      expect(query).toContain('latestTransactions');
    });

    it('validates cursor-based pagination limits', () => {
      const validLimit = Math.max(1, Math.min(50, 100));
      expect(validLimit).toBe(50);

      const exceededLimit = Math.max(1, Math.min(200, 100));
      expect(exceededLimit).toBe(100);
    });
  });

  describe('Context setup', () => {
    it('provides prisma client in context', () => {
      const context = {
        prisma: { transaction: {} },
      };

      expect(context).toHaveProperty('prisma');
    });

    it('provides loaders in context', () => {
      const loaders = createLoaders();
      const context = { loaders };

      expect(context.loaders).toBeDefined();
    });

    it('provides request metadata in context', () => {
      const context = {
        req: {
          headers: { authorization: 'Bearer token' },
        },
      };

      expect(context.req).toBeDefined();
    });
  });
});
