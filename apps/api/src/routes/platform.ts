import { Router } from "express";
import type { Response, NextFunction } from "express";
import { prisma } from "../lib/prisma";
import type { AuthRequest } from "../middleware/auth";
import { requireAuth } from "../middleware/auth";
import { AppError } from "../lib";
import { PLATFORM_ADMIN_SCOPES } from "@kazios/types";

/**
 * Platform administration, for whoever runs KaziOS rather than a shop on it.
 *
 * This is deliberately a different surface from business administration, guarded by a
 * different table. A business Owner holds `*` inside their own organization, and that must
 * never mean anything here: platform authority is granted deliberately, by scope, is
 * revocable without touching a business's roles, and leaves an audit trail.
 *
 * Nothing in this router is reachable with a business role, however senior.
 */
export const platformRouter = Router();

/**
 * Refuses anybody who is not an active platform administrator with the given scope.
 *
 * The scope check is on the record itself rather than on a role inside any business, so
 * nobody can reach it by being made an owner somewhere.
 */
function requirePlatformScope(...scopes: string[]) {
  return async (req: AuthRequest, _res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!req.userId) throw new AppError(401, "Authentication required");

      const admin = await prisma.platformAdmin.findUnique({
        where: { userId: req.userId },
        select: { scopes: true, status: true },
      });

      if (!admin || admin.status !== "ACTIVE") {
        throw new AppError(
          403,
          "This area is for KaziOS platform administrators",
          "NOT_PLATFORM_ADMIN"
        );
      }

      const held = admin.scopes ?? [];
      const permitted = held.includes("*") || scopes.some(scope => held.includes(scope));
      if (!permitted) {
        throw new AppError(403, "You do not have permission to do this", "INSUFFICIENT_SCOPE");
      }

      next();
    } catch (err) {
      next(err);
    }
  };
}

platformRouter.use(requireAuth, requirePlatformScope(PLATFORM_ADMIN_SCOPES.READ));

/**
 * Every business on the platform with what it is on and what it is using.
 *
 * The shape a support conversation starts from: is this account paying, when did it lapse,
 * and has it already been warned about the limit it is about to hit.
 */
platformRouter.get("/businesses", async (req: AuthRequest, res, next) => {
  try {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
    const cursor = typeof req.query.cursor === "string" ? req.query.cursor : undefined;
    const search = typeof req.query.search === "string" ? req.query.search.trim() : "";

    const organizations = await prisma.organization.findMany({
      where: search ? { name: { contains: search, mode: "insensitive" } } : {},
      include: {
        plan: { select: { key: true, name: true } },
        subscription: {
          select: {
            id: true,
            status: true,
            currentPeriodEnd: true,
            trialEndsAt: true,
            graceEndsAt: true,
            cancelAtPeriodEnd: true,
            billingInterval: true,
          },
        },
        _count: { select: { users: true, branches: true, products: true } },
      },
      orderBy: { createdAt: "desc" },
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });

    // One more than asked for is how the next page's cursor is known to exist.
    const hasMore = organizations.length > limit;
    const page = hasMore ? organizations.slice(0, limit) : organizations;

    res.json({
      data: page.map(org => ({
        id: org.id,
        name: org.name,
        country: org.country,
        currency: org.currency,
        status: org.status,
        createdAt: org.createdAt,
        plan: org.plan ? { key: org.plan.key, name: org.plan.name } : null,
        subscription: org.subscription ?? null,
        usage: {
          users: org._count.users,
          branches: org._count.branches,
          products: org._count.products,
        },
      })),
      nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
    });
  } catch (err) {
    next(err);
  }
});

/** Subscriptions that need a human: lapsed, in grace, or about to. */
platformRouter.get("/subscriptions", async (_req, res, next) => {
  try {
    const now = new Date();
    const soon = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

    const [pastDue, expiring, trialing] = await Promise.all([
      prisma.subscription.findMany({
        where: { status: { in: ["PAST_DUE", "GRACE"] } },
        include: {
          plan: { select: { key: true, name: true } },
          organization: { select: { name: true } },
        },
        orderBy: { graceEndsAt: "asc" },
        take: 100,
      }),
      prisma.subscription.findMany({
        where: { status: "ACTIVE", currentPeriodEnd: { lte: soon, gte: now } },
        include: {
          plan: { select: { key: true, name: true } },
          organization: { select: { name: true } },
        },
        orderBy: { currentPeriodEnd: "asc" },
        take: 100,
      }),
      prisma.subscription.findMany({
        where: { status: "TRIALING", trialEndsAt: { lte: soon, gte: now } },
        include: {
          plan: { select: { key: true, name: true } },
          organization: { select: { name: true } },
        },
        orderBy: { trialEndsAt: "asc" },
        take: 100,
      }),
    ]);

    const shape = (row: (typeof pastDue)[number]) => ({
      subscriptionId: row.id,
      organizationId: row.organizationId,
      organizationName: row.organization.name,
      planKey: row.plan.key,
      planName: row.plan.name,
      status: row.status,
      currentPeriodEnd: row.currentPeriodEnd,
      trialEndsAt: row.trialEndsAt,
      graceEndsAt: row.graceEndsAt,
    });

    res.json({
      data: {
        pastDue: pastDue.map(shape),
        expiringSoon: expiring.map(shape),
        trialing: trialing.map(shape),
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Headline numbers for the platform, derived rather than counted into a table.
 *
 * Every figure is a live aggregate. A denormalised counter on this page would eventually
 * disagree with the subscriptions it claims to summarise, and a revenue number that is
 * quietly wrong is worse than one that takes a moment to compute.
 */
platformRouter.get("/overview", async (_req, res, next) => {
  try {
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

    const [businesses, byStatus, revenue, trials, failedPayments, recentEvents] = await Promise.all(
      [
        prisma.organization.count(),
        prisma.subscription.groupBy({ by: ["status"], _count: { _all: true } }),
        // Money that actually settled this month, not what was invoiced.
        prisma.subscriptionPayment.aggregate({
          where: { status: "SUCCESS", paidAt: { gte: monthStart } },
          _sum: { amountCents: true },
          _count: { _all: true },
        }),
        prisma.subscription.count({ where: { status: "TRIALING" } }),
        prisma.subscriptionPayment.findMany({
          where: { status: "FAILED", createdAt: { gte: monthStart } },
          include: { plan: { select: { name: true } }, organization: { select: { name: true } } },
          orderBy: { createdAt: "desc" },
          take: 20,
        }),
        prisma.subscriptionEvent.findMany({
          orderBy: { createdAt: "desc" },
          take: 30,
          include: { subscription: { include: { organization: { select: { name: true } } } } },
        }),
      ]
    );

    const statusCounts = Object.fromEntries(byStatus.map(row => [row.status, row._count._all]));

    res.json({
      data: {
        businesses,
        subscriptions: statusCounts,
        activeSubscriptions: (statusCounts.ACTIVE ?? 0) + (statusCounts.TRIALING ?? 0),
        trialingSubscriptions: trials,
        // Left in cents with the currency beside it. A revenue total rendered as a float
        // and then summed by a browser is how a platform under-reports itself by a cent.
        revenue: {
          monthStart,
          amountCents: revenue._sum.amountCents ?? 0,
          payments: revenue._count._all,
          currency: "USD",
        },
        failedPayments: failedPayments.map(payment => ({
          reference: payment.reference,
          organizationName: payment.organization.name,
          planName: payment.plan.name,
          amountCents: payment.amountCents,
          currency: payment.currency,
          reason: payment.failureReason,
          at: payment.createdAt,
        })),
        recentEvents: recentEvents.map(event => ({
          type: event.type,
          organizationName: event.subscription.organization.name,
          fromStatus: event.fromStatus,
          toStatus: event.toStatus,
          reason: event.reason,
          at: event.createdAt,
        })),
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Grants a business something its plan does not include.
 *
 * This is the supported way to sell an exception: one attributable row with a reason and an
 * optional expiry, rather than inventing a plan per customer or editing somebody's
 * subscription by hand in a console and leaving no record of who did it.
 */
platformRouter.post(
  "/overrides",
  requirePlatformScope(PLATFORM_ADMIN_SCOPES.BILLING),
  async (req: AuthRequest, res, next) => {
    try {
      const organizationId = String(req.body?.organizationId ?? "").trim();
      const featureKey = String(req.body?.featureKey ?? "").trim();
      const limitKey = String(req.body?.limitKey ?? "").trim();
      const reason = String(req.body?.reason ?? "").trim();
      const value = req.body?.value;
      const expiresAt = req.body?.expiresAt ? new Date(String(req.body.expiresAt)) : null;

      if (!organizationId) throw new AppError(400, "A business is required");
      if (!reason) {
        throw new AppError(
          400,
          "A reason is required. Every exception is attributable and this is what records it."
        );
      }
      if (expiresAt && Number.isNaN(expiresAt.getTime())) {
        throw new AppError(400, "The expiry date is not valid");
      }

      const isFeature = Boolean(featureKey);
      if (!isFeature && !limitKey) {
        throw new AppError(400, "Either a feature or a limit is required");
      }

      const override = await prisma.entitlementOverride.create({
        data: {
          organizationId,
          kind: isFeature ? "FEATURE" : "LIMIT",
          featureKey: isFeature ? featureKey : null,
          limitKey: isFeature ? null : limitKey,
          value: value ?? (isFeature ? true : 0),
          reason,
          expiresAt,
        },
      });

      res.status(201).json({ data: override });
    } catch (err) {
      next(err);
    }
  }
);
