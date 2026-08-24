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
}

export class EventRepository {
  async findManySummary(options: EventFindOptions) {
    return prisma.event.findMany({
      where: options.where,
      orderBy: options.orderBy ?? { ledgerSequence: 'desc' },
      skip: options.skip,
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
