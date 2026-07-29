import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

// Per-query logging floods the console (the 2s SSE stats poll alone fires ~6
// COUNT queries every tick), burying the automation's own [TAILOR]/[ENGINE]
// logs. Keep error+warn by default; opt back into full query logging with
// PRISMA_LOG_QUERIES=true when debugging SQL.
const prismaLog: ("query" | "error" | "warn")[] =
  process.env.PRISMA_LOG_QUERIES === "true"
    ? ["query", "error", "warn"]
    : ["error", "warn"];

export const prisma =
  globalForPrisma.prisma ?? new PrismaClient({ log: prismaLog });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
