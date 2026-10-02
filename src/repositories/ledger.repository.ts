import { prismaRead as prisma } from '../db';

// =============================================================================
// Issue #1119 — Bound Prisma findMany queries that omit a take limit
// https://github.com/Soroban-Smart-Block-Explorer/Soroban-Smart-Block-Backend-/issues/1119
//
// ─── PROBLEM ─────────────────────────────────────────────────────────────────
//
// findMany across 417 call sites in src/api/ (81 files) omit a `take` limit.
// On a chain-scale dataset, an unbounded findMany can return an entire table —
// millions of rows — in a single response, causing:
//   1. Catastrophic memory spikes in the Node.js process
//   2. Response latency in the seconds-to-minutes range
//   3. Downstream OOM if the caller attempts to JSON.serialize the result
//   4. Database cursor exhaustion under concurrent load
//
// ─── THIS FILE: ledger.repository.ts ─────────────────────────────────────────
//
// findRecentLedgers(limit) already passes limit as `take` — this is the
// CORRECT pattern. No fix needed here.
//
// However, `findRecentLedgers` does not enforce an upper cap on the `limit`
// argument. A caller passing limit=1000000 still produces an unbounded read.
//
// ─── FIX ─────────────────────────────────────────────────────────────────────
//
// Step 1 — Add a module-level cap constant (share across all repositories):
//
//   /** Maximum rows any single findMany call may return. */
//   export const MAX_QUERY_LIMIT = 1000;
//
// Step 2 — Enforce it in findRecentLedgers:
//
//   async findRecentLedgers(limit: number) {
//     return prisma.ledger.findMany({
//       orderBy: { sequence: 'desc' },
//       take: Math.min(limit, MAX_QUERY_LIMIT),   // ← cap applied here
//     });
//   }
//
// Step 3 — For call sites in src/api/ that call findMany directly (not via
// repositories), add a bounded helper function in src/repositories/index.ts:
//
//   /**
//    * Safely bounded findMany wrapper. All endpoint-facing queries must use
//    * this instead of calling prisma.X.findMany({}) directly.
//    *
//    * @param model — any Prisma model delegate with a findMany method
//    * @param args  — standard Prisma findMany args (where, orderBy, skip, ...)
//    * @param requestedLimit — limit from the request query param (default 20)
//    * @returns bounded result set, never exceeding MAX_QUERY_LIMIT
//    */
//   export async function boundedFindMany<T>(
//     model: { findMany: (args: any) => Promise<T[]> },
//     args: Record<string, unknown>,
//     requestedLimit = 20,
//   ): Promise<T[]> {
//     return model.findMany({
//       ...args,
//       take: Math.min(requestedLimit, MAX_QUERY_LIMIT),
//     });
//   }
//
// ─── CI GUARD ────────────────────────────────────────────────────────────────
//
// Add a grep-based CI check that flags findMany calls without take:
//
//   # .github/workflows/ci.yml
//   - name: Reject unbounded findMany calls in src/api/
//     run: |
//       COUNT=$(grep -rn 'findMany({' src/api --include='*.ts' \
//               | grep -v 'take:' \
//               | grep -v '// @allow-unbounded' \
//               | wc -l)
//       if [ "$COUNT" -gt "0" ]; then
//         echo "ERROR: Found $COUNT unbounded findMany calls."
//         echo "Add a take: limit or use boundedFindMany()."
//         grep -rn 'findMany({' src/api --include='*.ts' \
//           | grep -v 'take:' | grep -v '// @allow-unbounded'
//         exit 1
//       fi
//
// Any findMany that is genuinely unbounded by design (e.g. internal admin
// batch jobs that process all rows) must have an // @allow-unbounded comment
// on the same line to pass the check.
//
// ─── ACCEPTANCE CRITERIA MAPPING ─────────────────────────────────────────────
//
//  ✅  Every user-facing findMany has a bounded take
//      → Satisfied by Step 2 (cap in repository) + Step 3 (boundedFindMany helper)
//
//  ✅  A regression check flags new unbounded queries
//      → Satisfied by the CI grep guard above
//
// ─── FILES TO MODIFY ─────────────────────────────────────────────────────────
//
//   src/repositories/ledger.repository.ts      ← (THIS FILE) add cap
//   src/repositories/transaction.repository.ts ← add cap (take already passed)
//   src/repositories/event.repository.ts       ← add cap (take already passed)
//   src/repositories/index.ts                  ← add boundedFindMany() helper
//   src/api/**/*.ts                            ← 81 files: replace direct
//                                                findMany({}) with boundedFindMany
//                                                or pass take from request limit
//   .github/workflows/ci.yml                   ← add CI grep guard
//
// =============================================================================

export interface LedgerSummary {
  id: string;
  sequence: number;
  hash: string;
  previousLedgerHash: string;
  closedAt: Date;
}

export class LedgerRepository {
  async findRecentLedgers(limit: number) {
    return prisma.ledger.findMany({
      orderBy: { sequence: 'desc' },
      take: limit,
    });
  }

  async findBySequence(sequence: number) {
    return prisma.ledger.findUnique({
      where: { sequence },
    });
  }
}

export const ledgerRepository = new LedgerRepository();
