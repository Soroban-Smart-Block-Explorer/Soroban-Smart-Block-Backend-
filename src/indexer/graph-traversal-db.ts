import { prisma } from '../db';

export const BATCH_SIZE = 1000;
export const DEFAULT_MAX_DEPTH = 5;
export const DEFAULT_MAX_NODES = 10000;
export const DEFAULT_TIMEOUT_MS = 5000;

export interface FrontierBfsOptions {
  maxDepth?: number;
  maxNodes?: number;
  timeoutMs?: number;
}

export interface FrontierBfsResult {
  nodes: string[];
  edges: Array<{ source: string; target: string }>;
  depthReached: number;
  totalNodes: number;
  totalEdges: number;
  truncated: boolean;
  timedOut: boolean;
}

export async function traverseUpstream(
  address: string,
  opts: FrontierBfsOptions = {},
): Promise<FrontierBfsResult> {
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxNodes = opts.maxNodes ?? DEFAULT_MAX_NODES;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const startTime = Date.now();
  const visited = new Set<string>([address]);
  const edges: Array<{ source: string; target: string }> = [];
  let frontier = new Set<string>([address]);
  let depthReached = 0;
  let truncated = false;
  let timedOut = false;

  for (let depth = 1; depth <= maxDepth; depth += 1) {
    if (frontier.size === 0) break;

    if (Date.now() - startTime > timeoutMs) {
      timedOut = true;
      break;
    }

    if (visited.size >= maxNodes) {
      truncated = true;
      break;
    }

    const nextFrontier = new Set<string>();
    const frontierArray = [...frontier];
    let lastCursor: string | undefined;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (Date.now() - startTime > timeoutMs) {
        timedOut = true;
        break;
      }

      const rows = await prisma.contractDependency.findMany({
        where: {
          targetAddress: { in: frontierArray },
          isActive: true,
        },
        select: {
          sourceAddress: true,
          targetAddress: true,
          id: true,
        },
        take: BATCH_SIZE,
        ...(lastCursor ? { cursor: { id: lastCursor }, skip: 1 } : {}),
      });

      if (!rows || rows.length === 0) break;

      for (const row of rows) {
        if (visited.has(row.sourceAddress)) continue;
        visited.add(row.sourceAddress);
        nextFrontier.add(row.sourceAddress);
        edges.push({ source: row.sourceAddress, target: row.targetAddress });

        if (visited.size >= maxNodes) {
          truncated = true;
          break;
        }
      }

      if (truncated || rows.length < BATCH_SIZE) break;
      lastCursor = rows[rows.length - 1].id;
    }

    if (timedOut || truncated) break;

    if (nextFrontier.size > 0) {
      frontier = nextFrontier;
      depthReached = depth;
    } else if (depth > 1) {
      // depth 1 with no deps: nothing was found
      // deeper levels with no deps: we completed exploring deeper
      depthReached = depth;
      break;
    } else {
      break;
    }
  }

  return {
    nodes: [...visited],
    edges,
    depthReached,
    totalNodes: visited.size,
    totalEdges: edges.length,
    truncated,
    timedOut,
  };
}

export async function traverseDownstream(
  address: string,
  opts: FrontierBfsOptions = {},
): Promise<FrontierBfsResult> {
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxNodes = opts.maxNodes ?? DEFAULT_MAX_NODES;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const startTime = Date.now();
  const visited = new Set<string>([address]);
  const edges: Array<{ source: string; target: string }> = [];
  let frontier = new Set<string>([address]);
  let depthReached = 0;
  let truncated = false;
  let timedOut = false;

  for (let depth = 1; depth <= maxDepth; depth += 1) {
    if (frontier.size === 0) break;

    if (Date.now() - startTime > timeoutMs) {
      timedOut = true;
      break;
    }

    if (visited.size >= maxNodes) {
      truncated = true;
      break;
    }

    const nextFrontier = new Set<string>();
    const frontierArray = [...frontier];
    let lastCursor: string | undefined;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (Date.now() - startTime > timeoutMs) {
        timedOut = true;
        break;
      }

      const rows = await prisma.contractDependency.findMany({
        where: {
          sourceAddress: { in: frontierArray },
          isActive: true,
        },
        select: {
          sourceAddress: true,
          targetAddress: true,
          id: true,
        },
        take: BATCH_SIZE,
        ...(lastCursor ? { cursor: { id: lastCursor }, skip: 1 } : {}),
      });

      if (!rows || rows.length === 0) break;

      for (const row of rows) {
        if (visited.has(row.targetAddress)) continue;
        visited.add(row.targetAddress);
        nextFrontier.add(row.targetAddress);
        edges.push({ source: row.sourceAddress, target: row.targetAddress });

        if (visited.size >= maxNodes) {
          truncated = true;
          break;
        }
      }

      if (truncated || rows.length < BATCH_SIZE) break;
      lastCursor = rows[rows.length - 1].id;
    }

    if (timedOut || truncated) break;

    if (nextFrontier.size > 0) {
      frontier = nextFrontier;
      depthReached = depth;
    } else if (depth > 1) {
      depthReached = depth;
      break;
    } else {
      break;
    }
  }

  return {
    nodes: [...visited],
    edges,
    depthReached,
    totalNodes: visited.size,
    totalEdges: edges.length,
    truncated,
    timedOut,
  };
}
