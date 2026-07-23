import { Router, Request, Response } from 'express';
import {
  classifyOracleContract,
  detectOracleManipulation,
  scoreOracleReliability,
  type OracleContractProfile,
} from '../services/oracleIntelligence';

export const oracleIntelligenceRouter = Router();

oracleIntelligenceRouter.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', service: 'oracle-intelligence' });
});

oracleIntelligenceRouter.post('/detect', (req: Request, res: Response) => {
  const profile = (req.body?.contract ?? {}) as OracleContractProfile;
  res.json(classifyOracleContract(profile));
});

oracleIntelligenceRouter.post('/score', (req: Request, res: Response) => {
  const samples = Array.isArray(req.body?.samples) ? req.body.samples : [];
  const metrics = req.body?.metrics ?? {};
  res.json(scoreOracleReliability(samples, metrics));
});

oracleIntelligenceRouter.post('/manipulation', (req: Request, res: Response) => {
  const samples = Array.isArray(req.body?.samples) ? req.body.samples : [];
  res.json({ findings: detectOracleManipulation(samples) });
});
