import { prismaRead as prisma } from '../db';

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
