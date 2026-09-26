import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/asyncHandler';
import { AppError } from '../middleware/errorHandler';
import {
  NOTIFICATION_CATEGORIES,
  deleteNotification,
  getPreferences,
  listNotifications,
  markRead,
  setPreferences,
  unreadCount,
} from '../notifications/notificationCenter';

export const notificationCenterRouter = Router();

const listQuerySchema = z.object({
  category: z.enum(NOTIFICATION_CATEGORIES).optional(),
  unread: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const markSchema = z.object({
  ids: z.union([z.array(z.string()).min(1).max(500), z.literal('all')]),
  read: z.boolean().default(true),
});

const preferencesSchema = z.object({
  mutedCategories: z.array(z.enum(NOTIFICATION_CATEGORIES)).optional(),
  channels: z
    .object({ inbox: z.boolean(), webhook: z.boolean(), sse: z.boolean() })
    .partial()
    .optional(),
});

function requireUser(req: Request): string {
  const userId = req.headers['x-user-id'];
  if (typeof userId !== 'string' || !userId) throw new AppError(401, 'x-user-id header required');
  return userId;
}

notificationCenterRouter.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const q = listQuerySchema.parse(req.query);
    res.json(
      listNotifications(requireUser(req), {
        category: q.category,
        unreadOnly: q.unread === 'true',
        limit: q.limit,
        offset: q.offset,
      }),
    );
  }),
);

notificationCenterRouter.get(
  '/unread-count',
  asyncHandler(async (req: Request, res: Response) => {
    res.json({ unread: unreadCount(requireUser(req)) });
  }),
);

notificationCenterRouter.post(
  '/read',
  asyncHandler(async (req: Request, res: Response) => {
    const { ids, read } = markSchema.parse(req.body);
    res.json({ updated: markRead(requireUser(req), ids, read) });
  }),
);

notificationCenterRouter.get(
  '/preferences',
  asyncHandler(async (req: Request, res: Response) => {
    res.json({ data: getPreferences(requireUser(req)) });
  }),
);

notificationCenterRouter.put(
  '/preferences',
  asyncHandler(async (req: Request, res: Response) => {
    res.json({ data: setPreferences(requireUser(req), preferencesSchema.parse(req.body)) });
  }),
);

notificationCenterRouter.delete(
  '/:id',
  asyncHandler(async (req: Request, res: Response) => {
    if (!deleteNotification(requireUser(req), req.params.id)) {
      throw new AppError(404, 'Notification not found');
    }
    res.status(204).end();
  }),
);
