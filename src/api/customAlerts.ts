import { Router, Request, Response } from 'express';
import { asyncHandler } from '../middleware/asyncHandler';
import { AppError } from '../middleware/errorHandler';
import {
  alertRuleSchema,
  createRule,
  deleteRule,
  getRule,
  listRules,
  startAlertRuleEngine,
  updateRule,
} from '../alerts/alertRuleEngine';

export const customAlertsRouter = Router();

startAlertRuleEngine();

function requireUser(req: Request): string {
  const userId = req.headers['x-user-id'];
  if (typeof userId !== 'string' || !userId) throw new AppError(401, 'x-user-id header required');
  return userId;
}

customAlertsRouter.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    res.json({ data: listRules(requireUser(req)) });
  }),
);

customAlertsRouter.post(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = requireUser(req);
    const input = alertRuleSchema.parse(req.body);
    try {
      res.status(201).json({ data: createRule(userId, input) });
    } catch (err) {
      throw new AppError(400, (err as Error).message);
    }
  }),
);

customAlertsRouter.get(
  '/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const rule = getRule(requireUser(req), req.params.id);
    if (!rule) throw new AppError(404, 'Alert rule not found');
    res.json({ data: rule });
  }),
);

customAlertsRouter.patch(
  '/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const input = alertRuleSchema.partial().parse(req.body);
    const rule = updateRule(requireUser(req), req.params.id, input);
    if (!rule) throw new AppError(404, 'Alert rule not found');
    res.json({ data: rule });
  }),
);

customAlertsRouter.delete(
  '/:id',
  asyncHandler(async (req: Request, res: Response) => {
    if (!deleteRule(requireUser(req), req.params.id))
      throw new AppError(404, 'Alert rule not found');
    res.status(204).end();
  }),
);
