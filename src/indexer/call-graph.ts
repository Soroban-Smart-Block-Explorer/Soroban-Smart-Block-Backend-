import { prismaRead } from '../db';

/**
 * Contract-to-contract call graph traversal.
 *
 * Reads the denormalized `contract_dependencies` table (sourceAddress calls
 * targetAddress, aggregated as `weight`) and returns a UI-ready node/edge
 * snapshot for an interactive "who calls whom" view.
 *
 * Two scopes are supported:
 *   - contract: BFS outward from a single address (upstream / downstream / both)
 *   - ecosystem: the whole bounded dependency graph (no address)
 *
 * Traversal is frontier-batched and cursor-paginated so large frontiers do not
 * load every row into memory at once.
 */

export const CALL_GRAPH_BATCH_SIZE = 1000;
export const DEFAULT_CALL_GRAPH_MAX_DEPTH = 3;
export const DEFAULT_CALL_GRAPH_MAX_NODES = 2000;
export const DEFAULT_CALL_GRAPH_MAX_EDGES = 5000;
export const DEFAULT_CALL_GRAPH_TIMEOUT_MS = 5000;

export type CallGraphDirection = 'upstream' | 'downstream' | 'both';
export type CallGraphScope = 'contract' | 'ecosystem';

export interface CallGraphOptions {
  /** Root contract. Omit for an ecosystem-wide snapshot. */
  address?: string;
  /** Which way to walk from the root. Ignored for ecosystem scope. */
  direction?: CallGraphDirection;
  maxDepth?: number;
  maxNodes?: number;
  maxEdges?: number;
  timeoutMs?: number;
  /** Drop edges below this weight (also stops traversal through them). */
  minWeight?: number;
  /** Include dependencies flagged inactive. Defaults to false. */
  includeInactive?: boolean;
}

export interface CallGraphNode {
  id: string;
  address: string;
  label: string;
  name: string | null;
  /** Hop distance from the root; null for ecosystem scope. */
  depth: number | null;
  inDegree: number;
  outDegree: number;
  /** Sum of incident edge weights. */
  callVolume: number;
  isRoot: boolean;
}

export interface CallGraphEdge {
  id: string;
  /** Caller. */
  source: string;
  /** Callee. */
  target: string;
  weight: number;
}

export interface CallGraphMetadata {
  scope: CallGraphScope;
  root: string | null;
  direction: CallGraphDirection;
  maxDepth: number;
  depthReached: number;
  minWeight: number;
  totalNodes: number;
  totalEdges: number;
  totalWeight: number;
  truncated: boolean;
  timedOut: boolean;
  cached: boolean;
  queryTimeMs: number;
  generatedAt: string;
}

export interface CallGraphResult {
  nodes: CallGraphNode[];
  edges: CallGraphEdge[];
  metadata: CallGraphMetadata;
}

/** Minimal database surface so callers/tests can inject a stub. */
export interface CallGraphDb {
  contractDependency: { findMany: (args: any) => Promise<any[]> };
  contract: { findMany: (args: any) => Promise<any[]> };
}

interface DependencyRow {
  id: string;
  sourceAddress: string;
  targetAddress: string;
  weight: number | null;
}

interface ResolvedOptions {
  address?: string;
  direction: CallGraphDirection;
  maxDepth: number;
  maxNodes: number;
  maxEdges: number;
  timeoutMs: number;
  minWeight: number;
  includeInactive: boolean;
}

const EDGE_KEY_SEPARATOR = '\u0000';

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function resolveOptions(options: CallGraphOptions = {}): ResolvedOptions {
  const address = typeof options.address === 'string' ? options.address.trim() : '';
  return {
    address: address.length > 0 ? address : undefined,
    direction: options.direction ?? 'both',
    maxDepth: clampInt(options.maxDepth, DEFAULT_CALL_GRAPH_MAX_DEPTH, 1, 10),
    maxNodes: clampInt(options.maxNodes, DEFAULT_CALL_GRAPH_MAX_NODES, 1, 100_000),
    maxEdges: clampInt(options.maxEdges, DEFAULT_CALL_GRAPH_MAX_EDGES, 1, 200_000),
    timeoutMs: clampInt(options.timeoutMs, DEFAULT_CALL_GRAPH_TIMEOUT_MS, 100, 30_000),
    minWeight: clampInt(options.minWeight, 1, 1, 1_000_000),
    includeInactive: options.includeInactive === true,
  };
}

function normalizeWeight(weight: number | null | undefined): number {
  if (typeof weight === 'number' && Number.isFinite(weight) && weight > 0) {
    return Math.floor(weight);
  }
  return 1;
}

export function shortContractAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-6)}` : address;
}

function buildWhere(
  opts: ResolvedOptions,
  frontier?: { direction: 'upstream' | 'downstream'; addresses: string[] },
): Record<string, unknown> {
  const where: Record<string, unknown> = {};
  if (frontier) {
    where[frontier.direction === 'upstream' ? 'targetAddress' : 'sourceAddress'] = {
      in: frontier.addresses,
    };
  }
  if (!opts.includeInactive) where.isActive = true;
  if (opts.minWeight > 1) where.weight = { gte: opts.minWeight };
  return where;
}

async function paginate(
  db: CallGraphDb,
  where: Record<string, unknown>,
  deadline: number,
  onBatch: (rows: DependencyRow[]) => boolean,
): Promise<{ timedOut: boolean }> {
  let cursor: string | undefined;

  for (;;) {
    if (Date.now() > deadline) return { timedOut: true };

    const batch = (await db.contractDependency.findMany({
      where,
      select: { id: true, sourceAddress: true, targetAddress: true, weight: true },
      orderBy: { id: 'asc' },
      take: CALL_GRAPH_BATCH_SIZE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    })) as DependencyRow[];

    if (!batch || batch.length === 0) break;

    // onBatch returns false to signal an early stop (budget exhausted).
    if (!onBatch(batch)) break;

    if (batch.length < CALL_GRAPH_BATCH_SIZE) break;
    cursor = batch[batch.length - 1].id;
  }

  return { timedOut: false };
}

async function loadContractNames(
  db: CallGraphDb,
  addresses: string[],
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  if (addresses.length === 0) return names;

  const contracts = (await db.contract.findMany({
    where: { address: { in: addresses } },
    select: { address: true, name: true },
  })) as Array<{ address: string; name: string | null }>;

  for (const contract of contracts) {
    if (contract.name) names.set(contract.address, contract.name);
  }
  return names;
}

export async function buildCallGraph(
  options: CallGraphOptions = {},
  db: CallGraphDb = prismaRead as unknown as CallGraphDb,
): Promise<CallGraphResult> {
  const startedAt = Date.now();
  const opts = resolveOptions(options);
  const deadline = startedAt + opts.timeoutMs;
  const root = opts.address;

  const edgeWeights = new Map<string, number>();
  const nodeAddresses = new Set<string>();
  const seenRows = new Set<string>();
  const depthOf = new Map<string, number>();

  let truncated = false;
  let timedOut = false;
  let depthReached = 0;

  const addEdge = (source: string, target: string, weight: number): boolean => {
    const newSource = !nodeAddresses.has(source);
    const newTarget = !nodeAddresses.has(target);
    const introduced = (newSource ? 1 : 0) + (newTarget ? 1 : 0);
    if (nodeAddresses.size + introduced > opts.maxNodes) {
      truncated = true;
      return false;
    }

    const key = `${source}${EDGE_KEY_SEPARATOR}${target}`;
    if (!edgeWeights.has(key) && edgeWeights.size >= opts.maxEdges) {
      truncated = true;
      return false;
    }

    if (newSource) nodeAddresses.add(source);
    if (newTarget) nodeAddresses.add(target);
    edgeWeights.set(key, (edgeWeights.get(key) ?? 0) + weight);
    return true;
  };

  if (!root) {
    // ── Ecosystem scope: the whole bounded dependency graph ──────────────────
    const { timedOut: pageTimedOut } = await paginate(db, buildWhere(opts), deadline, (batch) => {
      for (const row of batch) {
        const weight = normalizeWeight(row.weight);
        if (weight < opts.minWeight) continue;
        if (!addEdge(row.sourceAddress, row.targetAddress, weight)) return false;
      }
      return true;
    });
    timedOut = pageTimedOut;
  } else {
    // ── Contract scope: frontier BFS outward from the root ───────────────────
    nodeAddresses.add(root);
    depthOf.set(root, 0);

    const visited = new Set<string>([root]);
    let frontier: string[] = [root];

    for (let depth = 1; depth <= opts.maxDepth; depth += 1) {
      if (frontier.length === 0) break;
      if (Date.now() > deadline) {
        timedOut = true;
        break;
      }

      const directions: Array<'upstream' | 'downstream'> =
        opts.direction === 'both' ? ['upstream', 'downstream'] : [opts.direction];
      const nextFrontier = new Set<string>();

      for (const direction of directions) {
        const { timedOut: pageTimedOut } = await paginate(
          db,
          buildWhere(opts, { direction, addresses: frontier }),
          deadline,
          (batch) => {
            for (const row of batch) {
              if (seenRows.has(row.id)) continue;
              seenRows.add(row.id);

              const weight = normalizeWeight(row.weight);
              if (weight < opts.minWeight) continue;
              if (!addEdge(row.sourceAddress, row.targetAddress, weight)) return false;

              const discovered = direction === 'upstream' ? row.sourceAddress : row.targetAddress;
              if (visited.has(discovered)) continue;
              if (visited.size >= opts.maxNodes) {
                truncated = true;
                return false;
              }
              visited.add(discovered);
              depthOf.set(discovered, depth);
              nextFrontier.add(discovered);
            }
            return true;
          },
        );

        if (pageTimedOut) {
          timedOut = true;
          break;
        }
        if (truncated) break;
      }

      if (truncated || timedOut) break;

      if (nextFrontier.size > 0) {
        frontier = [...nextFrontier];
        depthReached = depth;
      } else {
        break;
      }
    }
  }

  // ── Assemble nodes + edges ──────────────────────────────────────────────────
  const addresses = [...nodeAddresses];
  const names = await loadContractNames(db, addresses);

  const inDegree = new Map<string, number>();
  const outDegree = new Map<string, number>();
  const callVolume = new Map<string, number>();
  const edges: CallGraphEdge[] = [];
  let totalWeight = 0;

  for (const [key, weight] of edgeWeights) {
    const separatorIndex = key.indexOf(EDGE_KEY_SEPARATOR);
    const source = key.slice(0, separatorIndex);
    const target = key.slice(separatorIndex + 1);

    edges.push({ id: `${source}->${target}`, source, target, weight });
    inDegree.set(target, (inDegree.get(target) ?? 0) + 1);
    outDegree.set(source, (outDegree.get(source) ?? 0) + 1);
    callVolume.set(source, (callVolume.get(source) ?? 0) + weight);
    callVolume.set(target, (callVolume.get(target) ?? 0) + weight);
    totalWeight += weight;
  }

  const nodes: CallGraphNode[] = addresses.map((address) => ({
    id: address,
    address,
    label: names.get(address) ?? shortContractAddress(address),
    name: names.get(address) ?? null,
    depth: root ? (depthOf.get(address) ?? null) : null,
    inDegree: inDegree.get(address) ?? 0,
    outDegree: outDegree.get(address) ?? 0,
    callVolume: callVolume.get(address) ?? 0,
    isRoot: address === root,
  }));

  nodes.sort((a, b) => {
    if (a.isRoot !== b.isRoot) return a.isRoot ? -1 : 1;
    const depthA = a.depth ?? Number.MAX_SAFE_INTEGER;
    const depthB = b.depth ?? Number.MAX_SAFE_INTEGER;
    if (depthA !== depthB) return depthA - depthB;
    return a.label.localeCompare(b.label);
  });

  edges.sort((a, b) =>
    a.source === b.source ? a.target.localeCompare(b.target) : a.source.localeCompare(b.source),
  );

  return {
    nodes,
    edges,
    metadata: {
      scope: root ? 'contract' : 'ecosystem',
      root: root ?? null,
      direction: root ? opts.direction : 'both',
      maxDepth: opts.maxDepth,
      depthReached: root ? depthReached : 0,
      minWeight: opts.minWeight,
      totalNodes: nodes.length,
      totalEdges: edges.length,
      totalWeight,
      truncated,
      timedOut,
      cached: false,
      queryTimeMs: Date.now() - startedAt,
      generatedAt: new Date().toISOString(),
    },
  };
}
