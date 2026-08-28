/**
 * Admin Dead-Letter Queue API
 *
 * Allows operators to inspect, reprocess, or purge dead-letter items.
 */

import { Router } from 'express';
import { requireAuth, requireRole } from '../../auth/middleware';
import { asyncHandler } from '../../middleware/asyncHandler';
import {
  getDeadLetterItems,
  reprocessDeadLetterItem,
  purgeDeadLetterItems,
} from '../../indexer/errorQueue';

export const deadLetterAdminRouter = Router();

// Require admin privileges
deadLetterAdminRouter.use(requireAuth);
deadLetterAdminRouter.use(requireRole('admin'));

/**
 * GET /api/v1/admin/dead-letter
 * List dead letter queue items with pagination.
 */
deadLetterAdminRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const limit = parseInt(req.query.limit as string) || 50;
    const offset = parseInt(req.query.offset as string) || 0;

    const data = await getDeadLetterItems(limit, offset);
    res.json({
      success: true,
      ...data,
    });
  }),
);

/**
 * POST /api/v1/admin/dead-letter/reprocess
 * Reprocess one or all dead-letter items.
 */
deadLetterAdminRouter.post(
  '/reprocess',
  asyncHandler(async (req, res) => {
    const { id } = req.body;
    if (id) {
      const success = await reprocessDeadLetterItem(id);
      res.json({ success, message: success ? `Item ${id} re-enqueued for retry` : 'Item not found' });
      return;
    }

    const allItems = await getDeadLetterItems(1000, 0);
    let reprocessed = 0;
    for (const item of allItems.items) {
      if (await reprocessDeadLetterItem(item.id)) {
        reprocessed++;
      }
    }
    res.json({ success: true, count: reprocessed, message: `${reprocessed} item(s) re-enqueued` });
  }),
);

/**
 * DELETE /api/v1/admin/dead-letter
 * Purge dead letter items.
 */
deadLetterAdminRouter.delete(
  '/',
  asyncHandler(async (req, res) => {
    const ids = req.body?.ids as string[] | undefined;
    const count = await purgeDeadLetterItems(ids);
    res.json({ success: true, count, message: `Purged ${count} dead letter item(s)` });
  }),
);
