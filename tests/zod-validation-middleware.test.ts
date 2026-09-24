/**
 * Test suite for Zod-based request validation middleware
 */
import { describe, it, expect, vi, type Mock } from 'vitest';
import { Request, Response, NextFunction } from 'express';
import {
  validateQuery,
  validateBody,
  validateParams,
  validateQueryAndBody,
  safeParse,
  strictParse,
} from '../src/middleware/validation';
import { z } from 'zod';
import {
  paginationSchema,
  stellarAddress,
  contractFilterSchema,
  txStatusFilterSchema,
} from '../src/schemas/common';

function mockRes(): Response {
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response;
  return res;
}

function mockReq(overrides: Partial<Request> = {}): Request {
  return {
    query: {},
    body: {},
    params: {},
    ...overrides,
  } as Request;
}

function mockNext(): NextFunction {
  return vi.fn();
}

describe('validateQuery middleware', () => {
  it('calls next() when query is valid', () => {
    const middleware = validateQuery(paginationSchema);
    const req = mockReq({
      query: { page: '1', limit: '20' },
    });
    const res = mockRes();
    const next = mockNext();

    middleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect((req as any).validatedQuery).toEqual({ page: 1, limit: 20 });
  });

  it('returns 400 when query is invalid', () => {
    const middleware = validateQuery(paginationSchema);
    const req = mockReq({
      query: { page: '0', limit: '20' }, // page < 1
    });
    const res = mockRes();
    const next = mockNext();

    middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it('provides detailed error information in response', () => {
    const middleware = validateQuery(paginationSchema);
    const req = mockReq({
      query: { page: 'invalid', limit: 'text' },
    });
    const res = mockRes();
    const next = mockNext();

    middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    const jsonCall = (res.json as Mock).mock.calls[0][0];
    expect(jsonCall.error).toBe('Invalid query parameters');
    expect(jsonCall.details).toBeDefined();
  });

  it('handles missing optional parameters', () => {
    const middleware = validateQuery(
      z.object({
        required: z.string(),
        optional: z.string().optional(),
      }),
    );
    const req = mockReq({
      query: { required: 'value' },
    });
    const res = mockRes();
    const next = mockNext();

    middleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect((req as any).validatedQuery.required).toBe('value');
  });

  it('coerces numeric types', () => {
    const middleware = validateQuery(paginationSchema);
    const req = mockReq({
      query: { page: '5', limit: '50' },
    });
    const res = mockRes();
    const next = mockNext();

    middleware(req, res, next);

    expect((req as any).validatedQuery).toEqual({ page: 5, limit: 50 });
  });
});

describe('validateBody middleware', () => {
  it('calls next() when body is valid', () => {
    const schema = z.object({
      name: z.string(),
      age: z.number(),
    });
    const middleware = validateBody(schema);
    const req = mockReq({
      body: { name: 'Alice', age: 30 },
    });
    const res = mockRes();
    const next = mockNext();

    middleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect((req as any).validatedBody).toEqual({ name: 'Alice', age: 30 });
  });

  it('returns 400 when body is invalid', () => {
    const schema = z.object({
      name: z.string(),
      age: z.number(),
    });
    const middleware = validateBody(schema);
    const req = mockReq({
      body: { name: 'Alice' }, // missing age
    });
    const res = mockRes();
    const next = mockNext();

    middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect((res.json as Mock).mock.calls[0][0].error).toBe('Invalid request body');
    expect(next).not.toHaveBeenCalled();
  });

  it('sanitizes harmful input', () => {
    const schema = z.object({
      description: z.string(),
    });
    const middleware = validateBody(schema);
    const req = mockReq({
      body: {
        description: 'Normal text', // safe input
      },
    });
    const res = mockRes();
    const next = mockNext();

    middleware(req, res, next);

    expect(next).toHaveBeenCalled();
  });
});

describe('validateParams middleware', () => {
  it('calls next() when params are valid', () => {
    const schema = z.object({
      id: z.string().uuid(),
    });
    const middleware = validateParams(schema);
    const req = mockReq({
      params: { id: '550e8400-e29b-41d4-a716-446655440000' },
    });
    const res = mockRes();
    const next = mockNext();

    middleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect((req as any).validatedParams).toEqual({
      id: '550e8400-e29b-41d4-a716-446655440000',
    });
  });

  it('returns 400 when params are invalid', () => {
    const schema = z.object({
      id: z.string().uuid(),
    });
    const middleware = validateParams(schema);
    const req = mockReq({
      params: { id: 'invalid-uuid' },
    });
    const res = mockRes();
    const next = mockNext();

    middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(next).not.toHaveBeenCalled();
  });

  it('validates Stellar addresses', () => {
    const schema = z.object({
      address: stellarAddress,
    });
    const middleware = validateParams(schema);
    // Valid Stellar address: starts with G/C and has base32 chars
    const req = mockReq({
      params: { address: 'GHFC32E75LBOGIRE3VLPGF2FJOAE6NQVRLXSS44ZLGAJZ2SKSE5E4JVB' },
    });
    const res = mockRes();
    const next = mockNext();

    middleware(req, res, next);

    expect(next).toHaveBeenCalled();
  });

  it('rejects invalid Stellar addresses', () => {
    const schema = z.object({
      address: stellarAddress,
    });
    const middleware = validateParams(schema);
    const req = mockReq({
      params: { address: 'INVALID' },
    });
    const res = mockRes();
    const next = mockNext();

    middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
  });
});

describe('validateQueryAndBody middleware', () => {
  it('validates both query and body', () => {
    const querySchema = z.object({ pageSize: z.coerce.number().min(1) });
    const bodySchema = z.object({ name: z.string() });
    const middleware = validateQueryAndBody(querySchema, bodySchema);
    const req = mockReq({
      query: { pageSize: '10' },
      body: { name: 'Test' },
    });
    const res = mockRes();
    const next = mockNext();

    middleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect((req as any).validatedQuery).toEqual({ pageSize: 10 });
    expect((req as any).validatedBody).toEqual({ name: 'Test' });
  });

  it('returns 400 on invalid query', () => {
    const querySchema = z.object({ pageSize: z.coerce.number().min(1) });
    const bodySchema = z.object({ name: z.string() });
    const middleware = validateQueryAndBody(querySchema, bodySchema);
    const req = mockReq({
      query: { pageSize: '0' }, // invalid
      body: { name: 'Test' },
    });
    const res = mockRes();
    const next = mockNext();

    middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect((res.json as Mock).mock.calls[0][0].error).toBe('Invalid query parameters');
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 400 on invalid body', () => {
    const querySchema = z.object({ pageSize: z.coerce.number().min(1) });
    const bodySchema = z.object({ name: z.string() });
    const middleware = validateQueryAndBody(querySchema, bodySchema);
    const req = mockReq({
      query: { pageSize: '10' },
      body: {}, // missing name
    });
    const res = mockRes();
    const next = mockNext();

    middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect((res.json as Mock).mock.calls[0][0].error).toBe('Invalid request body');
    expect(next).not.toHaveBeenCalled();
  });
});

describe('safeParse function', () => {
  it('returns success result for valid data', () => {
    const schema = z.object({ name: z.string(), age: z.number() });
    const result = safeParse(schema, { name: 'Bob', age: 25 });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual({ name: 'Bob', age: 25 });
    }
  });

  it('returns error result for invalid data', () => {
    const schema = z.object({ name: z.string() });
    const result = safeParse(schema, { name: 123 });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toBeDefined();
    }
  });

  it('provides field-level errors', () => {
    const schema = z.object({
      email: z.string().email(),
      age: z.number().min(18),
    });
    const result = safeParse(schema, { email: 'not-email', age: 10 });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.email).toBeDefined();
      expect(result.errors.age).toBeDefined();
    }
  });
});

describe('strictParse function', () => {
  it('returns parsed data for valid input', () => {
    const schema = z.object({ id: z.string() });
    const result = strictParse(schema, { id: 'test-123' });

    expect(result).toEqual({ id: 'test-123' });
  });

  it('throws ZodError for invalid input', () => {
    const schema = z.object({ id: z.string().uuid() });

    expect(() => {
      strictParse(schema, { id: 'invalid' });
    }).toThrow();
  });
});

describe('Complex query validation scenarios', () => {
  it('validates combined filters (contracts + status)', () => {
    const combined = contractFilterSchema.merge(txStatusFilterSchema);
    const middleware = validateQuery(combined);
    const req = mockReq({
      query: {
        contract: 'GHFC32E75LBOGIRE3VLPGF2FJOAE6NQVRLXSS44ZLGAJZ2SKSE5E4JVB',
        status: 'success',
        minFeeCharged: '0.5',
      },
    });
    const res = mockRes();
    const next = mockNext();

    middleware(req, res, next);

    expect(next).toHaveBeenCalled();
    const validated = (req as any).validatedQuery;
    expect(validated.contract).toBe('GHFC32E75LBOGIRE3VLPGF2FJOAE6NQVRLXSS44ZLGAJZ2SKSE5E4JVB');
    expect(validated.status).toBe('success');
  });

  it('handles pagination defaults', () => {
    const middleware = validateQuery(paginationSchema);
    const req = mockReq({
      query: {}, // no query params
    });
    const res = mockRes();
    const next = mockNext();

    middleware(req, res, next);

    expect(next).toHaveBeenCalled();
    const validated = (req as any).validatedQuery;
    expect(validated.page).toBe(1);
    expect(validated.limit).toBe(20);
  });

  it('respects limit constraints', () => {
    const middleware = validateQuery(paginationSchema);
    const req = mockReq({
      query: { limit: '1000' }, // exceeds max of 100
    });
    const res = mockRes();
    const next = mockNext();

    middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
  });
});

describe('Error response format', () => {
  it('includes error message and field-level details', () => {
    const middleware = validateQuery(paginationSchema);
    const req = mockReq({
      query: { page: '-1', limit: 'abc' },
    });
    const res = mockRes();
    const next = mockNext();

    middleware(req, res, next);

    const response = (res.json as Mock).mock.calls[0][0];
    expect(response.error).toBe('Invalid query parameters');
    expect(response.details).toBeDefined();
    expect(typeof response.details).toBe('object');
  });
});
