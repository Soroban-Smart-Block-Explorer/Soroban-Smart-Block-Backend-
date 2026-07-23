/**
 * src/services/governance/delegation.ts
 *
 * Liquid-democracy delegation resolution (docs/governance-framework.md §6).
 *
 * Delegations form a directed graph of (delegator -> delegatee) edges scoped
 * per category. Voting power for V = own power − power delegated away +
 * power of inbound chains, resolved recursively to MAX_DELEGATION_DEPTH with
 * cycle protection: each wallet contributes at most once.
 *
 * The resolver is pure: edges and balances are injected, so it runs
 * identically against Prisma rows, indexed snapshots, or test fixtures.
 */

export const MAX_DELEGATION_DEPTH = 10;

export interface DelegationEdge {
  delegator: string;
  delegatee: string;
  category: string; // 'all' or a contract-configured category
  revokedAt?: Date | null;
}

export interface DelegationGraph {
  /** Active inbound edges per delegatee (revoked edges filtered by caller or here). */
  inbound: Map<string, DelegationEdge[]>;
  /** Active outbound edge per (delegator) — a wallet delegates a category once. */
  outbound: Map<string, DelegationEdge[]>;
}

/** Build lookup maps from raw edges, dropping revoked ones. */
export function buildGraph(edges: DelegationEdge[]): DelegationGraph {
  const inbound = new Map<string, DelegationEdge[]>();
  const outbound = new Map<string, DelegationEdge[]>();
  for (const edge of edges) {
    if (edge.revokedAt) continue;
    if (edge.delegator === edge.delegatee) continue; // self-delegation is a no-op
    const inList = inbound.get(edge.delegatee) ?? [];
    inList.push(edge);
    inbound.set(edge.delegatee, inList);
    const outList = outbound.get(edge.delegator) ?? [];
    outList.push(edge);
    outbound.set(edge.delegator, outList);
  }
  return { inbound, outbound };
}

/** Does `edge` apply to a proposal in `category`? ('all' edges always do.) */
function applies(edge: DelegationEdge, category: string): boolean {
  return edge.category === 'all' || edge.category === category;
}

/** True when `wallet` has an active outbound delegation covering `category`. */
export function hasDelegatedAway(
  graph: DelegationGraph,
  wallet: string,
  category: string,
): boolean {
  return (graph.outbound.get(wallet) ?? []).some((e) => applies(e, category));
}

/**
 * Resolve the full voting power `delegatee` may exercise for `category`:
 * own balance (unless delegated away) + inbound chains up to depth 10.
 *
 * `getOwnPower` is the wallet's raw snapshot power (token balance).
 * `includeOwnPower: 'always'` counts the wallet's own balance even when it
 * has an outbound delegation — used for override resolution, where an
 * explicit vote cancels the wallet's own delegation (docs §6).
 * Cycle-safe: a visited set guarantees each wallet is counted at most once;
 * on a cycle A->B->A the walk simply stops when it re-encounters a wallet.
 */
export async function resolveVotingPower(params: {
  graph: DelegationGraph;
  wallet: string;
  category: string;
  getOwnPower: (wallet: string) => Promise<bigint>;
  maxDepth?: number;
  includeOwnPower?: 'unless-delegated' | 'always';
}): Promise<bigint> {
  const { graph, wallet, category, getOwnPower } = params;
  const maxDepth = params.maxDepth ?? MAX_DELEGATION_DEPTH;
  const includeOwn = params.includeOwnPower ?? 'unless-delegated';
  const visited = new Set<string>([wallet]);

  // Own power counts unless this wallet has itself delegated the category away.
  let power =
    includeOwn === 'unless-delegated' && hasDelegatedAway(graph, wallet, category)
      ? 0n
      : await getOwnPower(wallet);

  async function walkInbound(node: string, depth: number): Promise<void> {
    if (depth >= maxDepth) return;
    for (const edge of graph.inbound.get(node) ?? []) {
      if (!applies(edge, category)) continue;
      const upstream = edge.delegator;
      if (visited.has(upstream)) continue; // cycle or diamond — count once
      visited.add(upstream);
      power += await getOwnPower(upstream);
      await walkInbound(upstream, depth + 1);
    }
  }

  await walkInbound(wallet, 0);
  return power;
}

/**
 * Adjust a delegate's resolved power when one of their delegators voted
 * directly on this proposal (explicit vote overrides delegation, docs §6):
 * subtract each overriding delegator's own power from the delegate's total.
 */
export async function subtractOverrides(params: {
  graph: DelegationGraph;
  delegatee: string;
  category: string;
  resolvedPower: bigint;
  directVoters: Set<string>;
  getOwnPower: (wallet: string) => Promise<bigint>;
  maxDepth?: number;
}): Promise<bigint> {
  const { graph, delegatee, category, directVoters, getOwnPower } = params;
  const maxDepth = params.maxDepth ?? MAX_DELEGATION_DEPTH;
  let power = params.resolvedPower;
  const visited = new Set<string>([delegatee]);

  async function walk(node: string, depth: number): Promise<void> {
    if (depth >= maxDepth) return;
    for (const edge of graph.inbound.get(node) ?? []) {
      if (!applies(edge, category)) continue;
      const upstream = edge.delegator;
      if (visited.has(upstream)) continue;
      visited.add(upstream);
      if (directVoters.has(upstream)) {
        // This delegator voted directly: their own power (their delegation
        // to this chain is overridden) and everything further up their chain
        // — it flows through them — leaves the pool.
        power -= await resolveVotingPower({
          graph,
          wallet: upstream,
          category,
          getOwnPower,
          maxDepth: maxDepth - depth - 1,
          includeOwnPower: 'always',
        });
      } else {
        await walk(upstream, depth + 1);
      }
    }
  }

  await walk(delegatee, 0);
  return power < 0n ? 0n : power;
}

/**
 * Analytics: flatten the graph for the frontend viz — nodes with resolved
 * power and raw edges (docs §6 delegation flow graph).
 */
export async function graphSnapshot(params: {
  graph: DelegationGraph;
  category: string;
  getOwnPower: (wallet: string) => Promise<bigint>;
}): Promise<{
  nodes: Array<{ wallet: string; resolvedPower: string; delegators: number }>;
  edges: Array<{ from: string; to: string; category: string }>;
}> {
  const { graph, category, getOwnPower } = params;
  const wallets = new Set<string>([...graph.inbound.keys(), ...graph.outbound.keys()]);
  const nodes = [];
  for (const wallet of wallets) {
    const resolved = await resolveVotingPower({ graph, wallet, category, getOwnPower });
    const delegators = (graph.inbound.get(wallet) ?? []).filter((e) => applies(e, category)).length;
    nodes.push({ wallet, resolvedPower: resolved.toString(), delegators });
  }
  nodes.sort((a, b) => (BigInt(b.resolvedPower) > BigInt(a.resolvedPower) ? 1 : -1));
  const edges = [...graph.outbound.values()].flat().map((e) => ({
    from: e.delegator,
    to: e.delegatee,
    category: e.category,
  }));
  return { nodes, edges };
}
