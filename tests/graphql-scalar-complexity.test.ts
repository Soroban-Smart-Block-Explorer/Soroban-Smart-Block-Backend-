import { describe, it, expect } from 'vitest';
import { parse } from 'graphql';

// ── JSON scalar parseLiteral ──────────────────────────────────────────────────

// Import the internal helper indirectly by exercising the resolver map.
// We test the scalar by calling __parseLiteral directly via the resolvers export.
import { resolvers } from '../src/graphql/resolvers';
import { GraphQLError } from 'graphql';

const jsonScalar = (resolvers as any).JSON;

describe('JSON scalar __parseLiteral', () => {
  it('parses a string literal', () => {
    expect(jsonScalar.__parseLiteral({ kind: 'StringValue', value: 'hello' })).toBe('hello');
  });

  it('parses an int literal', () => {
    expect(jsonScalar.__parseLiteral({ kind: 'IntValue', value: '42' })).toBe(42);
  });

  it('parses a float literal', () => {
    expect(jsonScalar.__parseLiteral({ kind: 'FloatValue', value: '3.14' })).toBeCloseTo(3.14);
  });

  it('parses a boolean literal', () => {
    expect(jsonScalar.__parseLiteral({ kind: 'BooleanValue', value: true })).toBe(true);
  });

  it('parses a null literal', () => {
    expect(jsonScalar.__parseLiteral({ kind: 'NullValue' })).toBeNull();
  });

  it('parses a nested object literal', () => {
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
    expect(jsonScalar.__parseLiteral(ast)).toEqual({ a: 1, b: { c: 'deep' } });
  });

  it('parses a list literal with mixed types', () => {
    const ast = {
      kind: 'ListValue',
      values: [
        { kind: 'IntValue', value: '1' },
        { kind: 'StringValue', value: 'two' },
        { kind: 'BooleanValue', value: false },
        { kind: 'NullValue' },
      ],
    };
    expect(jsonScalar.__parseLiteral(ast)).toEqual([1, 'two', false, null]);
  });

  it('throws GraphQLError for unsupported literal kinds', () => {
    expect(() => jsonScalar.__parseLiteral({ kind: 'EnumValue', value: 'SOME_ENUM' })).toThrow(
      GraphQLError,
    );
  });
});

// ── Complexity plugin ─────────────────────────────────────────────────────────

// Access calculateComplexity via the plugin by calling onExecute with a fake
// document and checking that the error threshold is respected.

import { complexityPlugin } from '../src/graphql/plugins';

function makeDoc(query: string) {
  return parse(query);
}

// Re-export internal for testing by parsing a document and simulating execution.
// We test indirectly: a fragment-spread query should trigger the limit if costly.

describe('complexityPlugin — fragment spread resolution', () => {
  it('counts fields inside named fragments', () => {
    // A fragment with 10 fields used 10 times would exceed a low limit.
    // We check that the plugin does NOT pass silently for an expensive fragment query.
    const doc = makeDoc(`
      fragment ExpensiveFields on Query {
        f1 f2 f3 f4 f5
      }
      query {
        ...ExpensiveFields
        ...ExpensiveFields
        ...ExpensiveFields
      }
    `);
    // With old code, FragmentSpread.selectionSet is undefined so cost = 0; plugin passes.
    // With new code, fragments are resolved and cost = 5 fields * 3 spreads * depth 1 = 15.
    // We verify onExecute throws when MAX_COMPLEXITY is set very low.
    const origEnv = process.env.GQL_MAX_COMPLEXITY;
    process.env.GQL_MAX_COMPLEXITY = '1';
    expect(() => (complexityPlugin as any).onExecute({ args: { document: doc } })).toThrow(
      'Query too complex',
    );
    process.env.GQL_MAX_COMPLEXITY = origEnv ?? '1000';
  });

  it('protects against circular fragment references without infinite loop', () => {
    // Circular references are syntactically invalid in GraphQL but we guard anyway.
    // We manually construct a doc-like object with a cycle.
    const fakeDoc = {
      definitions: [
        {
          kind: 'OperationDefinition',
          selectionSet: {
            selections: [{ kind: 'FragmentSpread', name: { value: 'A' } }],
          },
        },
        {
          kind: 'FragmentDefinition',
          name: { value: 'A' },
          selectionSet: {
            selections: [{ kind: 'FragmentSpread', name: { value: 'B' } }],
          },
        },
        {
          kind: 'FragmentDefinition',
          name: { value: 'B' },
          selectionSet: {
            selections: [{ kind: 'FragmentSpread', name: { value: 'A' } }],
          },
        },
      ],
    };
    // Must complete without hanging or throwing a stack overflow.
    expect(() =>
      (complexityPlugin as any).onExecute({ args: { document: fakeDoc } }),
    ).not.toThrow();
  });
});

describe('complexityPlugin — list multipliers', () => {
  it('applies limit argument as a cost multiplier', () => {
    // A query requesting limit:100 should cost 100x more than limit:1.
    const highFanOut = makeDoc(`
      query {
        transactions(limit: 100) {
          hash
          status
        }
      }
    `);
    const lowFanOut = makeDoc(`
      query {
        transactions(limit: 1) {
          hash
          status
        }
      }
    `);
    // Set a limit that the low-fan-out query passes but the high one fails.
    const origEnv = process.env.GQL_MAX_COMPLEXITY;
    process.env.GQL_MAX_COMPLEXITY = '50';
    expect(() => (complexityPlugin as any).onExecute({ args: { document: highFanOut } })).toThrow(
      'Query too complex',
    );
    expect(() =>
      (complexityPlugin as any).onExecute({ args: { document: lowFanOut } }),
    ).not.toThrow();
    process.env.GQL_MAX_COMPLEXITY = origEnv ?? '1000';
  });
});

// ── Webhook HTTPS enforcement ─────────────────────────────────────────────────

import express from 'express';
import request from 'supertest';
import { vi } from 'vitest';

vi.mock('../src/db', () => ({
  prismaWrite: {
    webhookSubscription: {
      create: vi.fn().mockResolvedValue({ id: '1', url: 'https://example.com' }),
    },
  },
  prismaRead: { webhookSubscription: { findMany: vi.fn().mockResolvedValue([]) } },
}));

vi.mock('../src/webhooks/ssrf-guard', () => ({
  assertSafeUrl: vi.fn().mockResolvedValue(undefined),
  SsrfBlockedError: class SsrfBlockedError extends Error {},
}));

import { webhooksRouter } from '../src/api/webhooks';

const app = express();
app.use(express.json());
app.use('/webhooks', webhooksRouter);

describe('webhook URL HTTPS enforcement', () => {
  it('rejects plain HTTP URLs', async () => {
    const res = await request(app).post('/webhooks').send({ url: 'http://example.com/hook' });
    expect(res.status).toBe(400);
  });

  it('accepts HTTPS URLs', async () => {
    const res = await request(app).post('/webhooks').send({ url: 'https://example.com/hook' });
    expect(res.status).toBe(201);
  });

  it('returns a clear validation error for HTTP URLs', async () => {
    const res = await request(app).post('/webhooks').send({ url: 'http://evil.com/steal' });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/HTTPS/i);
  });
});
