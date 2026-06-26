import { Router, Request, Response } from 'express';
import { prismaRead as prisma } from '../db';
import { asyncHandler } from '../middleware/asyncHandler';

/**
 * @swagger
 * tags:
 *   name: VirtualList
 *   description: Optimized transaction payloads for infinite scroll components
 */

export const virtualListRouter = Router();

interface VirtualListItem {
  id: string;
  hash: string;
  contractAddress: string;
  status: string;
  ledger: number;
  timestamp: number;
  rowHeight: number; // exact calculated row height in pixels
  decoded?: string;
  displayDims?: {
    height: number; // pixel height the UI should reserve for this row
    components: {
      avatarSize: number;
      titleHeight: number;
      bodyHeight: number;
      metaHeight: number;
      padding: number;
    };
    contentWidth?: number; // optional available content width in pixels
  };
}

interface VirtualListPayload {
  items: VirtualListItem[];
  totalCount: number;
  hasMore: boolean;
  estimatedRowHeight: number;
}

const ESTIMATED_ROW_HEIGHT = 64; // fallback pixels

// Layout tuning constants (tuned to the default UI design)
const AVATAR_SIZE = 40; // px

const V_PADDING = 12; // vertical padding
const TITLE_LINE_HEIGHT = 20; // px
const BODY_LINE_HEIGHT = 18; // px
const META_LINE_HEIGHT = 16; // px
const CHARS_PER_LINE = 80; // approximate chars per line at default content width

/**
 * @swagger
 * /api/v1/virtual-list/transactions:
 *   get:
 *     summary: Get transactions in virtual list format for infinite scroll
 *     tags: [VirtualList]
 *     parameters:
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           default: 0
 *         description: Starting position in result set
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *         description: Number of items to return
 *       - in: query
 *         name: contract
 *         schema:
 *           type: string
 *         description: Filter by contract address
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [success, failed, pending]
 *         description: Filter by transaction status
 *     responses:
 *       200:
 *         description: Virtual list payload with flat structure
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 items:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id: { type: string }
 *                       hash: { type: string }
 *                       contractAddress: { type: string }
 *                       status: { type: string }
 *                       ledger: { type: integer }
 *                       timestamp: { type: number }
 *                       rowHeight: { type: number }
 *                       decoded: { type: string }
 *                 totalCount: { type: integer }
 *                 hasMore: { type: boolean }
 *                 estimatedRowHeight: { type: number }
 */
virtualListRouter.get(
  '/transactions',
  asyncHandler(async (req: Request, res: Response) => {
    const offset = Math.max(0, parseInt(String(req.query.offset ?? '0'), 10));
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? '50'), 10)));
    const contractFilter = req.query.contract as string | undefined;
    const statusFilter = req.query.status as string | undefined;

    const where: Record<string, unknown> = {};
    if (contractFilter) where.contractAddress = contractFilter;
    if (statusFilter) where.status = statusFilter;

    const [transactions, totalCount] = await Promise.all([
      prisma.transaction.findMany({
        where,
        select: {
          id: true,
          hash: true,
          contractAddress: true,
          status: true,
          ledgerSequence: true,
          ledgerCloseTime: true,
          humanReadable: true,
        },
        orderBy: { ledgerCloseTime: 'desc' },
        skip: offset,
        take: limit,
      }),
      prisma.transaction.count({ where }),
    ]);

    const items: VirtualListItem[] = transactions.map((tx) => ({
      id: tx.id,
      hash: tx.hash,
      contractAddress: tx.contractAddress || '',
      status: tx.status,
      ledger: tx.ledgerSequence,
      timestamp: tx.ledgerCloseTime.getTime(),
      decoded: tx.humanReadable || undefined,
      // compute an exact row height based on content size heuristics so the frontend
      // can reserve the correct space and avoid layout shifts when rendering.
      rowHeight: (() => {
        const titleLen = (tx.hash || '').length;
        const bodyLen = (tx.humanReadable || '').length;
        const titleLines = Math.max(1, Math.ceil(titleLen / CHARS_PER_LINE));
        const bodyLines = Math.max(0, Math.ceil(bodyLen / CHARS_PER_LINE));
        const titleHeight = titleLines * TITLE_LINE_HEIGHT;
        const bodyHeight = bodyLines * BODY_LINE_HEIGHT;
        const metaHeight = META_LINE_HEIGHT; // single meta line
        const contentHeight = titleHeight + bodyHeight + metaHeight;
        const minContentHeight = Math.max(AVATAR_SIZE, contentHeight);
        const total = minContentHeight + V_PADDING * 2;
        return Math.max(ESTIMATED_ROW_HEIGHT, Math.ceil(total));
      })(),
      displayDims: (() => {
        const titleLen = (tx.hash || '').length;
        const bodyLen = (tx.humanReadable || '').length;
        const titleLines = Math.max(1, Math.ceil(titleLen / CHARS_PER_LINE));
        const bodyLines = Math.max(0, Math.ceil(bodyLen / CHARS_PER_LINE));
        const titleHeight = titleLines * TITLE_LINE_HEIGHT;
        const bodyHeight = bodyLines * BODY_LINE_HEIGHT;
        const metaHeight = META_LINE_HEIGHT;
        const components = {
          avatarSize: AVATAR_SIZE,
          titleHeight,
          bodyHeight,
          metaHeight,
          padding: V_PADDING,
        };
        const height = Math.max(AVATAR_SIZE, titleHeight + bodyHeight + metaHeight) + V_PADDING * 2;
        return {
          height: Math.max(ESTIMATED_ROW_HEIGHT, Math.ceil(height)),
          components,
          contentWidth: undefined,
        };
      })(),
    }));

    const payload: VirtualListPayload = {
      items,
      totalCount,
      hasMore: offset + limit < totalCount,
      estimatedRowHeight: ESTIMATED_ROW_HEIGHT,
    };

    res.json(payload);
  }),
);

/**
 * @swagger
 * /api/v1/virtual-list/events:
 *   get:
 *     summary: Get events in virtual list format for infinite scroll
 *     tags: [VirtualList]
 *     parameters:
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           default: 0
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *       - in: query
 *         name: contract
 *         schema:
 *           type: string
 *       - in: query
 *         name: type
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Virtual list payload
 */
virtualListRouter.get(
  '/events',
  asyncHandler(async (req: Request, res: Response) => {
    const offset = Math.max(0, parseInt(String(req.query.offset ?? '0'), 10));
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? '50'), 10)));
    const contractFilter = req.query.contract as string | undefined;
    const typeFilter = req.query.type as string | undefined;

    const where: Record<string, unknown> = {};
    if (contractFilter) where.contractAddress = contractFilter;
    if (typeFilter) where.eventType = typeFilter;

    const [events, totalCount] = await Promise.all([
      prisma.event.findMany({
        where,
        select: {
          id: true,
          contractAddress: true,
          eventType: true,
          ledgerSequence: true,
          ledgerCloseTime: true,
          decoded: true,
        },
        orderBy: { ledgerCloseTime: 'desc' },
        skip: offset,
        take: limit,
      }),
      prisma.event.count({ where }),
    ]);

    const items: VirtualListItem[] = events.map((event) => ({
      id: event.id,
      hash: event.id,
      contractAddress: event.contractAddress,
      status: event.eventType,
      ledger: event.ledgerSequence,
      timestamp: event.ledgerCloseTime.getTime(),
      decoded: JSON.stringify(event.decoded),
      rowHeight: (() => {
        const titleLen = (event.eventType || '').length;
        const bodyLen = JSON.stringify(event.decoded || '').length;
        const titleLines = Math.max(1, Math.ceil(titleLen / CHARS_PER_LINE));
        const bodyLines = Math.max(0, Math.ceil(bodyLen / CHARS_PER_LINE));
        const titleHeight = titleLines * TITLE_LINE_HEIGHT;
        const bodyHeight = bodyLines * BODY_LINE_HEIGHT;
        const metaHeight = META_LINE_HEIGHT;
        const contentHeight = titleHeight + bodyHeight + metaHeight;
        const minContentHeight = Math.max(AVATAR_SIZE, contentHeight);
        const total = minContentHeight + V_PADDING * 2;
        return Math.max(ESTIMATED_ROW_HEIGHT, Math.ceil(total));
      })(),
      displayDims: (() => {
        const titleLen = (event.eventType || '').length;
        const bodyLen = JSON.stringify(event.decoded || '').length;
        const titleLines = Math.max(1, Math.ceil(titleLen / CHARS_PER_LINE));
        const bodyLines = Math.max(0, Math.ceil(bodyLen / CHARS_PER_LINE));
        const titleHeight = titleLines * TITLE_LINE_HEIGHT;
        const bodyHeight = bodyLines * BODY_LINE_HEIGHT;
        const metaHeight = META_LINE_HEIGHT;
        const components = {
          avatarSize: AVATAR_SIZE,
          titleHeight,
          bodyHeight,
          metaHeight,
          padding: V_PADDING,
        };
        const height = Math.max(AVATAR_SIZE, titleHeight + bodyHeight + metaHeight) + V_PADDING * 2;
        return {
          height: Math.max(ESTIMATED_ROW_HEIGHT, Math.ceil(height)),
          components,
          contentWidth: undefined,
        };
      })(),
    }));

    const payload: VirtualListPayload = {
      items,
      totalCount,
      hasMore: offset + limit < totalCount,
      estimatedRowHeight: ESTIMATED_ROW_HEIGHT,
    };

    res.json(payload);
  }),
);
