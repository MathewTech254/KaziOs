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
export { generateId, generateInvoiceNumber, generatePoNumber, generateQuoteNumber, generateOrderNumber, paginate, toFloat } from "./lib/utils";

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
import { posRouter } from "./routes/pos";
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
  app.use("/api/v1/pos", posRouter);

  app.use(errorHandler);
  return app;
}

async function start() {
  await connectRedis();
  await prisma.$connect();
  const app = createApp();
  const port = parseInt(process.env.API_PORT || "4000", 10);
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