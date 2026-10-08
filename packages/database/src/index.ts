import { PrismaClient, Prisma } from "@prisma/client";

export * from "@prisma/client";

const globalForPrisma = globalThis as unknown as { __prisma?: PrismaClient };

export function createPrisma(url?: string): PrismaClient {
  return new PrismaClient(url ? { datasourceUrl: url } : undefined);
}

export const prisma: PrismaClient = globalForPrisma.__prisma ?? createPrisma();
if (process.env.NODE_ENV !== "production") globalForPrisma.__prisma = prisma;

export type Tx = Prisma.TransactionClient;
export const Decimal = Prisma.Decimal;
