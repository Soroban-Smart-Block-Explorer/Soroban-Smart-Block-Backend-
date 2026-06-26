import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { getStateAtLedger, getKeyHistory, getLedgerDiff, getFullSnapshot } from '../archive/query-engine';
import { captureStateChangesForTransaction } from '../archive/archiver';
import { decodeScValXdr } from '../archive/scval-decoder';

export const archiveRouter = Router({ mergeParams: true });

const ledgerQuery = z.object({
  ledger: z.coerce.number().int().positive(),
});

const diffQuery = z.object({
  from: z.coerce.number().int().positive(),
  to: z.coerce.number().int().positive(),
});

const historyQuery = z.object({
  key: z.string().min(1),
});

const stateQuery = z.object({
  ledger: z.coerce.number().int().positive(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(1000).default(100),
  search: z.string().optional(),
});

/**
 * GET /contracts/:address/state?ledger=N
 * Storage state at a specific ledger (with pagination)
 */
archiveRouter.get('/', async (req: Request, res: Response) => {
  const { address } = req.params;
  const parsed = stateQuery.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const result = await getStateAtLedger(address, parsed.data.ledger, {
      page: parsed.data.page,
      pageSize: parsed.data.pageSize,
      search: parsed.data.search,
    });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

/**
 * GET /contracts/:address/state/history?key=<base64_key>
 * Full value history for a specific storage key
 */
archiveRouter.get('/history', async (req: Request, res: Response) => {
  const { address } = req.params;
  const parsed = historyQuery.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const result = await getKeyHistory(address, parsed.data.key);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

/**
 * GET /contracts/:address/state/diff?from=N&to=M
 * Diff between two ledgers showing what changed
 */
archiveRouter.get('/diff', async (req: Request, res: Response) => {
  const { address } = req.params;
  const parsed = diffQuery.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  if (parsed.data.from >= parsed.data.to) {
    return res.status(400).json({ error: '"from" must be less than "to"' });
  }

  try {
    const result = await getLedgerDiff(address, parsed.data.from, parsed.data.to);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

/**
 * GET /contracts/:address/state/snapshot?ledger=N
 * Full human-readable state snapshot at any ledger
 */
archiveRouter.get('/snapshot', async (req: Request, res: Response) => {
  const { address } = req.params;
  const parsed = ledgerQuery.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const result = await getFullSnapshot(address, parsed.data.ledger);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

/**
 * POST /contracts/:address/state/ingest
 * Ingest state change records (called by indexer or external pipeline)
 */
archiveRouter.post('/ingest', async (req: Request, res: Response) => {
  const { address } = req.params;
  const schema = z.object({
    transactionHash: z.string(),
    ledger: z.number().int().positive(),
    ledgerCloseTime: z.string().datetime(),
    changes: z.array(z.object({
      key: z.string(),
      before: z.string().optional(),
      after: z.string().optional(),
    })).min(1).max(500),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const saved = await captureStateChangesForTransaction(
      address,
      parsed.data.transactionHash,
      parsed.data.ledger,
      new Date(parsed.data.ledgerCloseTime),
      parsed.data.changes,
    );
    res.status(201).json({ saved });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

/**
 * GET /contracts/:address/state/decode
 * Decode a raw XDR ScVal to human-readable format
 */
archiveRouter.get('/decode', (req: Request, res: Response) => {
  const xdrB64 = req.query.xdr as string;
  if (!xdrB64) return res.status(400).json({ error: 'Missing xdr query parameter' });
  try {
    const human = decodeScValXdr(xdrB64);
    res.json({ xdr: xdrB64, human });
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});
