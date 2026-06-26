/**
 * BN254 API Router
 *
 * BN254 (alt-bn128) elliptic curve operations for zero-knowledge proof
 * systems. Exposes point operations (add, scalar mul), pairing checks,
 * and ZK proof verification utilities used in Soroban zkSNARK contracts.
 */
import { Router, Request, Response } from 'express';
import { z } from 'zod';

export const bn254Router = Router();

// BN254 curve parameters (for reference only)
const BN254_FIELD_MODULUS =
  '21888242871839275222246405745257275088696311157297823662689037894645226208583';
const BN254_ORDER = '21888242871839275222246405745257275088548364400416034343698204186575808495617';

// ── GET / ─────────────────────────────────────────────────────────────────────

/**
 * @swagger
 * /bn254:
 *   get:
 *     summary: BN254 elliptic curve service overview
 *     tags: [BN254]
 *     responses:
 *       200:
 *         description: Service info
 */
bn254Router.get('/', (_req: Request, res: Response) => {
  res.json({
    service: 'BN254 API',
    description: 'BN254 (alt-bn128) elliptic curve operations for zero-knowledge proof systems',
    curve: {
      name: 'BN254 / alt-bn128',
      fieldModulus: BN254_FIELD_MODULUS,
      curveOrder: BN254_ORDER,
      embedding: 12,
    },
    useCases: [
      'Groth16 proof verification',
      'PLONK verifier',
      'zkSNARK proof generation',
      'Pairing-based cryptography',
    ],
    endpoints: [
      'GET  /bn254',
      'GET  /bn254/params',
      'POST /bn254/point-add',
      'POST /bn254/scalar-mul',
      'POST /bn254/pairing-check',
      'POST /bn254/verify-groth16',
      'POST /bn254/verify-plonk',
    ],
  });
});

// ── GET /params ────────────────────────────────────────────────────────────────

/**
 * @swagger
 * /bn254/params:
 *   get:
 *     summary: Get BN254 curve parameters
 *     tags: [BN254]
 *     responses:
 *       200:
 *         description: Curve parameters
 */
bn254Router.get('/params', (_req: Request, res: Response) => {
  res.json({
    curve: 'BN254',
    aliases: ['alt-bn128', 'BN256'],
    fieldModulus: BN254_FIELD_MODULUS,
    curveOrder: BN254_ORDER,
    G1Generator: {
      x: '1',
      y: '2',
    },
    G2Generator: {
      x: [
        '10857046999023057135944570762232829481370756359578518086990519993285655852781',
        '11559732032986387107991004021392285783925812861821192530917403151452391805634',
      ],
      y: [
        '8495653923123431417604973247489272438418190587263600148770280649306958101930',
        '4082367875863433681332203403145435568316851327593401208105741076214120093531',
      ],
    },
    pairingTarget: 'GT field of degree 12 extension',
    sorobanPrecompile: 'ecAdd, ecMul, ecPairing available in Soroban host via Protocol 20+',
  });
});

// ── POST /point-add ────────────────────────────────────────────────────────────

/**
 * @swagger
 * /bn254/point-add:
 *   post:
 *     summary: Add two G1 points on the BN254 curve
 *     tags: [BN254]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [p1, p2]
 *             properties:
 *               p1:
 *                 type: object
 *                 properties:
 *                   x: { type: string }
 *                   y: { type: string }
 *               p2:
 *                 type: object
 *                 properties:
 *                   x: { type: string }
 *                   y: { type: string }
 *     responses:
 *       200:
 *         description: Sum point
 *       400:
 *         description: Validation error
 */
bn254Router.post('/point-add', (req: Request, res: Response) => {
  const PointSchema = z.object({ x: z.string().min(1), y: z.string().min(1) });
  const schema = z.object({ p1: PointSchema, p2: PointSchema });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  res.json({
    operation: 'G1_ADD',
    p1: parsed.data.p1,
    p2: parsed.data.p2,
    result: { x: '0', y: '0' },
    note: 'Server-side BN254 math library not configured. Use a dedicated crypto library for production.',
  });
});

// ── POST /scalar-mul ──────────────────────────────────────────────────────────

/**
 * @swagger
 * /bn254/scalar-mul:
 *   post:
 *     summary: Scalar multiplication of a G1 point
 *     tags: [BN254]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [point, scalar]
 *             properties:
 *               point:
 *                 type: object
 *                 properties:
 *                   x: { type: string }
 *                   y: { type: string }
 *               scalar: { type: string }
 *     responses:
 *       200:
 *         description: Resulting point
 *       400:
 *         description: Validation error
 */
bn254Router.post('/scalar-mul', (req: Request, res: Response) => {
  const schema = z.object({
    point: z.object({ x: z.string().min(1), y: z.string().min(1) }),
    scalar: z.string().min(1),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  res.json({
    operation: 'G1_MUL',
    point: parsed.data.point,
    scalar: parsed.data.scalar,
    result: { x: '0', y: '0' },
    note: 'Server-side BN254 math library not configured.',
  });
});

// ── POST /pairing-check ────────────────────────────────────────────────────────

/**
 * @swagger
 * /bn254/pairing-check:
 *   post:
 *     summary: Perform a BN254 pairing check (e(A,B) == e(C,D))
 *     tags: [BN254]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [pairs]
 *             properties:
 *               pairs: { type: array, description: 'Array of [G1, G2] point pairs' }
 *     responses:
 *       200:
 *         description: Pairing result
 *       400:
 *         description: Validation error
 */
bn254Router.post('/pairing-check', (req: Request, res: Response) => {
  const schema = z.object({
    pairs: z
      .array(
        z.object({
          g1: z.object({ x: z.string(), y: z.string() }),
          g2: z.object({ x: z.array(z.string()), y: z.array(z.string()) }),
        }),
      )
      .min(1)
      .max(8),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  res.json({
    operation: 'PAIRING_CHECK',
    pairCount: parsed.data.pairs.length,
    result: false,
    note: 'Server-side BN254 pairing not configured. Use Soroban host precompiles for on-chain verification.',
  });
});

// ── POST /verify-groth16 ──────────────────────────────────────────────────────

/**
 * @swagger
 * /bn254/verify-groth16:
 *   post:
 *     summary: Verify a Groth16 zero-knowledge proof
 *     tags: [BN254]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [vk, proof, publicInputs]
 *             properties:
 *               vk: { type: object, description: 'Verification key' }
 *               proof: { type: object, description: 'Groth16 proof (A, B, C)' }
 *               publicInputs: { type: array, items: { type: string } }
 *     responses:
 *       200:
 *         description: Verification result
 *       400:
 *         description: Validation error
 */
bn254Router.post('/verify-groth16', (req: Request, res: Response) => {
  const schema = z.object({
    vk: z.object({}).passthrough(),
    proof: z.object({
      a: z.object({ x: z.string(), y: z.string() }).optional(),
      b: z.object({ x: z.array(z.string()), y: z.array(z.string()) }).optional(),
      c: z.object({ x: z.string(), y: z.string() }).optional(),
    }),
    publicInputs: z.array(z.string()).min(1),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  res.json({
    operation: 'GROTH16_VERIFY',
    valid: null,
    publicInputCount: parsed.data.publicInputs.length,
    note: 'Off-chain Groth16 verification requires a dedicated ZK library. Use Soroban host for on-chain verification.',
    verifiedAt: new Date().toISOString(),
  });
});

// ── POST /verify-plonk ────────────────────────────────────────────────────────

/**
 * @swagger
 * /bn254/verify-plonk:
 *   post:
 *     summary: Verify a PLONK zero-knowledge proof
 *     tags: [BN254]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [vk, proof, publicInputs]
 *             properties:
 *               vk: { type: object }
 *               proof: { type: object }
 *               publicInputs: { type: array, items: { type: string } }
 *     responses:
 *       200:
 *         description: Verification result
 *       400:
 *         description: Validation error
 */
bn254Router.post('/verify-plonk', (req: Request, res: Response) => {
  const schema = z.object({
    vk: z.object({}).passthrough(),
    proof: z.object({}).passthrough(),
    publicInputs: z.array(z.string()).min(1),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  res.json({
    operation: 'PLONK_VERIFY',
    valid: null,
    publicInputCount: parsed.data.publicInputs.length,
    note: 'PLONK verification requires a dedicated ZK library (e.g., snarkjs, bellman).',
    verifiedAt: new Date().toISOString(),
  });
});
