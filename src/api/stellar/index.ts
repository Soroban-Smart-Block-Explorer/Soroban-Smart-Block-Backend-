import { Router } from 'express';
import { accountsRouter } from './accounts';
import { anchorsRouter } from './anchors';
import { classicAssetsRouter } from './classic-assets';
import { paymentsRouter } from './payments';
import { bridgeRouter } from './bridge';
import { overviewRouter } from './overview';
import { networkHealthRouter } from './network-health';
import { extendedRouter } from './extended';

export const stellarRouter = Router();

stellarRouter.use('/accounts', accountsRouter);
stellarRouter.use('/anchors', anchorsRouter);
stellarRouter.use('/assets', classicAssetsRouter);
stellarRouter.use('/payments', paymentsRouter);
stellarRouter.use('/bridge', bridgeRouter);
stellarRouter.use('/overview', overviewRouter);
stellarRouter.use('/network-health', networkHealthRouter);

// Nice-to-have and stretch endpoints (SEP-38, visualizations, alerts, export, AI, swap)
stellarRouter.use(extendedRouter);
