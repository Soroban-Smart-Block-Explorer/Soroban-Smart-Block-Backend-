import { prismaRead as prisma } from '../db';

export const TX_SELECT = {
  hash: true,
  ledgerSequence: true,
  ledgerCloseTime: true,
  sourceAccount: true,
  contractAddress: true,
  functionName: true,
  functionArgs: true,
  status: true,
  humanReadable: true,
  feeCharged: true,
  sorobanResources: true,
  failureReason: true,
} as const;

export interface TransactionFindOptions {
  where: Record<string, any>;
  take?: number;
  skip?: number;
  orderBy?: Array<Record<string, 'asc' | 'desc'>>;
}

export class TransactionRepository {
  async findMany(options: TransactionFindOptions) {
    return prisma.transaction.findMany({
      where: options.where,
      orderBy: options.orderBy ?? [{ ledgerSequence: 'desc' }, { id: 'desc' }],
      take: options.take,
      skip: options.skip,
      select: TX_SELECT,
    });
  }

  async count(where: Record<string, any>): Promise<number> {
    return prisma.transaction.count({ where });
  }

  async findByHashWithEvents(hash: string) {
    return prisma.transaction.findUnique({
      where: { hash },
      select: {
        ...TX_SELECT,
        events: true,
      },
    });
  }
}

export const transactionRepository = new TransactionRepository();
