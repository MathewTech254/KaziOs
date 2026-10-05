import { randomUUID } from "crypto";
import { prisma } from "../lib/prisma";
import { AppError } from "../middleware/errorHandler";
import {
  BILLING_INTERVALS,
  DEFAULT_PLAN_KEY,
  SUBSCRIPTION_EVENT,
  SUBSCRIPTION_PAYMENT_STATUS,
  SUBSCRIPTION_STATUS,
} from "@kazios/types";
import { invalidateEntitlements, getEntitlements, readLimits } from "./entitlements";
import { announceBilling, announceUsageWarning } from "./billingNotifications";
import {
  disableSubscription,
  enableSubscription,
} from "../lib/paystack";

/**
 * Everything that changes a subscription's state.
 *
 * Two rules hold across this whole file and are the reason the billing layer can be
 * trusted:
 *
 *   1. A subscription is only ever activated by a confirmed payment. Nothing in here
 *      takes a "the browser said it succeeded" argument, because the browser is the one
 *      party in this system with no reason to tell the truth.
 *   2. Every transition writes a SubscriptionEvent. The current row can describe the
 *      present; the ledger is the only thing that can answer "why is my plan like this",
 *      which is the question a cancelled or downgraded customer is actually asking.
 *
 * Nothing in here deletes business data. The worst a lapsed subscription does is stop
 * granting paid capabilities.
 */

/** How long a business keeps working after a renewal fails. */
const DEFAULT_GRACE_DAYS = 7;

/** A reference a human can read down a phone if a charge is ever disputed. */
export function newSubscriptionReference(planKey: string): string {
  return `SUB-${planKey
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 8)}-${randomUUID().slice(0, 8)}`;
}

/**
 * The end of a billing period, counted from a start.
 *
 * A month is added by calendar, not by adding 30 days: "a month" that ends on 2 March
 * when it started on 28 February is a short month billed as a full one, and a customer
 * paying monthly should always get the month they paid for.
 */
export function addInterval(start: Date, interval: string): Date {
  const end = new Date(start);
  if (interval === BILLING_INTERVALS.YEARLY) {
    end.setUTCFullYear(end.getUTCFullYear() + 1);
  } else if (interval === BILLING_INTERVALS.CUSTOM) {
    end.setUTCFullYear(end.getUTCFullYear() + 1);
  } else {
    end.setUTCMonth(end.getUTCMonth() + 1);
  }
  return end;
}

/**
 * Records something that happened to a subscription.
 *
 * Never throws: the ledger is how a state change is explained, but losing the
 * explanation is not a reason to fail the action that was already committed.
 */
export async function recordEvent(input: {
  subscriptionId: string;
  type: string;
  fromStatus?: string | null;
  toStatus?: string | null;
  fromPlanId?: string | null;
  toPlanId?: string | null;
  reason?: string | null;
  actorUserId?: string | null;
  metadata?: Record<string, unknown> | null;
}): Promise<void> {
  try {
    await prisma.subscriptionEvent.create({
      data: {
        subscriptionId: input.subscriptionId,
        type: input.type,
        fromStatus: input.fromStatus ?? null,
        toStatus: input.toStatus ?? null,
        fromPlanId: input.fromPlanId ?? null,
        toPlanId: input.toPlanId ?? null,
        reason: input.reason ?? null,
        actorUserId: input.actorUserId ?? null,
        metadata: (input.metadata ?? undefined) as any,
      },
    });
  } catch (err) {
    console.error("Could not write subscription event:", err);
  }
}

// ============================================================================
// Reading the catalogue
// ============================================================================

/** A plan with the prices and grants needed to sell or grant it. */
export async function getPlanByKey(key: string) {
  return prisma.plan.findUnique({
    where: { key },
    include: { prices: true, limits: true, features: true },
  });
}

/**
 * The price for an interval on a plan, or null.
 *
 * Null rather than a zero: Enterprise is quoted, not sold, and returning 0 would let a
 * caller open a checkout for a plan that has no price. A null here is a refusal to sell.
 */
export async function getPlanPrice(planId: string, interval: string) {
  return prisma.planPrice.findFirst({
    where: { planId, interval, isActive: true },
    orderBy: { currency: "asc" },
  });
}

/** The plan every new business starts on. */
export async function getDefaultPlan() {
  const flagged = await prisma.plan.findFirst({
    where: { isDefault: true },
    include: { prices: { orderBy: { interval: "asc" } }, limits: true },
  });
  if (flagged) return flagged;
  // Belt and braces for a catalogue that was edited by hand and lost its default flag.
  return prisma.plan.findFirst({
    where: { key: DEFAULT_PLAN_KEY },
    include: { prices: { orderBy: { interval: "asc" } }, limits: true },
  });
}

// ============================================================================
// Creating and granting a subscription
// ============================================================================

/**
 * Gives a business its subscription, creating the row if it has none.
 *
 * Called at registration, and again whenever a business is found without one. It is
 * idempotent, because registration can be retried and a business that hit a partial
 * failure must end up in exactly the same state as one that did not.
 */
export async function ensureSubscription(organizationId: string): Promise<string> {
  const existing = await prisma.subscription.findUnique({
    where: { organizationId },
    select: { id: true },
  });
  if (existing) return existing.id;

  const plan = await getDefaultPlan();
  if (!plan) {
    // Without a default plan there is nothing honest to grant, and inventing one here
    // would hide a broken catalogue behind a working looking registration.
    throw new AppError(
      500,
      "No default plan is configured, so a new business cannot be created. Run the plan catalogue seed.",
      "NO_DEFAULT_PLAN"
    );
  }

  const price = await getPlanPrice(plan.id, BILLING_INTERVALS.MONTHLY);
  const subscription = await prisma.subscription.create({
    data: {
      organizationId,
      planId: plan.id,
      planPriceId: price?.id ?? null,
      status: SUBSCRIPTION_STATUS.ACTIVE,
      billingInterval: BILLING_INTERVALS.MONTHLY,
    },
    select: { id: true },
  });

  // The organization's own plan pointer is kept in step in the same write. Nothing is
  // granted from it on its own, but a stale value would misreport the plan in an admin
  // listing and in support conversations.
  await prisma.organization.update({ where: { id: organizationId }, data: { planId: plan.id } });

  await recordEvent({
    subscriptionId: subscription.id,
    type: SUBSCRIPTION_EVENT.CREATED,
    toStatus: SUBSCRIPTION_STATUS.ACTIVE,
    toPlanId: plan.id,
    reason: `New business created on the ${plan.name} plan`,
  });

  invalidateEntitlements(organizationId);
  return subscription.id;
}

/**
 * Gives a business a trial, if the plan it is moving to offers one.
 *
 * The trial is the same mechanism as a paid period rather than a flag: it sets the period
 * and records why it started, so "when does this end" has one answer in the data rather
 * than two that can disagree.
 */
export async function startTrial(input: {
  organizationId: string;
  planId: string;
  planKey: string;
  trialDays: number;
}): Promise<void> {
  if (input.trialDays <= 0) return;
  const now = new Date();
  // Straight days, not a month: a trial is a fixed promise of a fixed number of days, and
  // deriving it from a calendar month would make it 28 days in February and 31 in March.
  const trialEndsAt = new Date(now.getTime() + input.trialDays * 24 * 60 * 60 * 1000);

  await prisma.subscription.update({
    where: { organizationId: input.organizationId },
    data: {
      status: SUBSCRIPTION_STATUS.TRIALING,
      trialEndsAt,
      currentPeriodStart: now,
      currentPeriodEnd: trialEndsAt,
      graceEndsAt: null,
      endsAt: null,
    },
  });

  const subscription = await prisma.subscription.findUnique({
    where: { organizationId: input.organizationId },
    select: { id: true },
  });
  if (subscription) {
    await recordEvent({
      subscriptionId: subscription.id,
      type: SUBSCRIPTION_EVENT.TRIAL_STARTED,
      toStatus: SUBSCRIPTION_STATUS.TRIALING,
      toPlanId: input.planId,
      reason: `${input.trialDays} day trial of ${input.planKey}`,
      metadata: { trialDays: input.trialDays, trialEndsAt },
    });
  }
  invalidateEntitlements(input.organizationId);
}

// ============================================================================
// Activating a paid subscription
// ============================================================================

export interface ActivateInput {
  organizationId: string;
  planKey: string;
  interval: string;
  /** The payment row this activation is for. Its id makes activation exactly once. */
  paymentId: string;
  provider: string;
  providerRef?: string | null;
  paymentMethodBrand?: string | null;
  paymentMethodLast4?: string | null;
  paymentMethodExpiry?: string | null;
  /** Who pressed the button, for the ledger. Never trusted for anything else. */
  actorUserId?: string | null;
}

/**
 * Activates a subscription because a payment was confirmed.
 *
 * This is the only function in the codebase that can turn a paid plan on, and its one
 * argument that matters is `paymentId`: the caller must have a payment row that the
 * provider has confirmed. There is deliberately no `activate(planKey)` for anyone else to
 * reach for, because that is exactly the function that ends up on a route with no check.
 *
 * It is idempotent. A webhook and a returning browser will both arrive for one payment,
 * and the second must do nothing rather than extend the period a second time.
 */
export async function activateSubscription(input: ActivateInput): Promise<{
  changed: boolean;
  planKey: string;
}> {
  const payment = await prisma.subscriptionPayment.findUnique({
    where: { id: input.paymentId },
  });
  if (!payment) throw new AppError(404, "Subscription payment not found");
  if (payment.organizationId !== input.organizationId) {
    throw new AppError(403, "This payment belongs to another business");
  }

  // Already settled. Returning early here is what makes a replayed webhook harmless.
  if (payment.status === SUBSCRIPTION_PAYMENT_STATUS.SUCCESS) {
    const current = await prisma.subscription.findUnique({
      where: { organizationId: input.organizationId },
      select: { plan: { select: { key: true } } },
    });
    return { changed: false, planKey: current?.plan.key ?? input.planKey };
  }

  const plan = await getPlanByKey(input.planKey);
  if (!plan || plan.status !== "ACTIVE") {
    throw new AppError(400, "That plan is not available", "PLAN_UNAVAILABLE");
  }

  const price = await getPlanPrice(plan.id, input.interval);
  const before = await prisma.subscription.findUnique({
    where: { organizationId: input.organizationId },
    include: { plan: { select: { id: true, key: true, name: true, sortOrder: true } } },
  });

  const now = new Date();
  // The period runs from the payment, not from when the code happened to get round to
  // noticing it. A webhook that arrives late must not cost the customer paid days.
  const periodStart = now;
  const periodEnd = addInterval(periodStart, input.interval);

  // A trial already under way is converted rather than replaced, so a business that
  // upgrades on day three of its trial does not lose the remaining days as well as being
  // charged for them.
  const hadTrial = Boolean(before?.trialEndsAt && before.trialEndsAt > now);
  const trialEndsAt = hadTrial ? before!.trialEndsAt : null;

  await prisma.$transaction(async tx => {
    await tx.subscriptionPayment.update({
      where: { id: input.paymentId },
      data: {
        status: SUBSCRIPTION_PAYMENT_STATUS.SUCCESS,
        paidAt: now,
        providerRef: input.providerRef ?? null,
        periodStart,
        periodEnd,
        failureReason: null,
        planId: plan.id,
      },
    });

    await tx.subscription.update({
      where: { organizationId: input.organizationId },
      data: {
        planId: plan.id,
        planPriceId: price?.id ?? null,
        status: SUBSCRIPTION_STATUS.ACTIVE,
        billingInterval: input.interval,
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
        trialEndsAt,
        // Grace is cleared the moment money arrives. Leaving a lapsed grace date behind
        // is how a paying customer ends up expired a month later for no reason.
        graceEndsAt: null,
        cancelAtPeriodEnd: false,
        canceledAt: null,
        endsAt: null,
        provider: input.provider,
        paymentMethodBrand: input.paymentMethodBrand ?? null,
        paymentMethodLast4: input.paymentMethodLast4 ?? null,
        paymentMethodExpiry: input.paymentMethodExpiry ?? null,
      },
    });

    await tx.organization.update({
      where: { id: input.organizationId },
      data: { planId: plan.id },
    });
  });

  const upgraded = isUpgrade(before?.plan?.sortOrder ?? 0, plan.sortOrder);
  await recordEvent({
    subscriptionId: before?.id ?? payment.subscriptionId,
    type: hadTrial
      ? SUBSCRIPTION_EVENT.ACTIVATED
      : upgraded
        ? SUBSCRIPTION_EVENT.UPGRADED
        : SUBSCRIPTION_EVENT.ACTIVATED,
    fromStatus: before?.status ?? null,
    toStatus: SUBSCRIPTION_STATUS.ACTIVE,
    fromPlanId: before?.planId ?? null,
    toPlanId: plan.id,
    reason: `Payment confirmed for the ${plan.name} plan (${input.interval})`,
    actorUserId: input.actorUserId ?? null,
    metadata: { paymentId: input.paymentId, periodStart, periodEnd, provider: input.provider },
  });

  // The customer is told, by email as well as in the app, because "did my payment go
  // through?" is the one billing question nobody should have to ask a support inbox.
  await announceBilling({
    organizationId: input.organizationId,
    title: `${plan.name} is active`,
    body: `Your ${plan.name} plan is live. Everything it includes is switched on, and the current period runs until ${periodEnd.toDateString()}.`,
    type: "success",
    dedupeKey: `billing-activated:${input.paymentId}`,
    email: {
      subject: `Your KaziOS ${plan.name} subscription is active`,
      paragraph: `Your payment was confirmed and the ${plan.name} plan is now active. The current period runs until ${periodEnd.toDateString()}. You can review your plan, usage and payments from the billing page.`,
    },
  });

  invalidateEntitlements(input.organizationId);
  return { changed: true, planKey: plan.key };
}

/** A higher sort order is a higher tier, which is how up and down are told apart. */
export function isUpgrade(fromSortOrder: number, toSortOrder: number): boolean {
  return toSortOrder > fromSortOrder;
}

// ============================================================================
// Renewals, failures and grace
// ============================================================================

/**
 * Moves a subscription into a new paid period after a confirmed renewal.
 *
 * Counted from the end of the period that just ended rather than from today, so a renewal
 * that lands an hour late does not shorten the customer's month. Overlapping renewals are
 * the usual cause of a business being charged twice for one period of service, and this
 * is the line that prevents it.
 */
export async function renewSubscription(input: {
  organizationId: string;
  paymentId: string;
  interval: string;
  providerRef?: string | null;
}): Promise<void> {
  const subscription = await prisma.subscription.findUnique({
    where: { organizationId: input.organizationId },
    select: {
      id: true,
      currentPeriodEnd: true,
      status: true,
      planId: true,
      plan: { select: { name: true } },
    },
  });
  if (!subscription) return;

  const now = new Date();
  const start =
    subscription.currentPeriodEnd && subscription.currentPeriodEnd > now
      ? subscription.currentPeriodEnd
      : now;

  await prisma.$transaction(async tx => {
    await tx.subscriptionPayment.update({
      where: { id: input.paymentId },
      data: {
        status: SUBSCRIPTION_PAYMENT_STATUS.SUCCESS,
        paidAt: now,
        providerRef: input.providerRef ?? null,
      },
    });
    await tx.subscription.update({
      where: { organizationId: input.organizationId },
      data: {
        status: SUBSCRIPTION_STATUS.ACTIVE,
        currentPeriodStart: start,
        currentPeriodEnd: addInterval(start, input.interval),
        graceEndsAt: null,
        // A renewal clears a scheduled downgrade only when the pending plan is the one
        // being renewed; otherwise the business renewed precisely so as not to downgrade.
      },
    });
  });

  await recordEvent({
    subscriptionId: subscription.id,
    type: SUBSCRIPTION_EVENT.RENEWED,
    fromStatus: subscription.status,
    toStatus: SUBSCRIPTION_STATUS.ACTIVE,
    reason: `Renewed for another ${input.interval}`,
    metadata: { paymentId: input.paymentId },
  });

  await announceBilling({
    organizationId: input.organizationId,
    title: `${subscription.plan.name} renewed`,
    body: `Payment received. Your plan now runs until ${addInterval(start, input.interval).toDateString()}.`,
    type: "success",
    dedupeKey: `billing-renewed:${input.paymentId}`,
    email: {
      subject: `Your KaziOS ${subscription.plan.name} subscription renewed`,
      paragraph: `Your renewal payment was confirmed. The ${subscription.plan.name} plan now runs until ${addInterval(start, input.interval).toDateString()}.`,
    },
  });

  invalidateEntitlements(input.organizationId);
}

/**
 * Records a renewal that did not happen.
 *
 * This is the whole point of grace. A failed payment does not end a business's day: it
 * starts a clock, and the business is told about it, so somebody can fix a card before
 * anything is taken away. The stored status is only moved to PAST_DUE the first time;
 * a provider retrying every few minutes must not write a page of events saying the same
 * thing, and must not push the grace end date further out each time.
 */
export async function recordPaymentFailure(input: {
  organizationId: string;
  paymentId?: string | null;
  reason: string;
  interval: string;
}): Promise<void> {
  const subscription = await prisma.subscription.findUnique({
    where: { organizationId: input.organizationId },
    select: {
      id: true,
      status: true,
      currentPeriodEnd: true,
      graceEndsAt: true,
      plan: { select: { name: true } },
    },
  });
  if (!subscription) return;

  const now = new Date();
  // Grace is measured from when the period actually ran out, not from each failed retry.
  const graceStart =
    subscription.currentPeriodEnd && subscription.currentPeriodEnd > now
      ? subscription.currentPeriodEnd
      : now;
  const graceEndsAt = new Date(graceStart.getTime() + DEFAULT_GRACE_DAYS * 24 * 60 * 60 * 1000);
  const alreadyFailing = subscription.status === SUBSCRIPTION_STATUS.PAST_DUE;

  if (input.paymentId) {
    await prisma.subscriptionPayment
      .update({
        where: { id: input.paymentId },
        data: { status: SUBSCRIPTION_PAYMENT_STATUS.FAILED, failureReason: input.reason },
      })
      .catch(() => undefined);
  }

  await prisma.subscription.update({
    where: { organizationId: input.organizationId },
    data: {
      status: SUBSCRIPTION_STATUS.PAST_DUE,
      graceEndsAt: subscription.graceEndsAt ?? graceEndsAt,
    },
  });

  if (!alreadyFailing) {
    await recordEvent({
      subscriptionId: subscription.id,
      type: SUBSCRIPTION_EVENT.PAST_DUE,
      fromStatus: subscription.status,
      toStatus: SUBSCRIPTION_STATUS.PAST_DUE,
      reason: input.reason,
      metadata: { graceEndsAt, graceDays: DEFAULT_GRACE_DAYS },
    });

    // The first failure is the one worth shouting about. Later retries within the same
    // grace window are the same story, and the dedupe key keeps them one alert.
    await announceBilling({
      organizationId: input.organizationId,
      title: "Your renewal payment failed",
      body: `${input.reason}. Nothing has been taken away yet: your plan keeps working until ${graceEndsAt.toDateString()}. Update your payment method to carry on without interruption.`,
      type: "warning",
      dedupeKey: `billing-past-due:${subscription.id}`,
      email: {
        subject: "Your KaziOS renewal payment failed",
        paragraph: `We could not take your renewal payment for the ${subscription.plan.name} plan (${input.reason}). Your business keeps working until ${graceEndsAt.toDateString()}; update your payment method from the billing page to avoid interruption. Nothing you have created will be deleted.`,
      },
    });
  }

  invalidateEntitlements(input.organizationId);
}

/** Marks a subscription expired once grace has run out. Data is never touched. */
export async function expireSubscription(input: {
  organizationId: string;
  reason: string;
}): Promise<void> {
  const subscription = await prisma.subscription.findUnique({
    where: { organizationId: input.organizationId },
    select: { id: true, status: true, planId: true, plan: { select: { name: true } } },
  });
  if (!subscription || subscription.status === SUBSCRIPTION_STATUS.EXPIRED) return;

  await prisma.subscription.update({
    where: { organizationId: input.organizationId },
    data: { status: SUBSCRIPTION_STATUS.EXPIRED, endsAt: new Date() },
  });

  await recordEvent({
    subscriptionId: subscription.id,
    type: SUBSCRIPTION_EVENT.EXPIRED,
    fromStatus: subscription.status,
    toStatus: SUBSCRIPTION_STATUS.EXPIRED,
    reason: input.reason,
  });

  // The words matter here. Expired is a restriction, not a deletion, and a customer who
  // reads "your subscription ended" must also read that their data is still there.
  await announceBilling({
    organizationId: input.organizationId,
    title: `Your ${subscription.plan.name} subscription has expired`,
    body: `Paid capabilities are paused, but your business data is safe — every product, customer, sale and report is exactly where you left it. Upgrade to put them back to work.`,
    type: "error",
    dedupeKey: `billing-expired:${subscription.id}`,
    email: {
      subject: `Your KaziOS ${subscription.plan.name} subscription has expired`,
      paragraph: `Your subscription has ended and paid capabilities are paused. Nothing has been deleted: all of your products, customers, sales and reports are intact. Renew or upgrade from the billing page to carry on where you left off.`,
    },
  });

  // The plan pointer is left alone deliberately: it records what the business last had,
  // so support can see at a glance that they were a paying customer, and their data and
  // history are untouched.
  invalidateEntitlements(input.organizationId);
}

// ============================================================================
// Cancellation
// ============================================================================

/**
 * Cancels a subscription.
 *
 * The default is at the end of the period already paid for, because taking away something
 * a customer has paid for before it runs out is how a business loses trust over a
 * bookkeeping convenience. Immediate cancellation is allowed when asked for explicitly,
 * and says so in the ledger.
 */
export async function cancelSubscription(input: {
  organizationId: string;
  immediate?: boolean;
  reason?: string;
  actorUserId?: string | null;
}): Promise<{ effectiveAt: Date | null }> {
  const subscription = await prisma.subscription.findUnique({
    where: { organizationId: input.organizationId },
    select: {
      id: true,
      status: true,
      currentPeriodEnd: true,
      planId: true,
      plan: { select: { isFree: true, name: true } },
      providerSubscriptionCode: true,
    },
  });
  if (!subscription) throw new AppError(404, "No subscription to cancel");

  // Community costs nothing, so there is nothing to cancel and no reason to pretend
  // otherwise by writing a CANCELED row over a plan the business never paid for.
  if (subscription.plan.isFree) {
    throw new AppError(400, "The Community plan is free and does not need to be cancelled");
  }
  if (subscription.status === SUBSCRIPTION_STATUS.CANCELED) {
    return { effectiveAt: subscription.currentPeriodEnd };
  }

  const now = new Date();
  const atPeriodEnd = !input.immediate;
  const effectiveAt = atPeriodEnd ? (subscription.currentPeriodEnd ?? now) : now;

  await prisma.subscription.update({
    where: { organizationId: input.organizationId },
    data: {
      cancelAtPeriodEnd: atPeriodEnd,
      canceledAt: now,
      endsAt: effectiveAt,
      // Not CANCELED yet when it is scheduled: the business keeps working until the date
      // they were promised, and `resolveStatus` reports the truth in the meantime.
      status: atPeriodEnd ? subscription.status : SUBSCRIPTION_STATUS.CANCELED,
    },
  });

  await recordEvent({
    subscriptionId: subscription.id,
    type: SUBSCRIPTION_EVENT.CANCELED,
    fromStatus: subscription.status,
    toStatus: atPeriodEnd ? subscription.status : SUBSCRIPTION_STATUS.CANCELED,
    reason:
      input.reason ??
      (atPeriodEnd ? "Cancelled, to end at the close of the paid period" : "Cancelled immediately"),
    actorUserId: input.actorUserId ?? null,
    metadata: { immediate: Boolean(input.immediate), effectiveAt },
  });

  // Stop the provider charging again. Local state is the authority either way — a
  // provider that cannot be reached now does not change what the customer decided —
  // but a failure here would mean a card being charged after a cancellation, so it is
  // written to the ledger rather than swallowed.
  if (subscription.providerSubscriptionCode) {
    try {
      await disableSubscription(subscription.providerSubscriptionCode);
    } catch (err) {
      await recordEvent({
        subscriptionId: subscription.id,
        type: "RECURRING_DISABLE_FAILED",
        reason: `Paystack could not be told to stop renewing: ${(err as Error).message}. Renewal must be stopped from the Paystack dashboard before the next period.`,
      });
    }
  }

  await announceBilling({
    organizationId: input.organizationId,
    title: "Your subscription is cancelled",
    body: atPeriodEnd
      ? `${subscription.plan.name} will end on ${effectiveAt?.toDateString() ?? "the last day of the period you paid for"}. Until then everything carries on as usual, and your data stays exactly where it is.`
      : `Your ${subscription.plan.name} subscription has ended. Nothing has been deleted — your data stays exactly where it is, ready when you return.`,
    type: "info",
    dedupeKey: `billing-canceled:${subscription.id}:${Date.now()}`,
    excludeUserIds: input.actorUserId ? [input.actorUserId] : [],
  });

  invalidateEntitlements(input.organizationId);
  return { effectiveAt };
}

/** Undoes a cancellation that has not taken effect yet. */
export async function resumeSubscription(input: {
  organizationId: string;
  actorUserId?: string | null;
}): Promise<void> {
  const subscription = await prisma.subscription.findUnique({
    where: { organizationId: input.organizationId },
    select: {
      id: true,
      status: true,
      canceledAt: true,
      providerSubscriptionCode: true,
      plan: { select: { name: true } },
    },
  });
  if (!subscription) throw new AppError(404, "No subscription to resume");
  if (!subscription.canceledAt) return;

  await prisma.subscription.update({
    where: { organizationId: input.organizationId },
    data: {
      cancelAtPeriodEnd: false,
      canceledAt: null,
      endsAt: null,
      status: SUBSCRIPTION_STATUS.ACTIVE,
    },
  });

  // Turn automatic renewal back on. If the provider says no, the plan still carries on
  // locally and the manual renewal path covers the period — the customer is not left
  // with a "resumed" subscription that will silently lapse.
  if (subscription.providerSubscriptionCode) {
    try {
      await enableSubscription(subscription.providerSubscriptionCode);
    } catch (err) {
      await recordEvent({
        subscriptionId: subscription.id,
        type: "RECURRING_ENABLE_FAILED",
        reason: `Paystack could not be told to resume renewing: ${(err as Error).message}. Automatic renewal will fall back to a checkout link if the next period is missed.`,
      });
    }
  }

  await recordEvent({
    subscriptionId: subscription.id,
    type: SUBSCRIPTION_EVENT.RESUMED,
    fromStatus: subscription.status,
    toStatus: SUBSCRIPTION_STATUS.ACTIVE,
    reason: "Cancellation withdrawn",
    actorUserId: input.actorUserId ?? null,
  });

  await announceBilling({
    organizationId: input.organizationId,
    title: "Your subscription is active again",
    body: `The cancellation was withdrawn. Your ${subscription.plan.name} plan carries on as before.`,
    type: "success",
    dedupeKey: `billing-resumed:${subscription.id}:${Date.now()}`,
    excludeUserIds: input.actorUserId ? [input.actorUserId] : [],
  });

  invalidateEntitlements(input.organizationId);
}

// ============================================================================
// Changing plan
// ============================================================================

export type PlanChangeOutcome =
  | { action: "UPGRADE_NOW"; planKey: string; trialDays: number }
  | { action: "DOWNGRADE_AT_PERIOD_END"; planKey: string; effectiveAt: Date }
  | { action: "SAME"; planKey: string };

/**
 * Works out what a request to change plan should actually do.
 *
 * Upgrades take effect immediately, because a customer paying more expects to be able to
 * use what they paid for the moment they pay. Downgrades wait for the period to end,
 * because a business that has paid for a year keeps that year's limits for that year; the
 * alternative is refunding the difference and telling a customer mid month that the seats
 * they had yesterday are gone today.
 *
 * Deciding this here, as one function, is what stops the pricing page and the checkout
 * that follows it from disagreeing about what the customer just asked for.
 */
export async function planChangeOutcome(input: {
  organizationId: string;
  targetPlanKey: string;
}): Promise<PlanChangeOutcome> {
  const [current, target] = await Promise.all([
    prisma.subscription.findUnique({
      where: { organizationId: input.organizationId },
      include: { plan: { select: { key: true, sortOrder: true } } },
    }),
    getPlanByKey(input.targetPlanKey),
  ]);

  // A private plan exists because somebody negotiated it. It is granted deliberately and
  // never offered on a page a customer can reach.
  if (!target || target.status !== "ACTIVE" || target.visibility === "PRIVATE") {
    throw new AppError(404, "That plan is not available", "PLAN_UNAVAILABLE");
  }
  if (!current) throw new AppError(404, "No subscription to change");

  if (current.plan.key === target.key) return { action: "SAME", planKey: target.key };

  if (isUpgrade(current.plan.sortOrder, target.sortOrder)) {
    return { action: "UPGRADE_NOW", planKey: target.key, trialDays: target.trialDays };
  }

  return {
    action: "DOWNGRADE_AT_PERIOD_END",
    planKey: target.key,
    effectiveAt: current.currentPeriodEnd ?? new Date(),
  };
}

/**
 * Records a downgrade to be applied when the paid period ends.
 *
 * Only the plan is scheduled. Nothing is deleted and no allowance is revoked early: when
 * the period ends the new limits apply, and a business that is now over them keeps
 * everything it already has and simply cannot add more. See `isAtLimit`.
 */
export async function schedulePlanChange(input: {
  organizationId: string;
  targetPlanKey: string;
  actorUserId?: string | null;
}): Promise<Date> {
  const outcome = await planChangeOutcome(input);
  if (outcome.action === "SAME") {
    throw new AppError(400, "You are already on that plan", "PLAN_UNCHANGED");
  }
  if (outcome.action === "UPGRADE_NOW") {
    // An upgrade needs money before it happens. Saying so beats silently scheduling it
    // for later, which a customer would reasonably read as "done".
    throw new AppError(
      400,
      "An upgrade takes effect as soon as payment is confirmed",
      "UPGRADE_REQUIRES_PAYMENT"
    );
  }

  const target = await getPlanByKey(input.targetPlanKey);
  const subscription = await prisma.subscription.findUnique({
    where: { organizationId: input.organizationId },
    select: { id: true, planId: true },
  });
  if (!subscription || !target) throw new AppError(404, "Plan not found");

  await prisma.subscription.update({
    where: { organizationId: input.organizationId },
    data: { pendingPlanId: target.id, pendingPlanChangeAt: outcome.effectiveAt },
  });

  await recordEvent({
    subscriptionId: subscription.id,
    type: SUBSCRIPTION_EVENT.PLAN_CHANGE_SCHEDULED,
    fromPlanId: subscription.planId,
    toPlanId: target.id,
    reason: `Downgrade to ${target.name} at the end of the current period`,
    actorUserId: input.actorUserId ?? null,
    metadata: { effectiveAt: outcome.effectiveAt },
  });

  invalidateEntitlements(input.organizationId);
  return outcome.effectiveAt;
}

/** Withdraws a scheduled downgrade. */
export async function cancelScheduledPlanChange(organizationId: string): Promise<void> {
  const subscription = await prisma.subscription.findUnique({
    where: { organizationId },
    select: { id: true, pendingPlanId: true },
  });
  if (!subscription?.pendingPlanId) return;

  await prisma.subscription.update({
    where: { organizationId },
    data: { pendingPlanId: null, pendingPlanChangeAt: null },
  });

  await recordEvent({
    subscriptionId: subscription.id,
    type: SUBSCRIPTION_EVENT.PLAN_CHANGE_SCHEDULED,
    reason: "Scheduled plan change withdrawn",
  });

  invalidateEntitlements(organizationId);
}

// ============================================================================
// Reconciliation
// ============================================================================

/**
 * Applies a scheduled downgrade, or a cancellation, whose moment has arrived.
 *
 * Called by the sweep. A downgrade moves the subscription onto the new plan without any
 * charge and without deleting anything: a business that drops to a plan with one branch
 * while it has three keeps all three, keeps trading through all three, and simply cannot
 * add a fourth. Taking their records away to make the numbers match would be destroying a
 * business's trading history to satisfy a price list.
 *
 * Safe to call on a business that has nothing pending.
 */
export async function applyDuePlanChanges(now: Date = new Date()): Promise<number> {
  const due = await prisma.subscription.findMany({
    where: {
      OR: [
        { pendingPlanChangeAt: { lte: now } },
        { cancelAtPeriodEnd: true, endsAt: { lte: now } },
      ],
    },
    select: {
      id: true,
      organizationId: true,
      planId: true,
      status: true,
      pendingPlanId: true,
      pendingPlanChangeAt: true,
      cancelAtPeriodEnd: true,
      endsAt: true,
      pendingPlan: { select: { id: true, key: true, name: true, isFree: true } },
    },
  });

  let applied = 0;

  for (const subscription of due) {
    // A cancellation that has come due is finished before a downgrade is considered: a
    // business that cancelled and had also asked to drop plans has, by definition, gone.
    if (subscription.cancelAtPeriodEnd && subscription.endsAt && subscription.endsAt <= now) {
      await prisma.subscription.update({
        where: { id: subscription.id },
        data: {
          status: SUBSCRIPTION_STATUS.CANCELED,
          endsAt: now,
          pendingPlanId: null,
          pendingPlanChangeAt: null,
        },
      });
      await recordEvent({
        subscriptionId: subscription.id,
        type: SUBSCRIPTION_EVENT.CANCELED,
        fromStatus: subscription.status,
        toStatus: SUBSCRIPTION_STATUS.CANCELED,
        reason: "The paid period ended",
      });
      await announceBilling({
        organizationId: subscription.organizationId,
        title: "Your subscription has ended",
        body: "The period you paid for is complete. Nothing has been deleted — your data is exactly where you left it, and upgrading puts paid capabilities straight back on.",
        type: "info",
        dedupeKey: `billing-ended:${subscription.id}`,
      });
      applied += 1;
      continue;
    }

    const target = subscription.pendingPlan;
    if (!target || !subscription.pendingPlanChangeAt || subscription.pendingPlanChangeAt > now) {
      continue;
    }

    await prisma.$transaction(async tx => {
      await tx.subscription.update({
        where: { id: subscription.id },
        data: {
          planId: target.id,
          pendingPlanId: null,
          pendingPlanChangeAt: null,
          planPriceId: null,
          billingInterval: BILLING_INTERVALS.MONTHLY,
          currentPeriodStart: now,
          // A free plan has no period to run out. Leaving the old paid date behind would
          // leave Community looking expired the following morning.
          currentPeriodEnd: target.isFree ? null : now,
          status: SUBSCRIPTION_STATUS.ACTIVE,
          graceEndsAt: null,
          endsAt: null,
          canceledAt: null,
          cancelAtPeriodEnd: false,
        },
      });
      await tx.organization.update({
        where: { id: subscription.organizationId },
        data: { planId: target.id },
      });
    });

    await recordEvent({
      subscriptionId: subscription.id,
      type: SUBSCRIPTION_EVENT.DOWNGRADED,
      fromPlanId: subscription.planId,
      toPlanId: target.id,
      reason: `Moved to ${target.name} at the end of the paid period`,
      metadata: { effectiveAt: now },
    });
    await announceBilling({
      organizationId: subscription.organizationId,
      title: `You are now on ${target.name}`,
      body: `The scheduled plan change has taken effect. Everything you already created is intact — you keep every product, customer and sale, and the new plan's limits apply to what you add from here.`,
      type: "info",
      dedupeKey: `billing-downgraded:${subscription.id}:${target.id}`,
    });
    applied += 1;
  }

  if (applied) invalidateEntitlements();
  return applied;
}

/**
 * Brings the stored status of every subscription into line with the clock.
 *
 * Note what this does and does not do. It writes down transitions that the dates have
 * already made true, so the admin area and the ledger tell the same story as the checks
 * the product runs. It is not what makes the product behave correctly: `resolveStatus`
 * already derives the answer on every read, so a business whose card failed is treated
 * correctly the instant that happens, whether or not this sweep has run.
 *
 * That ordering is deliberate. A sweep that the system depends on is a sweep that is a
 * single point of failure; here it is a report that catches up.
 */
export async function reconcileSubscriptions(now: Date = new Date()): Promise<{
  expired: number;
  pastDue: number;
  planChanges: number;
}> {
  const summary = { expired: 0, pastDue: 0, planChanges: 0 };

  // Downgrades and cancellations whose moment has passed.
  summary.planChanges = await applyDuePlanChanges(now);

  const candidates = await prisma.subscription.findMany({
    where: {
      status: { notIn: [SUBSCRIPTION_STATUS.EXPIRED, SUBSCRIPTION_STATUS.CANCELED] },
      currentPeriodEnd: { not: null },
    },
    select: {
      id: true,
      organizationId: true,
      status: true,
      currentPeriodEnd: true,
      graceEndsAt: true,
      trialEndsAt: true,
      cancelAtPeriodEnd: true,
      providerSubscriptionCode: true,
      plan: { select: { name: true } },
    },
  });

  for (const subscription of candidates) {
    const graceEnded =
      subscription.currentPeriodEnd &&
      subscription.currentPeriodEnd <= now &&
      (!subscription.graceEndsAt || subscription.graceEndsAt <= now);

    if (graceEnded) {
      await prisma.subscription.update({
        where: { id: subscription.id },
        data: { status: SUBSCRIPTION_STATUS.EXPIRED, endsAt: now },
      });
      await recordEvent({
        subscriptionId: subscription.id,
        type: SUBSCRIPTION_EVENT.EXPIRED,
        fromStatus: subscription.status,
        toStatus: SUBSCRIPTION_STATUS.EXPIRED,
        reason: "The paid period and the grace period both ended",
      });
      summary.expired += 1;
      continue;
    }

    const inGrace =
      subscription.currentPeriodEnd &&
      subscription.currentPeriodEnd <= now &&
      subscription.status === SUBSCRIPTION_STATUS.ACTIVE;

    if (inGrace) {
      await prisma.subscription.update({
        where: { id: subscription.id },
        data: { status: SUBSCRIPTION_STATUS.GRACE },
      });
      await recordEvent({
        subscriptionId: subscription.id,
        type: SUBSCRIPTION_EVENT.GRACE_STARTED,
        fromStatus: subscription.status,
        toStatus: SUBSCRIPTION_STATUS.GRACE,
        reason: "The paid period ended without a renewal",
        metadata: { graceEndsAt: subscription.graceEndsAt },
      });
      summary.pastDue += 1;
    }

    // Warnings before the deadline, not news after it. Deduped against an unread alert
    // carrying the same key, so an hourly sweep around a Friday expiry says it once.
    const trialLeft = subscription.trialEndsAt
      ? subscription.trialEndsAt.getTime() - now.getTime()
      : Infinity;
    if (
      subscription.status === SUBSCRIPTION_STATUS.TRIALING &&
      trialLeft > 0 &&
      trialLeft <= 48 * 60 * 60 * 1000
    ) {
      await announceBilling({
        organizationId: subscription.organizationId,
        title: `Your ${subscription.plan.name} trial ends soon`,
        body: `Your trial ends on ${subscription.trialEndsAt!.toDateString()}. Choose a plan to carry on without interruption — everything you have built stays either way.`,
        type: "warning",
        link: "/pricing",
        dedupeKey: `billing-trial-ending:${subscription.id}:${subscription.trialEndsAt!.toISOString()}`,
      });
    }

    const periodLeft = subscription.currentPeriodEnd
      ? subscription.currentPeriodEnd.getTime() - now.getTime()
      : Infinity;
    if (
      subscription.status === SUBSCRIPTION_STATUS.ACTIVE &&
      periodLeft > 0 &&
      periodLeft <= 72 * 60 * 60 * 1000
    ) {
      const until = subscription.currentPeriodEnd!.toDateString();
      await announceBilling({
        organizationId: subscription.organizationId,
        title: subscription.cancelAtPeriodEnd
          ? `Your ${subscription.plan.name} plan ends on ${until}`
          : `Your ${subscription.plan.name} plan is up on ${until}`,
        body: subscription.cancelAtPeriodEnd
          ? `This is the end of the period you paid for. Nothing has been deleted, and you can pick it up again whenever you are ready.`
          : subscription.providerSubscriptionCode
            ? `Automatic renewal will charge the card we have on file and carry on without you doing anything.`
            : `Renew from the billing page to carry on without interruption. Everything you have created stays either way.`,
        type: "warning",
        dedupeKey: `billing-expiring:${subscription.id}:${subscription.currentPeriodEnd!.toISOString()}`,
      });
    }
  }

  // The same meters the billing page draws, checked for everybody once an hour, so
  // "you have used 80% of your allowance" reaches a customer who is not looking at
  // settings — which is exactly the customer who runs out by surprise.
  await announceUsageWarnings(now);

  if (summary.expired || summary.pastDue) invalidateEntitlements();
  return summary;
}

/**
 * Walks every business's limits and warns the ones nearing a ceiling.
 *
 * Failures are swallowed per business: a single entitlement that cannot be resolved
 * (a catalogue mid-edit, a database hiccup) must not stop the sweep for everyone else.
 */
async function announceUsageWarnings(now: Date): Promise<void> {
  try {
    const orgs = await prisma.subscription.findMany({
      select: { organizationId: true },
      distinct: ["organizationId"],
    });

    for (const org of orgs) {
      try {
        const snapshot = await getEntitlements(org.organizationId);
        const readings = await readLimits(snapshot);
        for (const reading of readings) {
          if (!reading.warning || reading.unlimited || reading.limit === null) continue;
          await announceUsageWarning({
            organizationId: org.organizationId,
            label: reading.label,
            used: reading.used,
            limit: reading.limit,
            // Monthly counters speak per calendar month so next month can raise its own
            // alert; "never" counters share one lifetime key.
            periodKey: reading.period === "never" ? "all" : now.toISOString().slice(0, 7),
          });
        }
      } catch (err) {
        console.error(
          `Usage warning sweep failed for ${org.organizationId}:`,
          (err as Error).message
        );
      }
    }
  } catch (err) {
    console.error("Usage warning sweep could not list businesses:", (err as Error).message);
  }
}
