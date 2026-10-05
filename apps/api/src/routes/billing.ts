import { Router } from "express";
import { prisma } from "../lib/prisma";
import type { AuthRequest } from "../middleware/auth";
import { requireAuth, requirePermission } from "../middleware/auth";
import { AppError } from "../lib";
import { withEntitlements } from "../middleware/entitlements";
import { getEntitlements, readLimits } from "../services/entitlements";
import { confirmCheckout, openCheckout, subscriptionPaymentsReady } from "../services/billing";
import {
  cancelScheduledPlanChange,
  cancelSubscription,
  planChangeOutcome,
  resumeSubscription,
  schedulePlanChange,
} from "../services/subscriptions";

export const billingRouter = Router();

/**
 * A business managing its own subscription.
 *
 * Every route here is scoped to the caller's own organization: the subscription is resolved
 * by `req.organizationId`, which comes from the session, never from the request body. There
 * is deliberately no route that takes a business id, because the one that does is how a
 * customer ends up cancelling somebody else's subscription.
 *
 * Changes that cost money go through the same Paystack checkout as a first purchase. There
 * is no "change my plan" route that edits a subscription directly.
 */

billingRouter.use(requireAuth, withEntitlements);

/**
 * Everything the Billing tab in Settings draws, in one request.
 *
 * The plan, the status as the clock reports it, the renewal date, the card on file, usage
 * against each allowance, the warnings, and the recent payments. One call rather than six,
 * so the page cannot render half a billing screen because one of six requests failed.
 */
billingRouter.get("/summary", async (req: AuthRequest, res, next) => {
  try {
    const entitlements = await getEntitlements(req.organizationId!);
    const [subscription, limits, payments] = await Promise.all([
      prisma.subscription.findUnique({
        where: { organizationId: req.organizationId },
        include: {
          plan: { select: { key: true, name: true, description: true, isFree: true } },
          planPrice: true,
          pendingPlan: { select: { key: true, name: true } },
        },
      }),
      readLimits(entitlements),
      prisma.subscriptionPayment.findMany({
        where: { organizationId: req.organizationId },
        include: { plan: { select: { name: true, key: true } } },
        orderBy: { createdAt: "desc" },
        take: 12,
      }),
    ]);

    res.json({
      data: {
        plan: {
          key: entitlements.planKey,
          name: entitlements.planName,
          description: entitlements.planDescription,
          isFree: entitlements.planIsFree,
          trialDays: entitlements.planTrialDays,
        },
        status: entitlements.status,
        // Worth telling the caller when these differ: it means the stored status has not
        // caught up with the dates yet, which is normal and is not an error.
        statusIsDerived: entitlements.storedStatus !== entitlements.status,
        isActive: entitlements.isActive,
        isTrialing: entitlements.isTrialing,
        inGrace: entitlements.inGrace,
        isExpired: entitlements.isExpired,

        currentPeriodStart: entitlements.currentPeriodStart,
        currentPeriodEnd: entitlements.currentPeriodEnd,
        renewalDate: entitlements.currentPeriodEnd,
        trialEndsAt: entitlements.trialEndsAt,
        graceEndsAt: entitlements.graceEndsAt,
        cancelAtPeriodEnd: entitlements.cancelAtPeriodEnd,
        endsAt: entitlements.endsAt,

        // Only ever a brand and four digits. The full number and the token live with the
        // provider and are never stored here.
        paymentMethod: subscription?.paymentMethodBrand
          ? {
              brand: subscription.paymentMethodBrand,
              last4: subscription.paymentMethodLast4,
              expiry: subscription.paymentMethodExpiry,
            }
          : null,

        pendingPlan: subscription?.pendingPlan ?? null,
        pendingPlanChangeAt: subscription?.pendingPlanChangeAt ?? null,

        price: subscription?.planPrice
          ? {
              amountCents: subscription.planPrice.amountCents,
              currency: subscription.planPrice.currency,
              interval: subscription.billingInterval,
            }
          : null,

        // The usage table, which reports every allowance truthfully including the ones
        // that are spent.
        usage: limits,

        // Nudges are for an allowance that is nearly gone, not one that is exactly full from
        // the moment the account exists.
        //
        // Registration creates a business with one branch, and Community allows one, so a
        // brand new account is born at 100% of its branch allowance. Greeting an owner who
        // has done nothing at all with "you have used all of your branches, upgrade to add
        // more" is exactly the sort of upsell trap a product that calls its free tier
        // complete should not open with.
        //
        // The number is still shown truthfully in the usage table either way. What is
        // withheld is only the banner; when they actually reach for another location they
        // get the refusal, which explains it and offers the upgrade in the same breath.
        warnings: limits
          .filter(limit => limit.warning && !limit.atLimit)
          .map(limit => ({
            key: limit.key,
            label: limit.label,
            used: limit.used,
            limit: limit.limit,
            remaining: limit.remaining,
            atLimit: limit.atLimit,
            message: `You have used ${Math.min(
              100,
              Math.round((limit.used / (limit.limit || 1)) * 100)
            )}% of your ${limit.label} allowance.`,
          })),

        paymentsEnabled: subscriptionPaymentsReady(),
        recentPayments: payments.map(payment => ({
          id: payment.id,
          reference: payment.reference,
          planName: payment.plan.name,
          amountCents: payment.amountCents,
          currency: payment.currency,
          kind: payment.kind,
          status: payment.status,
          paidAt: payment.paidAt,
          createdAt: payment.createdAt,
          failureReason: payment.failureReason,
        })),
      },
    });
  } catch (err) {
    next(err);
  }
});

/** The invoice and payment history, for the full billing page rather than the summary. */
billingRouter.get(
  "/payments",
  requirePermission("settings.manage"),
  async (req: AuthRequest, res, next) => {
    try {
      const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
      const payments = await prisma.subscriptionPayment.findMany({
        where: { organizationId: req.organizationId },
        include: { plan: { select: { name: true, key: true } } },
        orderBy: { createdAt: "desc" },
        take: limit,
      });
      res.json({
        data: payments.map(payment => ({
          id: payment.id,
          reference: payment.reference,
          planName: payment.plan.name,
          amountCents: payment.amountCents,
          currency: payment.currency,
          kind: payment.kind,
          status: payment.status,
          periodStart: payment.periodStart,
          periodEnd: payment.periodEnd,
          paidAt: payment.paidAt,
          failureReason: payment.failureReason,
          refundedAt: payment.refundedAt,
          createdAt: payment.createdAt,
        })),
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * The subscription ledger: what happened, and when.
 *
 * The current Subscription row can only describe the present. A business that was
 * downgraded, charged twice or left in grace is asking about the past, and this is where
 * that question is answered.
 */
billingRouter.get(
  "/history",
  requirePermission("settings.manage"),
  async (req: AuthRequest, res, next) => {
    try {
      const events = await prisma.subscriptionEvent.findMany({
        where: { subscription: { organizationId: req.organizationId } },
        orderBy: { createdAt: "desc" },
        take: 50,
      });
      res.json({
        data: events.map(event => ({
          id: event.id,
          type: event.type,
          fromStatus: event.fromStatus,
          toStatus: event.toStatus,
          reason: event.reason,
          createdAt: event.createdAt,
        })),
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * What this business is entitled to, so the interface can decide what to show.
 *
 * A display aid and nothing more. Every route these flags describe checks again on the
 * server, so hiding a menu item because of this response protects nothing, and this
 * endpoint is not worth protecting either.
 */
billingRouter.get("/entitlements", async (req: AuthRequest, res, next) => {
  try {
    const entitlements = await getEntitlements(req.organizationId!);
    res.json({
      data: {
        planKey: entitlements.planKey,
        status: entitlements.status,
        isActive: entitlements.isActive,
        features: [...entitlements.features],
        limits: [...entitlements.limits.values()].map(limit => ({
          key: limit.key,
          value: limit.value,
          unlimited: limit.value === -1,
          unit: limit.unit,
          period: limit.period,
        })),
      },
    });
  } catch (err) {
    next(err);
  }
});

// ============================================================================
// Changing what a business pays
// ============================================================================

/**
 * Starts a checkout for a plan.
 *
 * Returns an authorization URL and nothing else. The subscription has not changed by the
 * time this answers, and will not change until `confirmCheckout` has asked Paystack
 * whether the money arrived. That is the whole design: a response body is not a payment.
 */
billingRouter.post(
  "/checkout",
  requirePermission("settings.manage"),
  async (req: AuthRequest, res, next) => {
    try {
      const planKey = String(req.body?.planKey ?? "").trim();
      const interval = String(req.body?.interval ?? "monthly").trim();
      const email = String(req.body?.email ?? "")
        .trim()
        .toLowerCase();
      const idempotencyKey =
        typeof req.body?.idempotencyKey === "string" ? req.body.idempotencyKey : undefined;

      if (!planKey) throw new AppError(400, "A plan is required");
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        throw new AppError(400, "A valid email is required so you can receive your receipts");
      }

      const result = await openCheckout({
        organizationId: req.organizationId!,
        planKey,
        interval,
        email,
        idempotencyKey,
        actorUserId: req.userId,
      });

      res.json({
        data: {
          ...result,
          // Said plainly, so a client about to redirect knows it is not finished yet.
          message: "Complete the payment to change your plan. Nothing has changed yet.",
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * The customer came back from the payment popup.
 *
 * The browser only says "I am back". The server asks Paystack what actually happened, so
 * a button in the console cannot mark a plan as paid. The webhook usually gets there first,
 * in which case this finds the payment already settled and does nothing.
 */
billingRouter.post(
  "/checkout/confirm",
  requirePermission("settings.manage"),
  async (req: AuthRequest, res, next) => {
    try {
      const reference = String(req.body?.reference ?? "").trim();
      if (!reference) throw new AppError(400, "A payment reference is required");

      // Scoped to the caller's own business before anything is confirmed, so a reference
      // belonging to another customer is not found, let alone settled.
      const owned = await prisma.subscriptionPayment.findFirst({
        where: { reference, organizationId: req.organizationId! },
        select: { id: true },
      });
      if (!owned) throw new AppError(404, "Payment not found");

      const result = await confirmCheckout(reference);
      res.json({ data: result });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * What a plan change would actually do, before the customer commits to it.
 *
 * The pricing page calls this so "Upgrade" and "Downgrade" are labelled correctly, and so a
 * downgrade can say when it takes effect instead of surprising somebody at the end of the
 * month they paid for.
 */
billingRouter.get(
  "/change-plan/:key",
  requirePermission("settings.manage"),
  async (req: AuthRequest, res, next) => {
    try {
      const outcome = await planChangeOutcome({
        organizationId: req.organizationId!,
        targetPlanKey: req.params.key,
      });
      res.json({ data: outcome });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * Moves a business to a plan they already pay less for.
 *
 * Upgrades do not come through here: they need payment, so they go to `/checkout` and are
 * applied once Paystack confirms. Scheduling only the direction that costs the customer
 * nothing today is what keeps this route from being a way to grant a plan for nothing.
 */
billingRouter.post(
  "/downgrade",
  requirePermission("settings.manage"),
  async (req: AuthRequest, res, next) => {
    try {
      const planKey = String(req.body?.planKey ?? "").trim();
      if (!planKey) throw new AppError(400, "A plan is required");

      const effectiveAt = await schedulePlanChange({
        organizationId: req.organizationId!,
        targetPlanKey: planKey,
        actorUserId: req.userId,
      });

      res.json({
        data: {
          effectiveAt,
          message:
            "Your plan will change at the end of the period you have already paid for. You keep everything you have until then.",
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

/** Withdraws a scheduled downgrade before it takes effect. */
billingRouter.delete(
  "/downgrade",
  requirePermission("settings.manage"),
  async (req: AuthRequest, res, next) => {
    try {
      await cancelScheduledPlanChange(req.organizationId!);
      res.json({ data: { message: "Your scheduled plan change has been cancelled." } });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * Cancels the subscription.
 *
 * Defaults to the end of the period already paid for. `immediate` is honoured when asked
 * for explicitly, and the ledger records which of the two happened so an owner can see
 * later that they chose it.
 *
 * Nothing about the business is deleted either way.
 */
billingRouter.post(
  "/cancel",
  requirePermission("settings.manage"),
  async (req: AuthRequest, res, next) => {
    try {
      const immediate = req.body?.immediate === true;
      const result = await cancelSubscription({
        organizationId: req.organizationId!,
        immediate,
        reason: typeof req.body?.reason === "string" ? req.body.reason : undefined,
        actorUserId: req.userId,
      });

      res.json({
        data: {
          effectiveAt: result.effectiveAt,
          message: immediate
            ? "Your subscription has been cancelled. Your data is safe and will be here if you come back."
            : `Your subscription will end at the close of the period you have paid for. Your data is safe.`,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

/** Undoes a cancellation that has not taken effect yet. */
billingRouter.post(
  "/resume",
  requirePermission("settings.manage"),
  async (req: AuthRequest, res, next) => {
    try {
      await resumeSubscription({
        organizationId: req.organizationId!,
        actorUserId: req.userId,
      });
      res.json({ data: { message: "Your subscription will carry on as before." } });
    } catch (err) {
      next(err);
    }
  }
);
