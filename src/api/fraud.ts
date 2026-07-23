import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prismaRead, prismaWrite } from '../db';
import { getFraudAlertSystem } from '../services/fraudAlertSystem';
import { getFraudFeatureStore } from '../services/fraudFeatureStore';
import { getMlopsService } from '../services/mlops';

export const fraudRouter = Router();

const alertSystem = getFraudAlertSystem();
const featureStore = getFraudFeatureStore();
const mlops = getMlopsService();

// Zod schemas for validation
const analyzeSchema = z.object({
  entityId: z.string(),
  alertType: z.enum(['MEV', 'WASH_TRADING', 'SYBIL', 'SMART_CONTRACT_EXPLOIT'])
});

const feedbackSchema = z.object({
  transactionHash: z.string(),
  label: z.enum(['MEV', 'WASH_TRADING', 'SYBIL', 'SMART_CONTRACT_EXPLOIT'])
});

// POST /fraud/analyze
fraudRouter.post('/analyze', async (req: Request, res: Response) => {
  try {
    const parsed = analyzeSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const { entityId, alertType } = parsed.data;
    const alert = await alertSystem.analyzeAndAct(entityId, alertType);
    
    res.status(200).json(alert);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /fraud/alerts
fraudRouter.get('/alerts', async (req: Request, res: Response) => {
  try {
    const limit = Math.min(100, parseInt((req.query.limit as string) ?? '20', 10));
    const offset = parseInt((req.query.offset as string) ?? '0', 10);
    const severity = req.query.severity as string;

    const where: any = {};
    if (severity) where.severity = severity;

    const alerts = await prismaRead.fraudAlert.findMany({
      where,
      take: limit,
      skip: offset,
      orderBy: { createdAt: 'desc' }
    });

    const total = await prismaRead.fraudAlert.count({ where });

    res.json({ data: alerts, total, limit, offset });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /fraud/features/:entityId
fraudRouter.get('/features/:entityId', async (req: Request, res: Response) => {
  try {
    const features = await featureStore.getOnlineFeatures(req.params.entityId);
    res.json(features);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /fraud/models
fraudRouter.get('/models', async (req: Request, res: Response) => {
  try {
    const models = await prismaRead.modelRegistryEntry.findMany({
      orderBy: { name: 'asc' }
    });
    res.json(models);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// PATCH /fraud/models/:id/status
fraudRouter.patch('/models/:id/status', async (req: Request, res: Response) => {
  try {
    const statusSchema = z.object({
      status: z.enum(['ACTIVE', 'SHADOW', 'CANDIDATE'])
    });
    const parsed = statusSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const updated = await prismaWrite.modelRegistryEntry.update({
      where: { id: req.params.id },
      data: { status: parsed.data.status }
    });

    res.json(updated);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST /fraud/models/:id/retrain
fraudRouter.post('/models/:id/retrain', async (req: Request, res: Response) => {
  try {
    await mlops.retrainModel(req.params.id);
    res.json({ success: true, message: 'Retraining initiated successfully' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /fraud/drift
fraudRouter.get('/drift', async (req: Request, res: Response) => {
  try {
    const reports = await mlops.monitorFeatureDrift();
    res.json(reports);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST /fraud/feedback
fraudRouter.post('/feedback', async (req: Request, res: Response) => {
  try {
    const parsed = feedbackSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const { transactionHash, label } = parsed.data;
    await mlops.confirmAttackFeedback(transactionHash, label);

    res.json({ success: true, message: 'Feedback logged and retrain threshold updated' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});
