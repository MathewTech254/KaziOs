// Drops a scratch database so the integration runner's create-if-missing path can be
// proven on a machine where it has never been needed. Refuses anything not named like a
// test database, for the same reason run-integration.mjs refuses.
import { PrismaClient } from "@prisma/client";

const name = process.argv[2];
if (!name || !/test/i.test(name)) {
  console.error(`Refusing to drop "${name}": it does not look like a test database.`);
  process.exit(1);
}

const url = new URL(process.env.DATABASE_URL);
url.pathname = "/postgres";
const prisma = new PrismaClient({ datasources: { db: { url: url.toString() } } });

await prisma.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name.replace(/"/g, '""')}"`);
console.log(`Dropped ${name} if it existed.`);
await prisma.$disconnect();
