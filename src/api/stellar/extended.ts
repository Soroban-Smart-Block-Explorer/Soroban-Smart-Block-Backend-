import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prismaRead as prisma } from '../../db';
import { requireWalletAuth } from './middleware';
import { asyncHandler } from '../../middleware/asyncHandler';

export const extendedRouter = Router();

// ── SEP-38 Liquidity Bridge ──────────────────────────────────────────────────

extendedRouter.get(
  '/sep38/pairs',
  asyncHandler(async (_req: Request, res: Response) => {
    const anchors = await prisma.anchorsRegistry.findMany({
      where: { supportedSeps: { has: 'SEP-38' } },
      take: 50,
    });

    const pairs = anchors.flatMap((a) => {
      const assets = (a.assets as string[]) ?? [];
      const result: Array<{ anchor: string; sellAsset: string; buyAsset: string }> = [];
      for (let i = 0; i < assets.length; i++) {
        for (let j = i + 1; j < assets.length; j++) {
          result.push({ anchor: a.homeDomain, sellAsset: assets[i], buyAsset: assets[j] });
        }
      }
      return result;
    });

    res.json({ pairs });
  }),
);

extendedRouter.get(
  '/sep38/price',
  asyncHandler(async (req: Request, res: Response) => {
    const sellAsset = req.query.sell_asset as string;
    const buyAsset = req.query.buy_asset as string;
    const amount = parseFloat((req.query.amount as string) ?? '100');

    if (!sellAsset || !buyAsset) {
      return res.status(400).json({ error: 'sell_asset and buy_asset required' });
    }

    res.json({
      sellAsset,
      buyAsset,
      sellAmount: amount,
      buyAmount: amount * 0.95,
      price: '0.95',
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
      quoteId: `quote-${Date.now()}`,
    });
  }),
);

extendedRouter.get(
  '/sep38/quotes/:id',
  asyncHandler(async (req: Request, res: Response) => {
    res.json({
      id: req.params.id,
      status: 'pending',
      message: 'Quote lookup requires anchor SEP-38 integration',
    });
  }),
);

// ── Visualizations ───────────────────────────────────────────────────────────

extendedRouter.get(
  '/visualizations/transaction-flow',
  asyncHandler(async (_req: Request, res: Response) => {
    const txs = await prisma.transaction.findMany({
      take: 100,
      orderBy: { ledgerCloseTime: 'desc' },
    });
    const nodes = new Set<string>();
    const links: Array<{ source: string; target: string; value: number }> = [];

    for (const tx of txs) {
      nodes.add(tx.sourceAccount);
      if (tx.contractAddress) {
        nodes.add(tx.contractAddress);
        links.push({ source: tx.sourceAccount, target: tx.contractAddress, value: 1 });
      }
    }

    res.json({
      nodes: [...nodes].map((id) => ({ id, label: id.slice(0, 8) })),
      links,
      type: 'sankey',
    });
  }),
);

extendedRouter.get(
  '/visualizations/asset-distribution',
  asyncHandler(async (_req: Request, res: Response) => {
    const assets = await prisma.stellarAsset.findMany({
      take: 20,
      orderBy: { numHolders: 'desc' },
    });
    res.json({
      type: 'pie',
      data: assets.map((a) => ({ label: a.assetCode, value: a.numHolders })),
    });
  }),
);

extendedRouter.get(
  '/visualizations/network-topology',
  asyncHandler(async (_req: Request, res: Response) => {
    const nodes = await prisma.networkNode.findMany({
      where: { activeInNetwork: true },
      take: 50,
      select: {
        publicKey: true,
        name: true,
        organization: true,
        country: true,
        latitude: true,
        longitude: true,
      },
    });
    res.json({ type: 'topology', nodes });
  }),
);

extendedRouter.get(
  '/visualizations/ecosystem-growth',
  asyncHandler(async (_req: Request, res: Response) => {
    const history: Array<{ date: string; classic: number; soroban: number }> = [];
    for (let i = 30; i >= 0; i--) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      history.push({
        date: date.toISOString().split('T')[0],
        classic: 50000 + i * 100,
        soroban: 10000 + i * 50,
      });
    }
    res.json({ type: 'line', data: history });
  }),
);

// ── Ecosystem Alerts ─────────────────────────────────────────────────────────

const alertConfigs: Array<Record<string, unknown>> = [];

extendedRouter.post(
  '/alerts',
  requireWalletAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const schema = z.object({
      name: z.string(),
      conditions: z.object({
        type: z.enum([
          'large_payment',
          'anchor_status_change',
          'bridge_volume_spike',
          'network_health_drop',
          'new_asset_listing',
        ]),
        threshold: z.string().optional(),
        direction: z.string().optional(),
      }),
      channels: z.array(
        z.object({
          type: z.enum(['email', 'webhook']),
          config: z.record(z.unknown()),
        }),
      ),
    });

    try {
      const body = schema.parse(req.body);
      const alert = { id: `alert-${Date.now()}`, ...body, createdAt: new Date().toISOString() };
      alertConfigs.push(alert);
      res.status(201).json(alert);
    } catch (e) {
      res.status(400).json({ error: String(e) });
    }
  }),
);

// ── Data Export & Reporting ──────────────────────────────────────────────────

extendedRouter.get(
  '/export/accounts',
  asyncHandler(async (_req: Request, res: Response) => {
    const accounts = await prisma.stellarAccount.findMany({ take: 1000 });
    const csv = ['address,xlm_balance,sequence_number,subentry_count,is_activated'];
    for (const a of accounts) {
      csv.push(
        `${a.address},${a.xlmBalance},${a.sequenceNumber},${a.subentryCount},${a.isActivated}`,
      );
    }
    res.setHeader('Content-Type', 'text/csv');
    res.send(csv.join('\n'));
  }),
);

extendedRouter.get(
  '/export/assets',
  asyncHandler(async (_req: Request, res: Response) => {
    const assets = await prisma.stellarAsset.findMany({ take: 1000 });
    const csv = ['code,issuer,type,total_supply,num_holders,volume_24h'];
    for (const a of assets) {
      csv.push(
        `${a.assetCode},${a.assetIssuer},${a.assetType},${a.totalSupply},${a.numHolders},${a.volume24h}`,
      );
    }
    res.setHeader('Content-Type', 'text/csv');
    res.send(csv.join('\n'));
  }),
);

extendedRouter.get(
  '/export/transactions',
  asyncHandler(async (_req: Request, res: Response) => {
    const txs = await prisma.unifiedTransaction.findMany({
      take: 1000,
      orderBy: { createdAt: 'desc' },
    });
    const csv = ['network,tx_hash,type,amount,successful,created_at'];
    for (const t of txs) {
      csv.push(
        `${t.network},${t.txHash},${t.type},${t.amount},${t.successful},${t.createdAt.toISOString()}`,
      );
    }
    res.setHeader('Content-Type', 'text/csv');
    res.send(csv.join('\n'));
  }),
);

extendedRouter.get(
  '/reports/weekly',
  asyncHandler(async (_req: Request, res: Response) => {
    res.json({
      period: 'weekly',
      generatedAt: new Date().toISOString(),
      summary: { newAccounts: 0, totalTransactions: 0, topAssets: [], networkHealth: 'healthy' },
    });
  }),
);

extendedRouter.get(
  '/reports/monthly/:year/:month',
  asyncHandler(async (req: Request, res: Response) => {
    res.json({
      period: `monthly-${req.params.year}-${req.params.month}`,
      generatedAt: new Date().toISOString(),
      summary: { newAccounts: 0, totalTransactions: 0, bridgeVolume: '0' },
    });
  }),
);

extendedRouter.get(
  '/reports/quarterly/:year/:quarter',
  asyncHandler(async (req: Request, res: Response) => {
    res.json({
      period: `quarterly-${req.params.year}-Q${req.params.quarter}`,
      generatedAt: new Date().toISOString(),
      summary: { ecosystemGrowth: 0, sorobanAdoption: 0 },
    });
  }),
);

// ── AI Assistant (Stretch) ───────────────────────────────────────────────────

const aiQueryHistory: Array<{ query: string; response: string; timestamp: string }> = [];

extendedRouter.post(
  '/ai/query',
  asyncHandler(async (req: Request, res: Response) => {
    const query = (req.body?.query as string) ?? '';
    if (!query) return res.status(400).json({ error: 'query required' });

    let response =
      'I can help you explore Stellar ecosystem data. Try asking about accounts, assets, anchors, or bridge activity.';
    const lower = query.toLowerCase();

    if (lower.includes('usdc') && lower.includes('holder')) {
      const assets = await prisma.stellarAsset.findMany({
        where: { assetCode: 'USDC' },
        orderBy: { numHolders: 'desc' },
        take: 5,
      });
      response = `Top USDC assets by holders: ${assets.map((a) => `${a.assetCode} (${a.numHolders} holders)`).join(', ')}`;
    } else if (lower.includes('sep-31') || lower.includes('sep31')) {
      const anchors = await prisma.anchorsRegistry.findMany({
        where: { supportedSeps: { has: 'SEP-31' } },
      });
      response = `Anchors supporting SEP-31: ${anchors.map((a) => a.name).join(', ') || 'none indexed yet'}`;
    } else if (lower.includes('soroban') && lower.includes('volume')) {
      const count = await prisma.transaction.count({
        where: { ledgerCloseTime: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } },
      });
      response = `Soroban transaction volume over last 30 days: ${count} transactions`;
    }

    const entry = { query, response, timestamp: new Date().toISOString() };
    aiQueryHistory.push(entry);
    res.json(entry);
  }),
);

extendedRouter.get(
  '/ai/history',
  asyncHandler(async (_req: Request, res: Response) => {
    res.json({ history: aiQueryHistory.slice(-50) });
  }),
);

// ── Swap Simulator (Stretch) ─────────────────────────────────────────────────

extendedRouter.post(
  '/simulate/swap',
  asyncHandler(async (req: Request, res: Response) => {
    const schema = z.object({
      fromAsset: z.object({ code: z.string(), issuer: z.string().optional() }),
      toAsset: z.object({ code: z.string(), issuer: z.string().optional() }),
      amount: z.string(),
    });

    try {
      const body = schema.parse(req.body);
      const amount = parseFloat(body.amount);
      const rate = 0.95;
      res.json({
        fromAsset: body.fromAsset,
        toAsset: body.toAsset,
        inputAmount: body.amount,
        outputAmount: (amount * rate).toFixed(7),
        route: [
          { step: 1, type: 'classic_dex', from: body.fromAsset.code, to: 'XLM' },
          { step: 2, type: 'soroban_amm', from: 'XLM', to: body.toAsset.code },
        ],
        estimatedFee: '0.0001 XLM',
        priceImpact: '0.5%',
      });
    } catch (e) {
      res.status(400).json({ error: String(e) });
    }
  }),
);
