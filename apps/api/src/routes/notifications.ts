import type { Response } from "express";
import { Router } from "express";
import { prisma } from "../lib/prisma";
import type { AuthRequest } from "../middleware/auth";
import { requireAuth } from "../middleware/auth";
import { AppError } from "../middleware/errorHandler";
import { subscribeRealtime } from "../lib/realtime";
import { unreadCount } from "../services/notifications";

export const notificationRouter = Router();

/**
 * Alerts are personal, so every query is filtered by the signed-in user as well as the
 * organization. One organization can never see another member's alerts, and the badge
 * count is a separate cheap call so the top bar can poll it.
 */
notificationRouter.get("/", requireAuth, async (req: AuthRequest, res) => {
  const organizationId = req.organizationId;
  const userId = req.userId;
  if (!organizationId || !userId) throw new AppError(401, "Authentication required");

  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));

  const [items, unread] = await Promise.all([
    prisma.notification.findMany({
      where: { organizationId, userId },
      orderBy: { createdAt: "desc" },
      take: limit,
    }),
    unreadCount(organizationId, userId),
  ]);

  res.json({ data: items, meta: { unread, total: items.length } });
});

/** Marking as read only ever touches rows already owned by this user. */
notificationRouter.post("/read", requireAuth, async (req: AuthRequest, res) => {
  const organizationId = req.organizationId;
  const userId = req.userId;
  if (!organizationId || !userId) throw new AppError(401, "Authentication required");

  const ids: unknown = req.body?.ids;
  const now = new Date();
  const result = await prisma.notification.updateMany({
    where: {
      organizationId,
      userId,
      readAt: null,
      ...(Array.isArray(ids) && ids.length ? { id: { in: ids.map(String) } } : {}),
    },
    data: { readAt: now },
  });

  res.json({ data: { updated: result.count } });
});

/**
 * The live feed.
 *
 * Server Sent Events rather than a WebSocket: alerts only travel one way, SSE runs
 * over ordinary HTTP so it survives the proxies and CDNs an API is deployed behind,
 * and the browser reconnects on its own without any code here having to notice a
 * dropped connection.
 *
 * The stream is authenticated exactly like every other route. Browsers cannot attach
 * an Authorization header to an EventSource, so the token arrives as a query
 * parameter; it is the same JWT, validated against the same session row, and it is
 * only ever read for this purpose.
 */
notificationRouter.get("/stream", requireAuth, async (req: AuthRequest, res: Response) => {
  const organizationId = req.organizationId;
  const userId = req.userId;
  if (!organizationId || !userId) throw new AppError(401, "Authentication required");

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    // Reverse proxies buffer responses by default, which would hold every alert back
    // until the buffer filled. This is the header that stops that.
    "X-Accel-Buffering": "no",
  });
  // Nagle's algorithm would batch small writes; an alert that arrives 40ms late reads
  // as broken rather than fast.
  res.socket?.setNoDelay(true);
  res.flushHeaders?.();

  const write = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // The current badge count, so a freshly opened tab is correct before anything
  // arrives, and a reconnecting tab re-syncs instead of trusting a stale count.
  try {
    write("sync", { unread: await unreadCount(organizationId, userId) });
  } catch {
    // A failed sync is not a reason to refuse the connection.
  }

  const unsubscribe = subscribeRealtime(organizationId, event => {
    // The bus is per organization; a person must never receive a colleague's alert.
    if (event.userId !== userId) return;
    write("notification", event.payload);
  });

  // Proxies and load balancers close a connection that looks idle. A comment line is
  // invisible to the browser's event handlers and is enough to hold the socket open.
  const heartbeat = setInterval(() => res.write(": keep-alive\n\n"), 25_000);

  const close = () => {
    clearInterval(heartbeat);
    unsubscribe();
  };
  req.on("close", close);
  req.on("aborted", close);
  res.on("close", close);
});
