import { Router } from 'express';
import { authRouter } from './auth';
import { keysRouter } from './keys';
import { devWebhooksRouter } from './webhooks';
import { usageRouter } from './usage';
import { rateLimitsRouter, quotaRouter } from './rate-limits';
import { billingRouter, plansRouter } from './billing';
import { portalRouter } from './portal';

export const developerRouter = Router();

developerRouter.use('/auth', authRouter);
developerRouter.use('/keys', keysRouter);
developerRouter.use('/webhooks', devWebhooksRouter);
developerRouter.use('/usage', usageRouter);
developerRouter.use('/rate-limits', rateLimitsRouter);
developerRouter.use('/quota', quotaRouter);
developerRouter.use('/plans', plansRouter);
developerRouter.use('/plan', plansRouter);
developerRouter.use('/billing', billingRouter);
developerRouter.use('/', portalRouter);
