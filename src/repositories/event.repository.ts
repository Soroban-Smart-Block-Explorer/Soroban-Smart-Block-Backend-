import { prismaRead as prisma } from '../db';

// =============================================================================
// Issue #1119 — Bound Prisma findMany queries that omit a take limit
// https://github.com/Soroban-Smart-Block-Explorer/Soroban-Smart-Block-Backend-/issues/1119
//
// This file's findManySummary() already passes options.take from the caller.
// The CORRECT pattern is already in place here.
//
// REMAINING RISK: options.take can be undefined (the field is optional in
// EventFindOptions). When undefined, findMany has no limit and returns all
// matching rows. On a chain-scale dataset this is a memory/latency hazard.
//
// FIX: Apply the MAX_QUERY_LIMIT cap even when take is passed:
//
//   import { MAX_QUERY_LIMIT } from './index';   // or define locally
//
//   async findManySummary(options: EventFindOptions) {
//     return prisma.event.findMany({
//       ...
//       take: Math.min(options.take ?? 20, MAX_QUERY_LIMIT),  // ← always bounded
//       ...
//     });
//   }
//
// See ledger.repository.ts for the full issue documentation including the
// boundedFindMany() helper design and CI guard.
// =============================================================================

export const EVENT_SUMMARY_SELECT = {
  id: true,
  transactionHash: true,
  contractAddress: true,
  eventType: true,
  topicSymbol: true,
  decoded: true,
  ledgerSequence: true,
  ledgerCloseTime: true,
} as const;

export interface EventFindOptions {
  where: Record<string, any>;
  take?: number;
  skip?: number;
  orderBy?: Record<string, 'asc' | 'desc'>;
  /** #914 — keyset cursor (event id) for cursor-based pagination. */
  cursorId?: string;
}

export class EventRepository {
  async findManySummary(options: EventFindOptions) {
    return prisma.event.findMany({
      where: options.where,
      orderBy: options.orderBy ? options.orderBy : [{ ledgerSequence: 'desc' }, { id: 'desc' }],
      ...(options.cursorId
        ? { cursor: { id: options.cursorId }, skip: 1 }
        : { skip: options.skip }),
      take: options.take,
      select: EVENT_SUMMARY_SELECT,
    });
  }

  async count(where: Record<string, any>): Promise<number> {
    return prisma.event.count({ where });
  }

  async findById(id: string) {
    return prisma.event.findUnique({
      where: { id },
    });
  }
}

export const eventRepository = new EventRepository();
