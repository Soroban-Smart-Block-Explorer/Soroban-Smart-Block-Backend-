import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/asyncHandler';
import {
  getStatusSummary,
  getDailyUptimeHistory,
  getLatencyHistory,
  getStatusIncidents,
  createStatusIncident,
  updateStatusIncident,
  type SystemIndicator,
} from '../services/status-service';

export const statusRouter = Router();

const incidentCreateSchema = z.object({
  title: z.string().min(3).max(255),
  impact: z.enum(['none', 'minor', 'major', 'critical']),
  affectedComponents: z.array(z.string()).min(1),
  message: z.string().min(5),
  status: z.enum(['investigating', 'identified', 'monitoring', 'resolved']).optional(),
});

const incidentUpdateSchema = z.object({
  status: z.enum(['investigating', 'identified', 'monitoring', 'resolved']),
  message: z.string().min(5),
});

/**
 * GET /status (or /api/v1/status)
 * Full public status page payload consumed by web dashboards, status displays, and external monitors.
 */
statusRouter.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const detailed = req.query.detailed === 'true';
    const summary = await getStatusSummary(detailed);

    res.json({
      success: true,
      data: summary,
    });
  }),
);

/**
 * GET /status/components
 * Component breakdown with current health state and latency.
 */
statusRouter.get(
  '/components',
  asyncHandler(async (req: Request, res: Response) => {
    const detailed = req.query.detailed === 'true';
    const summary = await getStatusSummary(detailed);

    res.json({
      success: true,
      data: {
        components: summary.components,
        indicator: summary.indicator,
        description: summary.description,
        timestamp: summary.timestamp,
      },
    });
  }),
);

/**
 * GET /status/uptime
 * Historical daily uptime percentages (default: 90 days).
 */
statusRouter.get(
  '/uptime',
  asyncHandler(async (req: Request, res: Response) => {
    const days = Math.min(365, Math.max(1, parseInt(req.query.days as string, 10) || 90));
    const history = getDailyUptimeHistory(days);

    res.json({
      success: true,
      data: {
        days,
        history,
        averages: {
          '24h': history[history.length - 1]?.uptimePercentage ?? 100.0,
          '7d':
            Math.round(
              (history.slice(-7).reduce((acc, h) => acc + h.uptimePercentage, 0) /
                Math.min(7, history.length)) *
                100,
            ) / 100,
          '30d':
            Math.round(
              (history.slice(-30).reduce((acc, h) => acc + h.uptimePercentage, 0) /
                Math.min(30, history.length)) *
                100,
            ) / 100,
          '90d':
            Math.round(
              (history.reduce((acc, h) => acc + h.uptimePercentage, 0) / history.length) * 100,
            ) / 100,
        },
      },
    });
  }),
);

/**
 * GET /status/latency
 * Historical latency measurements (default: 24 hours).
 */
statusRouter.get(
  '/latency',
  asyncHandler(async (req: Request, res: Response) => {
    const hours = Math.min(168, Math.max(1, parseInt(req.query.hours as string, 10) || 24));
    const points = getLatencyHistory(hours);

    res.json({
      success: true,
      data: {
        hours,
        dataPoints: points,
      },
    });
  }),
);

/**
 * GET /status/incidents
 * Incident log with status and update history.
 */
statusRouter.get(
  '/incidents',
  asyncHandler(async (req: Request, res: Response) => {
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string, 10) || 10));
    const incidents = await getStatusIncidents(limit);

    res.json({
      success: true,
      data: {
        total: incidents.length,
        incidents,
      },
    });
  }),
);

/**
 * GET /status/incidents/:id
 * Retrieve a specific incident record and update timeline.
 */
statusRouter.get(
  '/incidents/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const incidents = await getStatusIncidents(100);
    const incident = incidents.find((i) => i.id === req.params.id);

    if (!incident) {
      return res.status(404).json({
        success: false,
        error: 'Incident not found',
      });
    }

    res.json({
      success: true,
      data: incident,
    });
  }),
);

/**
 * POST /status/incidents
 * Create or report an operational incident.
 */
statusRouter.post(
  '/incidents',
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = incidentCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        error: 'Invalid incident payload',
        details: parsed.error.flatten(),
      });
    }

    const incident = await createStatusIncident({
      title: parsed.data.title,
      impact: parsed.data.impact,
      affectedComponents: parsed.data.affectedComponents,
      message: parsed.data.message,
      status: parsed.data.status,
    });
    res.status(201).json({
      success: true,
      data: incident,
    });
  }),
);

/**
 * PATCH /status/incidents/:id
 * Update incident status or post a new timeline update.
 */
statusRouter.patch(
  '/incidents/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = incidentUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        error: 'Invalid incident update payload',
        details: parsed.error.flatten(),
      });
    }

    const updated = updateStatusIncident(req.params.id, {
      status: parsed.data.status,
      message: parsed.data.message,
    });
    if (!updated) {
      return res.status(404).json({
        success: false,
        error: 'Incident not found',
      });
    }

    res.json({
      success: true,
      data: updated,
    });
  }),
);

/**
 * GET /status/badge
 * Shields.io compatible JSON badge endpoint for GitHub READMEs.
 */
statusRouter.get(
  '/badge',
  asyncHandler(async (_req: Request, res: Response) => {
    const summary = await getStatusSummary(false);
    const colorMap: Record<SystemIndicator, string> = {
      none: 'brightgreen',
      minor: 'yellow',
      major: 'orange',
      critical: 'red',
    };

    const labelMap: Record<SystemIndicator, string> = {
      none: 'operational',
      minor: 'degraded',
      major: 'partial outage',
      critical: 'outage',
    };

    res.json({
      schemaVersion: 1,
      label: 'status',
      message: labelMap[summary.indicator] || 'unknown',
      color: colorMap[summary.indicator] || 'lightgrey',
      cacheSeconds: 60,
    });
  }),
);
