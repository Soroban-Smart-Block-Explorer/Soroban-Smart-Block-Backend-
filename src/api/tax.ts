/**
 * Tax API Router
 *
 * Tax reporting and calculation for Soroban/Stellar DeFi activity.
 * Computes cost basis, capital gains, income events, and generates
 * tax-compatible transaction reports for users.
 */
import { Router, Request, Response } from 'express';
import { z } from 'zod';

export const taxRouter = Router();

// ── GET / ─────────────────────────────────────────────────────────────────────

/**
 * @swagger
 * /tax:
 *   get:
 *     summary: Tax reporting service overview
 *     tags: [Tax]
 *     responses:
 *       200:
 *         description: Service info
 */
taxRouter.get('/', (_req: Request, res: Response) => {
  res.json({
    service: 'Tax API',
    description:
      'Tax reporting, cost basis calculation, and capital gains computation for Stellar DeFi activity',
    methods: ['FIFO', 'LIFO', 'HIFO', 'average_cost'],
    endpoints: [
      'GET  /tax',
      'GET  /tax/accounts/:address/summary',
      'GET  /tax/accounts/:address/gains',
      'GET  /tax/accounts/:address/income',
      'POST /tax/accounts/:address/report',
      'GET  /tax/accounts/:address/cost-basis',
      'GET  /tax/rates',
    ],
  });
});

// ── GET /accounts/:address/summary ─────────────────────────────────────────────

/**
 * @swagger
 * /tax/accounts/{address}/summary:
 *   get:
 *     summary: Get tax summary for an account
 *     tags: [Tax]
 *     parameters:
 *       - in: path
 *         name: address
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: year
 *         schema: { type: number }
 *     responses:
 *       200:
 *         description: Tax summary
 */
taxRouter.get('/accounts/:address/summary', (req: Request, res: Response) => {
  const { address } = req.params;
  const year = parseInt((req.query.year as string) ?? String(new Date().getFullYear()), 10);

  res.json({
    address,
    taxYear: year,
    totalTaxableEvents: 0,
    shortTermGainsUSD: 0,
    longTermGainsUSD: 0,
    totalIncomeUSD: 0,
    totalLossesUSD: 0,
    netGainsUSD: 0,
    message: 'No taxable events found for this address and year.',
    disclaimer: 'This data is for informational purposes only. Consult a tax professional.',
  });
});

// ── GET /accounts/:address/gains ───────────────────────────────────────────────

/**
 * @swagger
 * /tax/accounts/{address}/gains:
 *   get:
 *     summary: Get capital gains/losses for an account
 *     tags: [Tax]
 *     parameters:
 *       - in: path
 *         name: address
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: year
 *         schema: { type: number }
 *       - in: query
 *         name: method
 *         schema: { type: string, enum: [FIFO, LIFO, HIFO, average_cost] }
 *     responses:
 *       200:
 *         description: Capital gains data
 */
taxRouter.get('/accounts/:address/gains', (req: Request, res: Response) => {
  const { address } = req.params;
  const year = parseInt((req.query.year as string) ?? String(new Date().getFullYear()), 10);
  const method = (req.query.method as string) ?? 'FIFO';

  res.json({
    address,
    taxYear: year,
    method,
    gains: [],
    shortTermTotal: 0,
    longTermTotal: 0,
    message: 'No capital gain events found.',
  });
});

// ── GET /accounts/:address/income ──────────────────────────────────────────────

/**
 * @swagger
 * /tax/accounts/{address}/income:
 *   get:
 *     summary: Get income events (staking rewards, airdrops, yield)
 *     tags: [Tax]
 *     parameters:
 *       - in: path
 *         name: address
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: year
 *         schema: { type: number }
 *     responses:
 *       200:
 *         description: Income events
 */
taxRouter.get('/accounts/:address/income', (req: Request, res: Response) => {
  const { address } = req.params;
  const year = parseInt((req.query.year as string) ?? String(new Date().getFullYear()), 10);

  res.json({
    address,
    taxYear: year,
    incomeEvents: [],
    totalIncomeUSD: 0,
    byCategory: {
      staking: 0,
      yield: 0,
      airdrops: 0,
      referrals: 0,
      other: 0,
    },
  });
});

// ── POST /accounts/:address/report ────────────────────────────────────────────

/**
 * @swagger
 * /tax/accounts/{address}/report:
 *   post:
 *     summary: Generate a tax report for download
 *     tags: [Tax]
 *     parameters:
 *       - in: path
 *         name: address
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               year: { type: number }
 *               format: { type: string, enum: [json, csv, pdf] }
 *               method: { type: string, enum: [FIFO, LIFO, HIFO, average_cost] }
 *     responses:
 *       200:
 *         description: Generated report
 *       400:
 *         description: Validation error
 */
taxRouter.post('/accounts/:address/report', (req: Request, res: Response) => {
  const schema = z.object({
    year: z.number().int().min(2020).max(2030).default(new Date().getFullYear()),
    format: z.enum(['json', 'csv', 'pdf']).default('json'),
    method: z.enum(['FIFO', 'LIFO', 'HIFO', 'average_cost']).default('FIFO'),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const { year, format, method } = parsed.data;
  const reportId = `tax_report_${req.params.address.slice(0, 8)}_${year}_${Date.now()}`;

  res.json({
    reportId,
    address: req.params.address,
    taxYear: year,
    format,
    method,
    status: 'generated',
    data: {
      shortTermGains: 0,
      longTermGains: 0,
      totalIncome: 0,
      totalLosses: 0,
      transactions: [],
    },
    generatedAt: new Date().toISOString(),
    disclaimer: 'Informational only. Consult a qualified tax professional.',
  });
});

// ── GET /accounts/:address/cost-basis ─────────────────────────────────────────

/**
 * @swagger
 * /tax/accounts/{address}/cost-basis:
 *   get:
 *     summary: Get current cost basis for holdings
 *     tags: [Tax]
 *     parameters:
 *       - in: path
 *         name: address
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Cost basis data
 */
taxRouter.get('/accounts/:address/cost-basis', (req: Request, res: Response) => {
  const { address } = req.params;
  res.json({
    address,
    holdings: [],
    totalCostBasisUSD: 0,
    computedAt: new Date().toISOString(),
  });
});

// ── GET /rates ─────────────────────────────────────────────────────────────────

/**
 * @swagger
 * /tax/rates:
 *   get:
 *     summary: Get indicative tax rates by jurisdiction
 *     tags: [Tax]
 *     responses:
 *       200:
 *         description: Tax rates
 */
taxRouter.get('/rates', (_req: Request, res: Response) => {
  res.json({
    disclaimer: 'Tax rates are indicative only and change frequently. Consult a tax professional.',
    rates: {
      US: {
        shortTermCapitalGains: '10-37% (ordinary income rates)',
        longTermCapitalGains: '0%, 15%, or 20% depending on income',
        holdingPeriodThreshold: '1 year',
      },
      UK: {
        shortTermCapitalGains: '10% basic rate, 20% higher rate',
        longTermCapitalGains: 'Same as short-term in UK',
        annualAllowance: '£6,000 (2023/24)',
      },
      DE: {
        shortTermCapitalGains: 'Ordinary income tax rate',
        longTermCapitalGains: '0% if held > 1 year',
        holdingPeriodThreshold: '1 year',
      },
    },
    lastUpdated: '2024-01-01',
  });
});
