/**
 * Transaction Service — encapsulates business logic for transaction retrieval and queries.
 */

import {
  TransactionRepository,
  transactionRepository,
} from '../repositories/transaction.repository';
import { getBn254ExemptionByTx } from '../indexer/bn254-tracker';

export interface TransactionListFilter {
  cursor?: number;
  page?: number;
  limit?: number;
  contract?: string;
  account?: string;
  status?: string;
  ledgerMin?: number;
  ledgerMax?: number;
}

export interface CursorPaginatedTransactions {
  data: any[];
  nextCursor: number | null;
  hasNext: boolean;
}

export interface OffsetPaginatedTransactions {
  data: any[];
  total: number;
  page: number;
  limit: number;
  pages: number;
}

export class TransactionService {
  constructor(private readonly repo: TransactionRepository = transactionRepository) {}

  buildFilterWhere(q: TransactionListFilter): Record<string, any> {
    const where: Record<string, any> = {
      ...(q.contract && { contractAddress: q.contract }),
      ...(q.account && { sourceAccount: q.account }),
      ...(q.status && { status: q.status }),
      ...((q.ledgerMin !== undefined || q.ledgerMax !== undefined) && {
        ledgerSequence: {
          ...(q.ledgerMin !== undefined && { gte: q.ledgerMin }),
          ...(q.ledgerMax !== undefined && { lte: q.ledgerMax }),
        },
      }),
    };
    return where;
  }

  async listTransactions(
    query: TransactionListFilter,
  ): Promise<CursorPaginatedTransactions | OffsetPaginatedTransactions> {
    const limit = query.limit ?? 20;
    const where = this.buildFilterWhere(query);

    if (query.cursor !== undefined) {
      // Cursor-based pagination (descending ledgerSequence)
      where.ledgerSequence = { ...where.ledgerSequence, lt: query.cursor };

      const rows = await this.repo.findMany({
        where,
        take: limit + 1,
      });

      const hasNext = rows.length > limit;
      const data = hasNext ? rows.slice(0, limit) : rows;
      const nextCursor = hasNext ? (data[data.length - 1] as any).ledgerSequence : null;

      return { data, nextCursor, hasNext };
    }

    // Offset-based pagination
    const page = query.page ?? 1;
    const skip = (page - 1) * limit;

    const [data, total] = await Promise.all([
      this.repo.findMany({
        where,
        skip,
        take: limit,
      }),
      this.repo.count(where),
    ]);

    return {
      data,
      total,
      page,
      limit,
      pages: Math.ceil(total / limit),
    };
  }

  async getTransactionByHash(hash: string): Promise<any | null> {
    const tx = await this.repo.findByHashWithEvents(hash);
    if (!tx) return null;

    const bn254GasExemption = await getBn254ExemptionByTx(hash).catch(() => null);
    return {
      ...tx,
      ...(bn254GasExemption ? { bn254GasExemption } : {}),
    };
  }
}

export const transactionService = new TransactionService();
