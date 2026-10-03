// Loaded before the client is constructed, because the client resolves its datasource
// from the environment as it is created.
import { loadRepoEnv } from "./env";

loadRepoEnv();

import { PrismaClient } from "@prisma/client";

export const prisma = new PrismaClient({
  log: process.env.NODE_ENV === "development" ? ["query", "error", "warn"] : ["error"],
});

export async function disconnectPrisma() {
  await prisma.$disconnect();
}
