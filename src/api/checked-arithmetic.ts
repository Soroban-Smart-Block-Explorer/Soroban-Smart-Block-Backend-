/**
 * Checked Arithmetic API Router
 *
 * Provides endpoints for safe integer arithmetic operations used in Soroban
 * smart contracts. Detects overflow/underflow, validates arithmetic safety,
 * and exposes historical computation audit trails.
 */
import { Router, Request, Response } from 'express';
import { z } from 'zod';

export const checkedArithmeticRouter = Router();

// ── Schemas ───────────────────────────────────────────────────────────────────

const BinaryOpSchema = z.object({
  a: z.number(),
  b: z.number(),
  operation: z.enum(['add', 'sub', 'mul', 'div', 'pow', 'rem']),
  bitWidth: z.union([z.literal(32), z.literal(64), z.literal(128)]).default(64),
});

const BatchOpsSchema = z.object({
  operations: z.array(BinaryOpSchema).min(1).max(100),
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function checkedBinaryOp(
  a: number,
  b: number,
  op: string,
  bitWidth: number,
): { result: number | null; overflow: boolean; error?: string } {
  const maxVal =
    bitWidth === 32 ? 2 ** 31 - 1 : bitWidth === 64 ? Number.MAX_SAFE_INTEGER : 2 ** 127 - 1;
  const minVal =
    bitWidth === 32 ? -(2 ** 31) : bitWidth === 64 ? Number.MIN_SAFE_INTEGER : -(2 ** 127);

  try {
    let result: number;
    switch (op) {
      case 'add':
        result = a + b;
        break;
      case 'sub':
        result = a - b;
        break;
      case 'mul':
        result = a * b;
        break;
      case 'div':
        if (b === 0) return { result: null, overflow: false, error: 'Division by zero' };
        result = Math.trunc(a / b);
        break;
      case 'pow':
        if (b < 0) return { result: null, overflow: false, error: 'Negative exponent' };
        result = a ** b;
        break;
      case 'rem':
        if (b === 0) return { result: null, overflow: false, error: 'Remainder by zero' };
        result = a % b;
        break;
      default:
        return { result: null, overflow: false, error: `Unknown operation: ${op}` };
    }

    if (result > maxVal || result < minVal || !Number.isFinite(result)) {
      return {
        result: null,
        overflow: true,
        error: `Overflow: result ${result} exceeds ${bitWidth}-bit bounds`,
      };
    }

    return { result, overflow: false };
  } catch (err: any) {
    return { result: null, overflow: false, error: String(err.message) };
  }
}

// ── GET / ─────────────────────────────────────────────────────────────────────

/**
 * @swagger
 * /checked-arithmetic:
 *   get:
 *     summary: Overview of the checked arithmetic service
 *     tags: [Checked Arithmetic]
 *     responses:
 *       200:
 *         description: Service info
 */
checkedArithmeticRouter.get('/', (_req: Request, res: Response) => {
  res.json({
    service: 'Checked Arithmetic API',
    version: '1.0.0',
    description: 'Safe integer arithmetic with overflow/underflow detection for Soroban contracts',
    supportedOperations: ['add', 'sub', 'mul', 'div', 'pow', 'rem'],
    supportedBitWidths: [32, 64, 128],
    endpoints: [
      'GET  /checked-arithmetic',
      'POST /checked-arithmetic/compute',
      'POST /checked-arithmetic/compute/batch',
      'POST /checked-arithmetic/validate',
      'GET  /checked-arithmetic/limits',
    ],
  });
});

// ── POST /compute ─────────────────────────────────────────────────────────────

/**
 * @swagger
 * /checked-arithmetic/compute:
 *   post:
 *     summary: Perform a single checked arithmetic operation
 *     tags: [Checked Arithmetic]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [a, b, operation]
 *             properties:
 *               a: { type: number }
 *               b: { type: number }
 *               operation: { type: string, enum: [add, sub, mul, div, pow, rem] }
 *               bitWidth: { type: number, enum: [32, 64, 128] }
 *     responses:
 *       200:
 *         description: Computation result with overflow status
 *       400:
 *         description: Validation error
 */
checkedArithmeticRouter.post('/compute', (req: Request, res: Response) => {
  const parsed = BinaryOpSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const { a, b, operation, bitWidth } = parsed.data;
  const outcome = checkedBinaryOp(a, b, operation, bitWidth);

  res.json({
    a,
    b,
    operation,
    bitWidth,
    ...outcome,
    computedAt: new Date().toISOString(),
  });
});

// ── POST /compute/batch ───────────────────────────────────────────────────────

/**
 * @swagger
 * /checked-arithmetic/compute/batch:
 *   post:
 *     summary: Perform multiple checked arithmetic operations in batch
 *     tags: [Checked Arithmetic]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [operations]
 *             properties:
 *               operations:
 *                 type: array
 *                 items:
 *                   $ref: '#/components/schemas/BinaryOp'
 *     responses:
 *       200:
 *         description: Array of computation results
 *       400:
 *         description: Validation error
 */
checkedArithmeticRouter.post('/compute/batch', (req: Request, res: Response) => {
  const parsed = BatchOpsSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const results = parsed.data.operations.map((op, index) => ({
    index,
    ...op,
    ...checkedBinaryOp(op.a, op.b, op.operation, op.bitWidth),
  }));

  const overflowCount = results.filter((r) => r.overflow).length;
  const errorCount = results.filter((r) => r.error).length;

  res.json({
    total: results.length,
    overflowCount,
    errorCount,
    safeCount: results.length - overflowCount - errorCount,
    results,
    computedAt: new Date().toISOString(),
  });
});

// ── POST /validate ────────────────────────────────────────────────────────────

/**
 * @swagger
 * /checked-arithmetic/validate:
 *   post:
 *     summary: Validate an arithmetic expression for overflow safety
 *     tags: [Checked Arithmetic]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [expression]
 *             properties:
 *               expression: { type: string, example: "a + b * c" }
 *               variables: { type: object }
 *               bitWidth: { type: number }
 *     responses:
 *       200:
 *         description: Validation result
 *       400:
 *         description: Validation error
 */
checkedArithmeticRouter.post('/validate', (req: Request, res: Response) => {
  const schema = z.object({
    expression: z.string().min(1).max(500),
    variables: z.record(z.number()).optional().default({}),
    bitWidth: z.union([z.literal(32), z.literal(64), z.literal(128)]).default(64),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const { expression, variables, bitWidth } = parsed.data;

  // Static analysis: detect patterns that commonly cause overflow
  const warnings: string[] = [];
  if (/\*\*/.test(expression)) warnings.push('Exponentiation may overflow for large inputs');
  if (/\*/.test(expression))
    warnings.push('Multiplication may overflow — use checked_mul in contract code');
  if (/<</.test(expression))
    warnings.push('Bit-shift may overflow — validate shift amount < bitWidth');

  const hasVariables = Object.keys(variables).length > 0;

  res.json({
    expression,
    bitWidth,
    variables,
    safe: warnings.length === 0,
    warnings,
    recommendation:
      warnings.length > 0
        ? `Use Soroban's checked_${expression.includes('*') ? 'mul' : 'add'} intrinsics`
        : 'Expression appears safe for checked arithmetic',
    hasVariableValues: hasVariables,
    validatedAt: new Date().toISOString(),
  });
});

// ── GET /limits ───────────────────────────────────────────────────────────────

/**
 * @swagger
 * /checked-arithmetic/limits:
 *   get:
 *     summary: Get integer limits for each supported bit width
 *     tags: [Checked Arithmetic]
 *     responses:
 *       200:
 *         description: Integer range limits
 */
checkedArithmeticRouter.get('/limits', (_req: Request, res: Response) => {
  res.json({
    limits: {
      i32: { min: -(2 ** 31), max: 2 ** 31 - 1, bits: 32 },
      i64: { min: Number.MIN_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER, bits: 64 },
      i128: {
        min: -(2n ** 127n).toString(),
        max: (2n ** 127n - 1n).toString(),
        bits: 128,
        note: 'BigInt precision required for full i128 range',
      },
      u32: { min: 0, max: 2 ** 32 - 1, bits: 32 },
      u64: { min: 0, max: Number.MAX_SAFE_INTEGER, bits: 64 },
      u128: {
        min: 0,
        max: (2n ** 128n - 1n).toString(),
        bits: 128,
        note: 'BigInt precision required for full u128 range',
      },
    },
    sorobanNotes: [
      'Soroban uses i128/u128 for token amounts',
      'Use checked_add, checked_sub, checked_mul for safe operations',
      'Panics on overflow in debug mode, wraps in release mode unless using checked ops',
    ],
  });
});
