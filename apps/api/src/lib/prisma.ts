// Loaded before the client is constructed, because the client resolves its datasource
// from the environment as it is created.
import { loadRepoEnv } from "./env";

loadRepoEnv();

import { PrismaClient } from "@prisma/client";

type PrismaLogLevel = "error" | "warn" | "query" | "info";

export const prisma = new PrismaClient({
  log: (() => {
    const levels: PrismaLogLevel[] = ["error"];
    // Query logging is noisy in integration test output. Opt in with DEBUG_PRISMA=1.
    if (process.env.DEBUG_PRISMA === "1") levels.push("query", "warn");
    else if (process.env.NODE_ENV === "development") levels.push("warn");
    return levels;
  })(),
});

export async function disconnectPrisma() {
  await prisma.$disconnect();
}
