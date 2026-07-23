/**
 * Shared Zod schemas for the Soroban Block Explorer API.
 *
 * All schemas include injection prevention (HTML stripping, SQL pattern
 * blocking, prototype pollution guards) and size limits.
 */
import { z } from 'zod';

// ── Sanitisation helpers ──────────────────────────────────────────────────────

const HTML_TAG_RE = /<[^>]*>/g;
const SCRIPT_PROTO_RE = /javascript:|vbscript:|data:/gi;
const SQL_RE =
  /('|--|;|\/\*|\*\/|xp_|exec\s|union\s+select|drop\s+table|insert\s+into|delete\s+from|update\s+set)/i;
const PROTO_POLLUTION_RE = /^(__proto__|constructor|prototype)$/;

function stripHtml(s: string): string {
  return s.replace(HTML_TAG_RE, '').replace(SCRIPT_PROTO_RE, '');
}

function blockSqlPatterns(s: string): boolean {
  return SQL_RE.test(s);
}

/** Zod refinement: reject SQL injection patterns */
const noSql = (s: string) => !blockSqlPatterns(s);
const noSqlMsg = 'Input contains disallowed SQL patterns';

/** Zod transform: strip all HTML tags and dangerous URI schemes */
const sanitized = z.string().transform(stripHtml);

// ── Primitive schemas ─────────────────────────────────────────────────────────

/** Safe string: strips HTML, rejects SQL injection, max 2048 chars */
export const safeString = z
  .string()
  .max(2048, 'Input exceeds maximum length of 2048 characters')
  .transform(stripHtml)
  .refine(noSql, noSqlMsg);

/** Short label / name: stripped, max 256 chars */
export const safeLabel = z
  .string()
  .max(256, 'Label exceeds maximum length of 256 characters')
  .transform(stripHtml)
  .refine(noSql, noSqlMsg);

/** Description / notes field: stripped, max 4096 chars */
export const safeDescription = z
  .string()
  .max(4096, 'Description exceeds maximum length of 4096 characters')
  .transform(stripHtml)
  .refine(noSql, noSqlMsg);

/**
 * Stellar address (G…, M…, or C…).
 * We keep this as a plain string and let the sanitize middleware reject bad chars.
 */
export const stellarAddress = z
  .string()
  .min(56, 'Stellar address is too short')
  .max(69, 'Stellar address is too long')
  .regex(/^[GM][A-Z2-7]{55}$|^C[A-Z2-7]{55}$/, 'Invalid Stellar address format');

/** Transaction hash: 64 hex chars */
export const txHash = z
  .string()
  .length(64, 'Transaction hash must be exactly 64 hex characters')
  .regex(/^[0-9a-fA-F]{64}$/, 'Transaction hash must be hexadecimal');

/** Ledger sequence: positive integer */
export const ledgerSeq = z.coerce.number().int().min(0, 'Ledger sequence must be non-negative');

/** Safe object key: reject prototype pollution */
export const safeKey = z
  .string()
  .max(256)
  .refine((k) => !PROTO_POLLUTION_RE.test(k), 'Key is not allowed');

// ── Pagination schemas ────────────────────────────────────────────────────────

/** Standard offset-based pagination */
export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

/** Cursor-based pagination (preferred for large datasets) */
export const cursorPaginationSchema = z.object({
  cursor: z.coerce.number().int().min(0).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

/** Offset + limit (for legacy routes) */
export const offsetLimitSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

// ── Amount / financial schemas ────────────────────────────────────────────────

/** Non-negative number amount */
export const amountSchema = z.coerce.number().min(0, 'Amount must be non-negative');

/** Stringified numeric amount (on-chain representation) */
export const amountStringSchema = z
  .string()
  .max(64)
  .regex(/^\d+(\.\d+)?$/, 'Amount must be a valid positive number string');

/** USD value: non-negative, finite */
export const usdValueSchema = z.coerce
  .number()
  .min(0)
  .finite()
  .refine((n) => !Number.isNaN(n), 'USD value must be a valid number');

// ── Time range schemas ────────────────────────────────────────────────────────

export const timeRangeSchema = z.object({
  since: z.string().datetime({ offset: true }).optional(),
  until: z.string().datetime({ offset: true }).optional(),
});

export const periodSchema = z.object({
  period: z.enum(['1h', '24h', '7d', '30d', '90d']).default('24h'),
});

// ── Safe record (prototype-pollution–proof) ───────────────────────────────────

/** A plain object whose keys pass the safeKey check */
export const safeRecord = z.record(safeKey, z.unknown());

// ── Utility: parse query with 400 on failure ──────────────────────────────────

import { Request, Response } from 'express';

type ParseResult<T> = { ok: true; data: T } | { ok: false };

export function parseQuery<T>(schema: z.ZodSchema<T>, req: Request, res: Response): ParseResult<T> {
  const result = schema.safeParse(req.query);
  if (!result.success) {
    res.status(400).json({
      error: 'Invalid query parameters',
      details: result.error.flatten().fieldErrors,
    });
    return { ok: false };
  }
  return { ok: true, data: result.data };
}

export function parseBody<T>(schema: z.ZodSchema<T>, req: Request, res: Response): ParseResult<T> {
  const result = schema.safeParse(req.body);
  if (!result.success) {
    res.status(400).json({
      error: 'Invalid request body',
      details: result.error.flatten().fieldErrors,
    });
    return { ok: false };
  }
  return { ok: true, data: result.data };
}

export function parseParams<T>(
  schema: z.ZodSchema<T>,
  req: Request,
  res: Response,
): ParseResult<T> {
  const result = schema.safeParse(req.params);
  if (!result.success) {
    res.status(400).json({
      error: 'Invalid path parameters',
      details: result.error.flatten().fieldErrors,
    });
    return { ok: false };
  }
  return { ok: true, data: result.data };
}
