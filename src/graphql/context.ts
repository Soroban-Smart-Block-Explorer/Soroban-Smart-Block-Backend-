import { PrismaClient } from '@prisma/client';
import { prismaRead, prismaWrite } from '../db';
import { createLoaders, type Loaders } from './loaders';
import { Request } from 'express';

export interface GraphQLContext {
  prisma: PrismaClient;
  prismaWrite: PrismaClient;
  loaders: Loaders;
  req: Request;
}

export async function createContext(ctx: { req: Request }): Promise<GraphQLContext> {
  return {
    prisma: prismaRead,
    prismaWrite,
    loaders: createLoaders(),
    req: ctx.req,
  };
}
