import { prismaRead as prisma } from '../db';

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
