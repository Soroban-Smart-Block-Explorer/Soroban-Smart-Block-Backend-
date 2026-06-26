import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prismaWrite, prismaRead } from '../../db';
import { asyncHandler } from '../../middleware/asyncHandler';

export const billingRouter = Router();
export const plansRouter = Router();

const SEED_PLANS = [
  {
    name: 'free',
    requestsPerDay: 100,
    requestsPerMonth: 3000,
    priceMonthly: 0,
    features: { webhooks: 1, support: 'community' },
  },
  {
    name: 'developer',
    requestsPerDay: 10000,
    requestsPerMonth: 300000,
    priceMonthly: 10,
    features: { webhooks: 5, support: 'email' },
  },
  {
    name: 'pro',
    requestsPerDay: 100000,
    requestsPerMonth: 3000000,
    priceMonthly: 50,
    features: { webhooks: 20, support: 'priority' },
  },
  {
    name: 'enterprise',
    requestsPerDay: 9999999,
    requestsPerMonth: 99999999,
    priceMonthly: 0,
    features: { webhooks: 100, support: 'dedicated' },
  },
];

// GET /developer/plans
plansRouter.get(
  '/',
  asyncHandler(async (_req: Request, res: Response) => {
    // Ensure seed plans exist
    for (const plan of SEED_PLANS) {
      await prismaWrite.billingPlan.upsert({
        where: { name: plan.name },
        update: {},
        create: plan,
      });
    }

    const plans = await prismaRead.billingPlan.findMany({ orderBy: { priceMonthly: 'asc' } });
    res.json({ data: plans });
  }),
);

// GET /developer/plan/current
plansRouter.get(
  '/current',
  asyncHandler(async (req: Request, res: Response) => {
    const { developerId } = z.object({ developerId: z.string() }).parse(req.query);

    const developer = await prismaRead.developer.findUnique({
      where: { id: developerId },
      include: { plan: true },
    });
    if (!developer) return res.status(404).json({ error: 'Developer not found' });

    res.json({
      plan: developer.plan ?? {
        name: 'free',
        requestsPerDay: 100,
        requestsPerMonth: 3000,
        priceMonthly: 0,
      },
    });
  }),
);

// POST /developer/plan/change
plansRouter.post(
  '/change',
  asyncHandler(async (req: Request, res: Response) => {
    const { developerId, planName } = z
      .object({ developerId: z.string(), planName: z.string() })
      .parse(req.body);

    const developer = await prismaRead.developer.findUnique({ where: { id: developerId } });
    if (!developer) return res.status(404).json({ error: 'Developer not found' });

    const plan = await prismaRead.billingPlan.findUnique({ where: { name: planName } });
    if (!plan) return res.status(404).json({ error: 'Plan not found' });

    await prismaWrite.developer.update({ where: { id: developerId }, data: { planId: plan.id } });

    res.json({ message: `Plan changed to ${planName}`, plan });
  }),
);

// POST /developer/billing/pay
billingRouter.post(
  '/pay',
  asyncHandler(async (req: Request, res: Response) => {
    const { developerId, currency, amount } = z
      .object({
        developerId: z.string(),
        currency: z.enum(['XLM', 'USDC', 'TOKEN']),
        amount: z.number().positive(),
      })
      .parse(req.body);

    const developer = await prismaRead.developer.findUnique({
      where: { id: developerId },
      include: { plan: true },
    });
    if (!developer) return res.status(404).json({ error: 'Developer not found' });

    // Simulate crypto payment receipt — production would verify on-chain
    const txRef = `pay_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

    res.status(202).json({
      transactionRef: txRef,
      status: 'pending',
      currency,
      amount,
      message: 'Payment initiated. Awaiting on-chain confirmation.',
      walletAddress: developer.walletAddress,
    });
  }),
);

// GET /developer/billing/payments
billingRouter.get(
  '/payments',
  asyncHandler(async (req: Request, res: Response) => {
    const { developerId } = z.object({ developerId: z.string() }).parse(req.query);

    const developer = await prismaRead.developer.findUnique({ where: { id: developerId } });
    if (!developer) return res.status(404).json({ error: 'Developer not found' });

    // Return empty payment history (no payment table in current schema — would be added in a follow-up)
    res.json({ data: [], message: 'Payment history requires on-chain integration' });
  }),
);

// GET /developer/billing/invoices/:id
billingRouter.get(
  '/invoices/:id',
  asyncHandler(async (req: Request, res: Response) => {
    // Placeholder invoice — production would generate from usage records
    res.json({
      id: req.params.id,
      status: 'not_found',
      message: 'Invoice generation requires a billing integration',
    });
  }),
);

// GET /developer/billing/current-bill
billingRouter.get(
  '/current-bill',
  asyncHandler(async (req: Request, res: Response) => {
    const { developerId } = z.object({ developerId: z.string() }).parse(req.query);

    const developer = await prismaRead.developer.findUnique({
      where: { id: developerId },
      include: { plan: true },
    });
    if (!developer) return res.status(404).json({ error: 'Developer not found' });

    const startOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    const usedThisMonth = await prismaRead.usageRecord.count({
      where: { developerId, createdAt: { gte: startOfMonth } },
    });

    const planPrice = developer.plan?.priceMonthly ?? 0;
    const monthlyQuota = developer.plan?.requestsPerMonth ?? 3000;
    const overages = Math.max(0, usedThisMonth - monthlyQuota);
    const overageRate = 0.0001; // $0.0001 per request overage
    const overageCharge = overages * overageRate;

    res.json({
      period: {
        start: startOfMonth.toISOString(),
        end: new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).toISOString(),
      },
      plan: developer.plan?.name ?? 'free',
      baseCost: planPrice,
      usageThisMonth: usedThisMonth,
      includedQuota: monthlyQuota,
      overageRequests: overages,
      overageCharge,
      totalDue: planPrice + overageCharge,
      currency: 'USD',
    });
  }),
);

// GET /developer/billing/history
billingRouter.get(
  '/history',
  asyncHandler(async (req: Request, res: Response) => {
    const { developerId } = z.object({ developerId: z.string() }).parse(req.query);

    const developer = await prismaRead.developer.findUnique({ where: { id: developerId } });
    if (!developer) return res.status(404).json({ error: 'Developer not found' });

    res.json({ data: [], message: 'Billing history requires a payment integration' });
  }),
);
