import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/asyncHandler';
import { NotificationService } from './notificationService';
import { SubscriptionMatcher } from './subscriptionMatcher';

export const notificationRouter = Router();

const notificationService = new NotificationService({
  fcmApiKey: process.env.FCM_API_KEY,
  apnsKey: process.env.APNS_KEY,
  vapidKeys:
    process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY
      ? { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY }
      : undefined,
});

const subscriptionMatcher = new SubscriptionMatcher();

const registerSchema = z.object({
  token: z.string(),
  platform: z.enum(['ios', 'android', 'web']),
  deviceId: z.string().optional(),
});

const subscriptionSchema = z.object({
  token: z.string(),
  subscriptions: z.array(z.string()),
});

const quietHoursSchema = z.object({
  token: z.string(),
  quietHours: z.object({
    start: z.string(),
    end: z.string(),
    timezone: z.string(),
    emergencyOverride: z.boolean().default(true),
  }),
});

notificationRouter.post(
  '/push/register',
  asyncHandler(async (req: Request, res: Response) => {
    const body = registerSchema.parse(req.body);
    res.json({ success: true, token: body.token });
  }),
);

notificationRouter.post(
  '/push/unregister',
  asyncHandler(async (req: Request, res: Response) => {
    res.json({ success: true });
  }),
);

notificationRouter.put(
  '/push/subscriptions',
  asyncHandler(async (req: Request, res: Response) => {
    const body = subscriptionSchema.parse(req.body);
    res.json({ success: true });
  }),
);

notificationRouter.put(
  '/push/quiet-hours',
  asyncHandler(async (req: Request, res: Response) => {
    const body = quietHoursSchema.parse(req.body);
    res.json({ success: true });
  }),
);

notificationRouter.get(
  '/push/analytics',
  asyncHandler(async (_req: Request, res: Response) => {
    res.json(notificationService.getAnalytics());
  }),
);

notificationRouter.get(
  '/push/delivery-log',
  asyncHandler(async (_req: Request, res: Response) => {
    res.json(notificationService.getDeliveryLog());
  }),
);
