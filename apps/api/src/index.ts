export { prisma, disconnectPrisma } from "./lib/prisma";
export { redisClient, connectRedis, getRedis } from "./lib/redis";
export {
  hashPassword,
  verifyPassword,
  signToken,
  verifyToken,
  generateSessionToken,
  createSession,
  validateSession,
  rotateSession,
  destroySession,
  getUserOrganization,
} from "./lib/auth";
export { AppError } from "./middleware/errorHandler";
export { generateId, generateInvoiceNumber, generatePoNumber, generateQuoteNumber, generateOrderNumber, generateStockReference, paginate, toFloat } from "./lib/utils";

import express from "express";
import helmet from "helmet";
import cors from "cors";
import cookieParser from "cookie-parser";
import session from "express-session";
import { RedisStore } from "connect-redis";
import { prisma } from "./lib/prisma";
import { redisClient, connectRedis } from "./lib/redis";
import { authRouter } from "./routes/auth";
import { organizationRouter } from "./routes/organization";
import { productRouter } from "./routes/products";
import { customerRouter } from "./routes/customers";
import { invoiceRouter } from "./routes/invoices";
import { paymentRouter } from "./routes/payments";
import { reportRouter } from "./routes/reports";
import { settingsRouter } from "./routes/settings";
import { taxCategoryRouter } from "./routes/tax-categories";
import { userRouter } from "./routes/users";
import { roleRouter } from "./routes/roles";
import { posRouter } from "./routes/pos";
import { inventoryRouter } from "./routes/inventory";
import { auditMiddleware } from "./middleware/audit";
import { errorHandler } from "./middleware/errorHandler";

export function createApp() {
  const app = express();

  app.use(helmet());
  app.use(
    cors({
      origin: process.env.CORS_ORIGIN || "http://localhost:3000",
      credentials: true,
    })
  );
  app.use(express.json({ limit: "10mb" }));
  app.use(cookieParser());
  app.use(
    session({
      store: new (RedisStore as any)({ client: redisClient, ttl: 86400 }),
      secret: process.env.SESSION_SECRET || "dev-session-secret-change-in-production-min-32chars",
      resave: false,
      saveUninitialized: false,
      cookie: {
        secure: process.env.NODE_ENV === "production",
        httpOnly: true,
        maxAge: 7 * 24 * 60 * 60 * 1000,
      },
    })
  );

  app.use(auditMiddleware);

  app.get("/health", (_req, res) => res.json({ status: "ok" }));
  app.use("/api/v1/auth", authRouter);
  app.use("/api/v1/org", organizationRouter);
  app.use("/api/v1/products", productRouter);
  app.use("/api/v1/customers", customerRouter);
  app.use("/api/v1/invoices", invoiceRouter);
  app.use("/api/v1/payments", paymentRouter);
  app.use("/api/v1/reports", reportRouter);
  app.use("/api/v1/settings", settingsRouter);
  app.use("/api/v1/tax-categories", taxCategoryRouter);
  app.use("/api/v1/users", userRouter);
  app.use("/api/v1/roles", roleRouter);
  app.use("/api/v1/pos", posRouter);
  app.use("/api/v1/inventory", inventoryRouter);

  app.use(errorHandler);
  return app;
}

/** Fail fast in production instead of booting with development defaults. */
function requireProductionEnv(): void {
  if (process.env.NODE_ENV !== "production") return;

  const required = ["DATABASE_URL", "SESSION_SECRET", "JWT_SECRET", "CORS_ORIGIN"];
  const missing = required.filter((name) => !process.env[name]);
  if (missing.length) {
    throw new Error(`Missing required production environment variables: ${missing.join(", ")}`);
  }
  if ((process.env.SESSION_SECRET || "").length < 32) {
    throw new Error("SESSION_SECRET must be at least 32 characters in production");
  }
}

async function start() {
  requireProductionEnv();
  await connectRedis();
  await prisma.$connect();
  const app = createApp();
  // PaaS hosts (Render, Railway, Fly, Koyeb) inject PORT; API_PORT stays for local use.
  const port = parseInt(process.env.PORT || process.env.API_PORT || "4000", 10);
  app.listen(port, () => {
    console.log(`KaziOS API running on http://localhost:${port}`);
  });
}

if (require.main === module) {
  start().catch((err) => {
    console.error("Failed to start API:", err);
    process.exit(1);
  });
}