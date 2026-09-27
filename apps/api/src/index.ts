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
export { assertProductionEnv, corsOriginWarning, productionEnvProblems } from "./lib/productionEnv";
export { generateId, generateInvoiceNumber, generatePoNumber, generateQuoteNumber, generateOrderNumber, generateStockReference, paginate, toFloat } from "./lib/utils";

import express from "express";
import helmet from "helmet";
import cors from "cors";
import cookieParser from "cookie-parser";
import session from "express-session";
import rateLimit from "express-rate-limit";
import { RedisStore } from "connect-redis";
import { prisma } from "./lib/prisma";
import { assertProductionEnv, corsOriginWarning } from "./lib/productionEnv";
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
import { supplierRouter } from "./routes/suppliers";
import { purchaseOrderRouter } from "./routes/purchase-orders";
import { auditMiddleware } from "./middleware/audit";
import { errorHandler } from "./middleware/errorHandler";

/** CORS_ORIGIN may list several origins, e.g. a Pages URL plus a custom domain. */
function getCorsOrigins(): string[] {
  return (process.env.CORS_ORIGIN || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

export function createApp() {
  const app = express();
  const allowedOrigins = getCorsOrigins();

  app.use(helmet());

  // Sign in is the one place worth being strict about: a password can be guessed, so a
  // limit here is what actually stops the guessing. Successful logins are not counted, so
  // a cashier on a busy till is never locked out by their own correct password. The
  // ceiling is per IP over fifteen minutes, generous enough for a shared till but far too
  // slow to brute force a password through.
  const authLimiter = rateLimit({
    windowMs: Number(process.env.AUTH_RATE_LIMIT_WINDOW_MS || 15 * 60 * 1000),
    limit: Number(process.env.AUTH_RATE_LIMIT_MAX || 30),
    standardHeaders: "draft-7",
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    message: { error: "Too many failed sign in attempts. Please wait a few minutes and try again." },
  });

  // The general ceiling is deliberately generous. It exists to stop a runaway script, not
  // to police ordinary use: a shop can legitimately make thousands of calls a day, and a
  // test suite or a busy till must never be mistaken for an attack. Sign in, where
  // guessing is the real threat, is the strict one.
  const apiLimiter = rateLimit({
    windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS || 60 * 1000),
    limit: Number(process.env.RATE_LIMIT_MAX || 1000),
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: { error: "Too many requests. Please slow down." },
  });

  app.use(
    cors({
      // The web client sends credentials, so the origin has to be explicit. A comma
      // separated list is accepted, e.g. a Pages URL plus a custom domain.
      origin: allowedOrigins.length ? allowedOrigins : false,
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

  // Sign in is the strict one: a password can be guessed, so a tight limit there is
  // what actually stops the guessing. The rest of the API gets a wider allowance so a
  // busy till is never mistaken for an attack. Health sits above both, so a monitoring
  // probe can never throttle the API it is checking.
  app.use("/api/v1/auth", authLimiter);
  app.use("/api/v1", apiLimiter);

  // Visiting the API host in a browser should explain itself rather than 404.
  app.get("/", (_req, res) =>
    res.json({
      service: "KaziOS API",
      status: "ok",
      environment: process.env.NODE_ENV || "development",
      health: "/health",
      api: "/api/v1",
      resources: [
        "auth",
        "org",
        "products",
        "customers",
        "invoices",
        "payments",
        "reports",
        "settings",
        "tax-categories",
        "users",
        "roles",
        "pos",
        "inventory",
      ],
    })
  );

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
  app.use("/api/v1/suppliers", supplierRouter);
  app.use("/api/v1/purchase-orders", purchaseOrderRouter);

  app.use(errorHandler);
  return app;
}

async function start() {
  assertProductionEnv();
  const corsWarning = corsOriginWarning();
  if (corsWarning) console.warn(`Warning: ${corsWarning}`);
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