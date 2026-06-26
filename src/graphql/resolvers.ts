import type { GraphQLContext } from './context';

interface PageArgs {
  cursor?: string | null;
  limit?: number;
}

function toInt(v: unknown): number | undefined {
  const n = typeof v === 'string' ? parseInt(v, 10) : (v as number);
  return Number.isFinite(n) ? n : undefined;
}

async function paginateTransactions(
  ctx: GraphQLContext,
  where: Record<string, unknown>,
  args: PageArgs,
  orderBy: Record<string, string>[] = [{ ledgerSequence: 'desc' }, { id: 'desc' }],
) {
  const limit = Math.min(args.limit ?? 20, 100);
  if (args.cursor) {
    const cursorVal = toInt(args.cursor);
    if (cursorVal !== undefined) {
      where.ledgerSequence = { ...((where.ledgerSequence as object) || {}), lt: cursorVal };
    }
  }
  const rows = await ctx.prisma.transaction.findMany({
    where: where as any,
    orderBy,
    take: limit + 1,
  });
  const hasNext = rows.length > limit;
  const data = hasNext ? rows.slice(0, limit) : rows;
  const nextCursor = hasNext && data.length > 0 ? data[data.length - 1].ledgerSequence : null;
  return { data, hasNext, nextCursor: nextCursor != null ? String(nextCursor) : null };
}

async function paginateEvents(ctx: GraphQLContext, where: Record<string, unknown>, args: PageArgs) {
  const limit = Math.min(args.limit ?? 20, 100);
  if (args.cursor) {
    const cursorVal = toInt(args.cursor);
    if (cursorVal !== undefined) {
      where.ledgerSequence = { ...((where.ledgerSequence as object) || {}), lt: cursorVal };
    }
  }
  const rows = await ctx.prisma.event.findMany({
    where: where as any,
    orderBy: { ledgerSequence: 'desc' },
    take: limit + 1,
  });
  const hasNext = rows.length > limit;
  const data = hasNext ? rows.slice(0, limit) : rows;
  const nextCursor = hasNext && data.length > 0 ? data[data.length - 1].ledgerSequence : null;
  return { data, hasNext, nextCursor: nextCursor != null ? String(nextCursor) : null };
}

export const resolvers = {
  DateTime: {
    __serialize(value: unknown) {
      if (value instanceof Date) return value.toISOString();
      return String(value);
    },
    __parseValue(value: string) {
      return new Date(value);
    },
    __parseLiteral(ast: any) {
      if (ast.kind === 'StringValue') return new Date(ast.value);
      return null;
    },
  },

  JSON: {
    __serialize(value: unknown) {
      return value;
    },
    __parseValue(value: unknown) {
      return value;
    },
    __parseLiteral(ast: any) {
      try {
        return JSON.parse(ast.value);
      } catch {
        return null;
      }
    },
  },

  Cursor: {
    __serialize(value: unknown) {
      return String(value);
    },
    __parseValue(value: unknown) {
      return String(value);
    },
    __parseLiteral(ast: any) {
      if (ast.kind === 'StringValue' || ast.kind === 'IntValue') return ast.value;
      return null;
    },
  },

  Transaction: {
    ledger(parent: any, _args: unknown, ctx: GraphQLContext) {
      return ctx.loaders.transactionsByLedger
        .load(parent.ledgerSequence)
        .then(() => ({ sequence: parent.ledgerSequence }));
    },
    contract(parent: any, _args: unknown, ctx: GraphQLContext) {
      if (!parent.contractAddress) return null;
      return ctx.loaders.contractByAddress.load(parent.contractAddress);
    },
    events(parent: any, _args: unknown, ctx: GraphQLContext) {
      return ctx.loaders.eventsByTxHash.load(parent.hash);
    },
  },

  Event: {
    ledger(parent: any, _args: unknown, _ctx: GraphQLContext) {
      return { sequence: parent.ledgerSequence };
    },
    transaction(parent: any, _args: unknown, ctx: GraphQLContext) {
      return ctx.loaders.transactionByHash.load(parent.transactionHash);
    },
    contract(parent: any, _args: unknown, ctx: GraphQLContext) {
      return ctx.loaders.contractByAddress.load(parent.contractAddress);
    },
  },

  Contract: {
    transactions(parent: any, args: PageArgs, ctx: GraphQLContext) {
      return paginateTransactions(ctx, { contractAddress: parent.address }, args);
    },
    events(parent: any, args: PageArgs, ctx: GraphQLContext) {
      return paginateEvents(ctx, { contractAddress: parent.address }, args);
    },
    async functionStats(parent: any, _args: unknown, ctx: GraphQLContext) {
      const stats = await ctx.prisma.transaction.groupBy({
        by: ['functionName'],
        where: { contractAddress: parent.address, functionName: { not: null } },
        _count: { functionName: true },
        _max: { ledgerCloseTime: true },
        orderBy: [{ _count: { functionName: 'desc' } }, { functionName: 'asc' }],
      });
      return stats.map((s) => ({
        functionName: s.functionName,
        count: s._count.functionName,
        lastInvoked: s._max.ledgerCloseTime,
      }));
    },
  },

  Token: {
    contract(parent: any, _args: unknown, ctx: GraphQLContext) {
      return ctx.loaders.contractByAddress.load(parent.address);
    },
    async transfers(parent: any, args: { limit?: number }, ctx: GraphQLContext) {
      const limit = Math.min(args.limit ?? 50, 100);
      return ctx.prisma.event.findMany({
        where: { contractAddress: parent.address, eventType: 'transfer' },
        orderBy: { ledgerSequence: 'desc' },
        take: limit,
      });
    },
  },

  Wallet: {
    async sorobanTxCount(parent: { address: string }, _args: unknown, ctx: GraphQLContext) {
      return ctx.prisma.transaction.count({ where: { sourceAccount: parent.address } });
    },
    async firstActivity(parent: { address: string }, _args: unknown, ctx: GraphQLContext) {
      const tx = await ctx.prisma.transaction.findFirst({
        where: { sourceAccount: parent.address },
        orderBy: { ledgerCloseTime: 'asc' },
        select: { ledgerCloseTime: true },
      });
      return tx?.ledgerCloseTime ?? null;
    },
    async lastActivity(parent: { address: string }, _args: unknown, ctx: GraphQLContext) {
      const tx = await ctx.prisma.transaction.findFirst({
        where: { sourceAccount: parent.address },
        orderBy: { ledgerCloseTime: 'desc' },
        select: { ledgerCloseTime: true },
      });
      return tx?.ledgerCloseTime ?? null;
    },
    transactions(parent: { address: string }, args: PageArgs, ctx: GraphQLContext) {
      return paginateTransactions(ctx, { sourceAccount: parent.address }, args);
    },
    events(parent: { address: string }, args: PageArgs, ctx: GraphQLContext) {
      return paginateEvents(
        ctx,
        {
          OR: [
            { decoded: { path: ['from'], equals: parent.address } },
            { decoded: { path: ['to'], equals: parent.address } },
          ],
        },
        args,
      );
    },
    async contracts(parent: { address: string }, args: { limit?: number }, ctx: GraphQLContext) {
      const limit = Math.min(args.limit ?? 50, 100);
      return ctx.prisma.contract.findMany({
        where: { transactions: { some: { sourceAccount: parent.address } } },
        take: limit,
      });
    },
  },

  Query: {
    transaction(_parent: unknown, args: { hash: string }, ctx: GraphQLContext) {
      return ctx.loaders.transactionByHash.load(args.hash);
    },
    async transactions(
      _parent: unknown,
      args: {
        cursor?: string;
        limit?: number;
        contract?: string;
        account?: string;
        status?: string;
        ledgerMin?: number;
        ledgerMax?: number;
      },
      ctx: GraphQLContext,
    ) {
      const where: Record<string, unknown> = {};
      if (args.contract) where.contractAddress = args.contract;
      if (args.account) where.sourceAccount = args.account;
      if (args.status) where.status = args.status;
      if (args.ledgerMin !== undefined || args.ledgerMax !== undefined) {
        where.ledgerSequence = {};
        if (args.ledgerMin !== undefined) (where.ledgerSequence as any).gte = args.ledgerMin;
        if (args.ledgerMax !== undefined) (where.ledgerSequence as any).lte = args.ledgerMax;
      }
      return paginateTransactions(ctx, where, args);
    },
    event(_parent: unknown, args: { id: string }, ctx: GraphQLContext) {
      return ctx.loaders.eventById.load(args.id);
    },
    async events(
      _parent: unknown,
      args: {
        cursor?: string;
        limit?: number;
        contract?: string;
        type?: string;
        topic?: string;
      },
      ctx: GraphQLContext,
    ) {
      const where: Record<string, unknown> = {};
      if (args.contract) where.contractAddress = args.contract;
      if (args.type) where.eventType = args.type;
      if (args.topic) where.topicSymbol = args.topic;
      return paginateEvents(ctx, where, args);
    },
    contract(_parent: unknown, args: { address: string }, ctx: GraphQLContext) {
      return ctx.loaders.contractByAddress.load(args.address);
    },
    async contracts(_parent: unknown, args: { limit?: number }, ctx: GraphQLContext) {
      const limit = Math.min(args.limit ?? 50, 100);
      return ctx.prisma.contract.findMany({
        take: limit,
        orderBy: { createdAt: 'desc' },
      });
    },
    async token(_parent: unknown, args: { address: string }, ctx: GraphQLContext) {
      const contract = await ctx.prisma.contract.findFirst({
        where: { address: args.address, isToken: true },
      });
      if (!contract) return null;
      return {
        address: contract.address,
        name: contract.tokenName,
        symbol: contract.tokenSymbol,
        decimals: contract.tokenDecimals,
        __contract: contract,
      };
    },
    async tokens(_parent: unknown, _args: unknown, ctx: GraphQLContext) {
      const contracts = await ctx.prisma.contract.findMany({
        where: { isToken: true },
        orderBy: { tokenSymbol: 'asc' },
      });
      return contracts.map((c) => ({
        address: c.address,
        name: c.tokenName,
        symbol: c.tokenSymbol,
        decimals: c.tokenDecimals,
        __contract: c,
      }));
    },
    wallet(_parent: unknown, args: { address: string }, _ctx: GraphQLContext) {
      return { address: args.address };
    },
    ledger(_parent: unknown, args: { sequence: number }, ctx: GraphQLContext) {
      return ctx.prisma.ledger.findUnique({ where: { sequence: args.sequence } });
    },
  },

  Ledger: {
    transactions(parent: { sequence: number }, args: PageArgs, ctx: GraphQLContext) {
      return paginateTransactions(ctx, { ledgerSequence: parent.sequence }, args, [
        { ledgerSequence: 'desc' },
        { id: 'desc' },
      ]);
    },
    events(parent: { sequence: number }, args: PageArgs, ctx: GraphQLContext) {
      return paginateEvents(ctx, { ledgerSequence: parent.sequence }, args);
    },
  },
};
