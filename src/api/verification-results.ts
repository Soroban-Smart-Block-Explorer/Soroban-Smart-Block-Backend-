import { Router, Request, Response } from 'express';
import { asyncHandler } from '../middleware/asyncHandler';

export const verificationResultsRouter = Router();

export type PropertyStatus = 'proven' | 'violated' | 'unknown' | 'timeout';

export interface VerificationProperty {
  name: string;
  status: PropertyStatus;
  detail?: string;
}

export interface VerificationResult {
  id: string;
  contractAddress: string;
  tool: string;
  toolVersion?: string;
  properties: VerificationProperty[];
  coverage: number; // 0..1 fraction of functions covered by specs
  ingestedAt: string;
}

export interface VerificationDisplay {
  contractAddress: string;
  contractUrl: string;
  proven: number;
  total: number;
  provenRatio: number;
  coverage: number;
  status: 'verified' | 'partial' | 'failed' | 'unverified';
  latest: VerificationResult | null;
}

const STATUSES: PropertyStatus[] = ['proven', 'violated', 'unknown', 'timeout'];
const ADDRESS_RE = /^C[A-Z2-7]{55}$/;
const MAX_PROPERTIES = 1000;

/** In-memory store, latest-first per contract. */
const store = new Map<string, VerificationResult[]>();
let seq = 0;

export function resetVerificationStore(): void {
  store.clear();
  seq = 0;
}

export function parseIngestPayload(
  body: any,
): { ok: true; value: Omit<VerificationResult, 'id' | 'ingestedAt'> } | { ok: false; error: string } {
  if (!body || typeof body !== 'object') return { ok: false, error: 'Body must be an object' };
  if (typeof body.contractAddress !== 'string' || !ADDRESS_RE.test(body.contractAddress)) {
    return { ok: false, error: 'Invalid contractAddress' };
  }
  if (typeof body.tool !== 'string' || body.tool.length === 0 || body.tool.length > 100) {
    return { ok: false, error: 'tool is required (max 100 chars)' };
  }
  if (!Array.isArray(body.properties) || body.properties.length > MAX_PROPERTIES) {
    return { ok: false, error: `properties must be an array of at most ${MAX_PROPERTIES}` };
  }
  const properties: VerificationProperty[] = [];
  for (const p of body.properties) {
    if (!p || typeof p.name !== 'string' || !p.name || !STATUSES.includes(p.status)) {
      return { ok: false, error: `each property needs a name and status in ${STATUSES.join('|')}` };
    }
    properties.push({
      name: p.name.slice(0, 200),
      status: p.status,
      detail: typeof p.detail === 'string' ? p.detail.slice(0, 1000) : undefined,
    });
  }
  const coverage = body.coverage === undefined ? 0 : Number(body.coverage);
  if (!Number.isFinite(coverage) || coverage < 0 || coverage > 1) {
    return { ok: false, error: 'coverage must be a number between 0 and 1' };
  }
  return {
    ok: true,
    value: {
      contractAddress: body.contractAddress,
      tool: body.tool,
      toolVersion: typeof body.toolVersion === 'string' ? body.toolVersion.slice(0, 50) : undefined,
      properties,
      coverage,
    },
  };
}

export function ingestVerificationResult(
  value: Omit<VerificationResult, 'id' | 'ingestedAt'>,
): VerificationResult {
  const result: VerificationResult = {
    ...value,
    id: `vr_${++seq}`,
    ingestedAt: new Date().toISOString(),
  };
  const list = store.get(value.contractAddress) ?? [];
  list.unshift(result);
  store.set(value.contractAddress, list.slice(0, 50));
  return result;
}

export function buildDisplay(address: string): VerificationDisplay {
  const latest = store.get(address)?.[0] ?? null;
  const total = latest?.properties.length ?? 0;
  const proven = latest?.properties.filter((p) => p.status === 'proven').length ?? 0;
  const violated = latest?.properties.some((p) => p.status === 'violated') ?? false;
  return {
    contractAddress: address,
    contractUrl: `/api/v1/contracts/${address}`,
    proven,
    total,
    provenRatio: total ? proven / total : 0,
    coverage: latest?.coverage ?? 0,
    status: !latest ? 'unverified' : violated ? 'failed' : proven === total && total > 0 ? 'verified' : 'partial',
    latest,
  };
}

/** POST /verification-results - ingest a result set (per docs/FORMAL_VERIFICATION_DESIGN.md). */
verificationResultsRouter.post(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = parseIngestPayload(req.body);
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });
    const result = ingestVerificationResult(parsed.value);
    res.status(201).json(result);
  }),
);

/** GET /verification-results/:address - display model for a contract page. */
verificationResultsRouter.get(
  '/:address',
  asyncHandler(async (req: Request, res: Response) => {
    const address = String(req.params.address);
    if (!ADDRESS_RE.test(address)) return res.status(400).json({ error: 'Invalid contract address' });
    res.json(buildDisplay(address));
  }),
);

/** GET /verification-results/:address/history - all stored results, newest first. */
verificationResultsRouter.get(
  '/:address/history',
  asyncHandler(async (req: Request, res: Response) => {
    const address = String(req.params.address);
    if (!ADDRESS_RE.test(address)) return res.status(400).json({ error: 'Invalid contract address' });
    res.json({ contractAddress: address, results: store.get(address) ?? [] });
  }),
);
