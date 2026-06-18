import { Router } from 'express';
import { emergencyRouter } from './emergency';
import { incidentRouter } from './emergency-incidents';
import { healthRouter } from './emergency-health';
import { analysisRouter } from './emergency-analysis';
import { alertConfigRouter } from './emergency-alerts';
import { vizRouter } from './emergency-viz';

export const emergencyBaseRouter = Router();

// Core emergency routes (overview, contracts, events, stats, recovery-simulation)
emergencyBaseRouter.use('/', emergencyRouter);

// Incidents
emergencyBaseRouter.use('/incidents', incidentRouter);

// Protocol health
emergencyBaseRouter.use('/protocol-health', healthRouter);

// Historical analysis & reports
emergencyBaseRouter.use('/analysis', analysisRouter);
emergencyBaseRouter.use('/reports', analysisRouter);

// Alert configurations
emergencyBaseRouter.use('/alerts', alertConfigRouter);

// Visualizations & export
emergencyBaseRouter.use('/visualizations', vizRouter);
emergencyBaseRouter.use('/export', vizRouter);
