/**
 * DEX Analyzer — detects flash loans, cross-contract arbitrage paths,
 * and multi-hop routing events from indexed transaction/event data.
 *
 * Flash-loan heuristic: within a single transaction, the same token
 * flows IN and OUT with equal (or near-equal) gross amounts, implying
 * the borrowed principal was returned in the same atomic envelope.
 *
 * Arbitrage heuristic: a cycle exists in the token-flow graph where
 * the net output of the final hop exceeds the net input of the first hop.
 *
 * Multi-hop route: a chain of ≥2 swap events where the output token of
 * hop N equals the input token of hop N+1.
 */

import { prismaRead as prisma } from '../db';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TokenFlow {
  token: string;
  from: string;
  to: string;
  amount: bigint;
}

export interface FlashLoanResult {
  transactionHash: string;
  ledgerSequence: number;
  ledgerCloseTime: Date;
  token: string;
  grossAmount: bigint;
  netSlippage: bigint; // grossIn - grossOut (positive = cost, negative = profit)
  slippageBps: number; // basis points
  contractsInvolved: string[];
}

export interface ArbitrageResult {
  transactionHash: string;
  ledgerSequence: number;
  ledgerCloseTime: Date;
  path: string[]; // token symbols/addresses along the cycle
  contracts: string[]; // DEX contracts touched
  amountIn: bigint;
  amountOut: bigint;
  yieldCaptured: bigint; // amountOut - amountIn
  yieldBps: number; // basis points profit
}

export interface MultiHopRoute {
  transactionHash: string;
  ledgerSequence: number;
  ledgerCloseTime: Date;
  hops: Array<{
    contract: string;
    tokenIn: string;
    tokenOut: string;
    amountIn: bigint;
    amountOut: bigint;
  }>;
  tokenIn: string;
  tokenOut: string;
  totalAmountIn: bigint;
  totalAmountOut: bigint;
  netSlippageBps: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Extract token flows from decoded event data. */
function extractFlows(
  events: Array<{ contractAddress: string; eventType: string; decoded: unknown }>,
): TokenFlow[] {
  const flows: TokenFlow[] = [];
  for (const ev of events) {
    const d = ev.decoded as Record<string, unknown> | null;
    if (!d) continue;

    if (ev.eventType === 'transfer' || ev.eventType === 'swap') {
      const from = String(d.from ?? d.sender ?? '');
      const to = String(d.to ?? d.recipient ?? '');
      const token = String(d.token ?? d.asset ?? ev.contractAddress);
      const rawAmt = d.amount ?? d.amount_in ?? d.amountIn ?? '0';
      try {
        flows.push({ token, from, to, amount: BigInt(String(rawAmt)) });
      } catch {
        /* non-numeric amount — skip */
      }
    }
  }
  return flows;
}

/** Compute basis points: (delta / base) * 10_000 */
function bps(delta: bigint, base: bigint): number {
  if (base === 0n) return 0;
  return Number((delta * 10_000n) / base);
}

// ─── Flash-loan detection ─────────────────────────────────────────────────────

/**
 * A flash loan is detected when, within one transaction, the same token
 * has total inflow ≈ total outflow (within 5% tolerance), indicating
 * the principal was borrowed and repaid atomically.
 */
export function detectFlashLoans(
  txHash: string,
  ledgerSequence: number,
  ledgerCloseTime: Date,
  events: Array<{ contractAddress: string; eventType: string; decoded: unknown }>,
): FlashLoanResult[] {
  const flows = extractFlows(events);
  if (flows.length < 2) return [];

  // Aggregate gross inflows and outflows per token
  const inflow = new Map<string, bigint>();
  const outflow = new Map<string, bigint>();
  const contracts = new Set<string>();

  for (const f of flows) {
    inflow.set(f.token, (inflow.get(f.token) ?? 0n) + f.amount);
    outflow.set(f.token, (outflow.get(f.token) ?? 0n) + f.amount);
    contracts.add(f.from);
    contracts.add(f.to);
  }

  const results: FlashLoanResult[] = [];
  const TOLERANCE_BPS = 500n; // 5%

  for (const [token, grossIn] of inflow) {
    const grossOut = outflow.get(token) ?? 0n;
    if (grossIn === 0n || grossOut === 0n) continue;

    const larger = grossIn > grossOut ? grossIn : grossOut;
    const smaller = grossIn > grossOut ? grossOut : grossIn;
    const diffBps = ((larger - smaller) * 10_000n) / larger;

    if (diffBps <= TOLERANCE_BPS) {
      const netSlippage = grossIn - grossOut;
      results.push({
        transactionHash: txHash,
        ledgerSequence,
        ledgerCloseTime,
        token,
        grossAmount: grossIn,
        netSlippage,
        slippageBps: bps(netSlippage < 0n ? -netSlippage : netSlippage, grossIn),
        contractsInvolved: [...contracts].filter(Boolean),
      });
    }
  }
  return results;
}

// ─── Arbitrage detection ──────────────────────────────────────────────────────

/**
 * Detect arbitrage: find a token cycle A→B→…→A where the final output
 * of A exceeds the initial input of A.
 */
export function detectArbitrage(
  txHash: string,
  ledgerSequence: number,
  ledgerCloseTime: Date,
  events: Array<{ contractAddress: string; eventType: string; decoded: unknown }>,
): ArbitrageResult[] {
  const swaps = events.filter((e) => e.eventType === 'swap');
  if (swaps.length < 2) return [];

  interface SwapEdge {
    contract: string;
    tokenIn: string;
    tokenOut: string;
    amountIn: bigint;
    amountOut: bigint;
  }

  const edges: SwapEdge[] = [];
  for (const ev of swaps) {
    const d = ev.decoded as Record<string, unknown> | null;
    if (!d) continue;
    try {
      edges.push({
        contract: ev.contractAddress,
        tokenIn: String(d.token_in ?? d.tokenIn ?? d.from_asset ?? ''),
        tokenOut: String(d.token_out ?? d.tokenOut ?? d.to_asset ?? ''),
        amountIn: BigInt(String(d.amount_in ?? d.amountIn ?? '0')),
        amountOut: BigInt(String(d.amount_out ?? d.amountOut ?? '0')),
      });
    } catch {
      /* skip */
    }
  }

  const results: ArbitrageResult[] = [];

  // DFS to find cycles starting from each edge's tokenIn
  for (const start of edges) {
    if (!start.tokenIn) continue;
    const visited = new Set<string>();
    const path: SwapEdge[] = [start];
    visited.add(start.tokenIn);

    const dfs = (current: SwapEdge) => {
      if (current.tokenOut === start.tokenIn && path.length >= 2) {
        // Cycle found
        const amountIn = start.amountIn;
        const amountOut = current.amountOut;
        if (amountOut > amountIn) {
          const yieldCaptured = amountOut - amountIn;
          results.push({
            transactionHash: txHash,
            ledgerSequence,
            ledgerCloseTime,
            path: [...path.map((e) => e.tokenIn), start.tokenIn],
            contracts: [...new Set(path.map((e) => e.contract))],
            amountIn,
            amountOut,
            yieldCaptured,
            yieldBps: bps(yieldCaptured, amountIn),
          });
        }
        return;
      }
      if (visited.has(current.tokenOut)) return;
      visited.add(current.tokenOut);

      for (const next of edges) {
        if (next === current) continue;
        if (next.tokenIn === current.tokenOut) {
          path.push(next);
          dfs(next);
          path.pop();
        }
      }
      visited.delete(current.tokenOut);
    };

    dfs(start);
  }

  // Deduplicate by path signature
  const seen = new Set<string>();
  return results.filter((r) => {
    const key = r.path.join('→');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ─── Multi-hop route detection ────────────────────────────────────────────────

/**
 * Detect multi-hop routes: chains of ≥2 swaps where output token of
 * hop N = input token of hop N+1.
 */
export function detectMultiHopRoutes(
  txHash: string,
  ledgerSequence: number,
  ledgerCloseTime: Date,
  events: Array<{ contractAddress: string; eventType: string; decoded: unknown }>,
): MultiHopRoute[] {
  const swaps = events.filter((e) => e.eventType === 'swap');
  if (swaps.length < 2) return [];

  interface Hop {
    contract: string;
    tokenIn: string;
    tokenOut: string;
    amountIn: bigint;
    amountOut: bigint;
  }

  const hops: Hop[] = [];
  for (const ev of swaps) {
    const d = ev.decoded as Record<string, unknown> | null;
    if (!d) continue;
    try {
      hops.push({
        contract: ev.contractAddress,
        tokenIn: String(d.token_in ?? d.tokenIn ?? d.from_asset ?? ''),
        tokenOut: String(d.token_out ?? d.tokenOut ?? d.to_asset ?? ''),
        amountIn: BigInt(String(d.amount_in ?? d.amountIn ?? '0')),
        amountOut: BigInt(String(d.amount_out ?? d.amountOut ?? '0')),
      });
    } catch {
      /* skip */
    }
  }

  const routes: MultiHopRoute[] = [];

  // Build chains greedily: start from each hop, extend while tokenOut matches next tokenIn
  for (let i = 0; i < hops.length; i++) {
    const chain: Hop[] = [hops[i]];
    const used = new Set([i]);

    let extended = true;
    while (extended) {
      extended = false;
      const last = chain[chain.length - 1];
      for (let j = 0; j < hops.length; j++) {
        if (used.has(j)) continue;
        if (hops[j].tokenIn === last.tokenOut) {
          chain.push(hops[j]);
          used.add(j);
          extended = true;
          break;
        }
      }
    }

    if (chain.length >= 2) {
      const totalIn = chain[0].amountIn;
      const totalOut = chain[chain.length - 1].amountOut;
      const slippage = totalIn > 0n ? bps(totalIn - totalOut, totalIn) : 0;

      routes.push({
        transactionHash: txHash,
        ledgerSequence,
        ledgerCloseTime,
        hops: chain,
        tokenIn: chain[0].tokenIn,
        tokenOut: chain[chain.length - 1].tokenOut,
        totalAmountIn: totalIn,
        totalAmountOut: totalOut,
        netSlippageBps: slippage,
      });
    }
  }

  // Deduplicate: keep longest chain that starts with each tokenIn
  const best = new Map<string, MultiHopRoute>();
  for (const r of routes) {
    const key = r.tokenIn + '→' + r.tokenOut;
    const existing = best.get(key);
    if (!existing || r.hops.length > existing.hops.length) {
      best.set(key, r);
    }
  }
  return [...best.values()];
}

// ─── DB-backed analysis ───────────────────────────────────────────────────────

/** Serialize bigint fields for JSON transport. */
function serializeBigInts<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
}

/** Analyze a single transaction by hash. */
export async function analyzeTransaction(txHash: string) {
  const tx = await prisma.transaction.findUnique({
    where: { hash: txHash },
    include: { events: true },
  });
  if (!tx) return null;

  const events = tx.events.map((e) => ({
    contractAddress: e.contractAddress,
    eventType: e.eventType,
    decoded: e.decoded,
  }));

  return serializeBigInts({
    transactionHash: txHash,
    ledgerSequence: tx.ledgerSequence,
    ledgerCloseTime: tx.ledgerCloseTime,
    flashLoans: detectFlashLoans(txHash, tx.ledgerSequence, tx.ledgerCloseTime, events),
    arbitrage: detectArbitrage(txHash, tx.ledgerSequence, tx.ledgerCloseTime, events),
    multiHopRoutes: detectMultiHopRoutes(txHash, tx.ledgerSequence, tx.ledgerCloseTime, events),
  });
}

/** Analyze all transactions in a ledger range. */
export async function analyzeRange(ledgerMin: number, ledgerMax: number, limit = 100) {
  const txs = await prisma.transaction.findMany({
    where: { ledgerSequence: { gte: ledgerMin, lte: ledgerMax } },
    include: { events: true },
    orderBy: { ledgerSequence: 'desc' },
    take: limit,
  });

  const results = txs.map((tx) => {
    const events = tx.events.map((e) => ({
      contractAddress: e.contractAddress,
      eventType: e.eventType,
      decoded: e.decoded,
    }));
    return {
      transactionHash: tx.hash,
      ledgerSequence: tx.ledgerSequence,
      ledgerCloseTime: tx.ledgerCloseTime,
      flashLoans: detectFlashLoans(tx.hash, tx.ledgerSequence, tx.ledgerCloseTime, events),
      arbitrage: detectArbitrage(tx.hash, tx.ledgerSequence, tx.ledgerCloseTime, events),
      multiHopRoutes: detectMultiHopRoutes(tx.hash, tx.ledgerSequence, tx.ledgerCloseTime, events),
    };
  });

  return serializeBigInts(results);
}
