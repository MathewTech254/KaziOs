import { prisma } from "../lib/prisma";
import { AppError } from "../middleware/errorHandler";
import {
  createCustomer,
  createPlan,
  createSubscription,
  disableSubscription,
  fetchPlan,
  fetchSubscription,
  findCustomerByEmail,
  initializeTransaction,
  isPaystackEnabled,
  PaystackError,
  verifyTransaction,
} from "../lib/paystack";
import {
  SUBSCRIPTION_PAYMENT_KIND,
  SUBSCRIPTION_PAYMENT_STATUS,
  SUBSCRIPTION_STATUS,
} from "@kazios/types";
import {
  activateSubscription,
  addInterval,
  ensureSubscription,
  getPlanByKey,
  getPlanPrice,
  newSubscriptionReference,
  recordEvent,
  recordPaymentFailure,
  renewSubscription,
  startTrial,
} from "./subscriptions";
import { invalidateEntitlements } from "./entitlements";

/**
 * Subscription billing, built on the payment code that already works.
 *
 * This deliberately reuses `lib/paystack` and the webhook route that already serves
 * invoice card payments rather than introducing a second gateway client. The existing
 * layer already does the two things that matter and are easy to get wrong: it verifies a
 * webhook signature against the raw bytes the provider sent, and it asks the provider
 * directly rather than believing a returning browser. Both are worth far more than the
 * small duplication of a second wrapper around them.
 *
 * The rule this file exists to enforce: nothing here activates anything on the word of the
 * client. `openCheckout` only opens; `confirmCheckout` asks Paystack what really happened
 * and only then activates.
 */

const APP_URL = (process.env.APP_URL || "http://localhost:3000").replace(/\/+$/, "");

export function subscriptionPaymentsReady(): boolean {
  return isPaystackEnabled();
}

/**
 * Opens checkout for a plan.
 *
 * The amount is looked up from the plan's own price row and never taken from the request,
 * because a price a browser sends is a price the customer chooses, and a subscription
 * system that trusts one charges whatever it is told.
 *
 * Nothing is activated here. A row is written in PENDING and the customer is sent to the
 * provider; if they abandon the popup the business simply stays where it was.
 */
export async function openCheckout(input: {
  organizationId: string;
  planKey: string;
  interval: string;
  email: string;
  idempotencyKey?: string;
  actorUserId?: string | null;
}): Promise<{
  reference: string;
  authorizationUrl: string;
  amountCents: number;
  currency: string;
}> {
  if (!subscriptionPaymentsReady()) {
    throw new AppError(
      503,
      "Subscription payments are not configured on this server",
      "PAYMENTS_NOT_CONFIGURED"
    );
  }

  const plan = await getPlanByKey(input.planKey);
  if (!plan || plan.status !== "ACTIVE" || plan.visibility === "PRIVATE") {
    throw new AppError(404, "That plan is not available", "PLAN_UNAVAILABLE");
  }

  const price = await getPlanPrice(plan.id, input.interval);
  if (!price) {
    throw new AppError(
      400,
      `The ${plan.name} plan is not sold on a ${input.interval} basis. Contact us to discuss it.`,
      "PRICE_NOT_AVAILABLE"
    );
  }
  if (price.amountCents === 0) {
    // A zero amount is a free plan. There is nothing to charge, so a checkout could only
    // be a round trip that fails.
    throw new AppError(400, "That plan is free and does not need a checkout", "PLAN_IS_FREE");
  }

  // The Paystack plan behind this price must exist before the customer is sent to pay:
  // it is what a verified payment will subscribe them to, so failing here (honestly,
  // with the provider's own message) beats discovering the problem after the money moved.
  await ensurePaystackPlan({ planKey: plan.key, planName: plan.name, price });

  const subscriptionId = await ensureSubscription(input.organizationId);

  // Reusing an open checkout for the same intent is what stops a double tap on "Upgrade"
  // from opening two payment windows and charging twice.
  if (input.idempotencyKey) {
    const existing = await prisma.subscriptionPayment.findFirst({
      where: {
        organizationId: input.organizationId,
        idempotencyKey: input.idempotencyKey,
        status: SUBSCRIPTION_PAYMENT_STATUS.PENDING,
      },
      select: { reference: true, authorizationUrl: true, amountCents: true, currency: true },
    });
    if (existing?.authorizationUrl) {
      return {
        reference: existing.reference,
        authorizationUrl: existing.authorizationUrl,
        amountCents: existing.amountCents,
        currency: existing.currency,
      };
    }
  }

  const reference = newSubscriptionReference(plan.key);
  const kind = await currentPaymentKind(input.organizationId, plan.id);

  const payment = await prisma.subscriptionPayment.create({
    data: {
      subscriptionId,
      organizationId: input.organizationId,
      planId: plan.id,
      reference,
      idempotencyKey: input.idempotencyKey ?? null,
      amountCents: price.amountCents,
      currency: price.currency,
      kind,
      billingInterval: input.interval,
      status: SUBSCRIPTION_PAYMENT_STATUS.PENDING,
      provider: "PAYSTACK",
    },
  });

  try {
    const initialized = await initializeTransaction({
      email: input.email,
      amountInCents: price.amountCents,
      currency: price.currency,
      reference,
      callbackUrl: `${APP_URL}/settings?tab=billing`,
      // The reference is the join between the provider's message and our row; the plan is
      // named in the metadata too, so a charge in the Paystack dashboard explains itself
      // without anybody having to look it up.
      metadata: {
        kind: "subscription",
        subscriptionPaymentId: payment.id,
        organizationId: input.organizationId,
        planKey: plan.key,
        interval: input.interval,
      },
    });

    const updated = await prisma.subscriptionPayment.update({
      where: { id: payment.id },
      data: { authorizationUrl: initialized.authorization_url },
      select: { reference: true, authorizationUrl: true, amountCents: true, currency: true },
    });

    return {
      reference: updated.reference,
      authorizationUrl: updated.authorizationUrl!,
      amountCents: updated.amountCents,
      currency: updated.currency,
    };
  } catch (err) {
    // The charge was never taken, so the row is kept as failed rather than deleted: it is
    // the record of the attempt, and removing it would leave a hole in the billing history
    // that later looks like a missing invoice.
    await prisma.subscriptionPayment
      .update({
        where: { id: payment.id },
        data: {
          status: SUBSCRIPTION_PAYMENT_STATUS.FAILED,
          failureReason:
            err instanceof PaystackError
              ? err.message
              : "The payment provider could not be reached",
        },
      })
      .catch(() => undefined);

    if (err instanceof PaystackError) {
      throw new AppError(
        502,
        `Checkout could not be started: ${err.message}`,
        "PAYSTACK_UNAVAILABLE"
      );
    }
    throw err;
  }
}

/** Whether this payment is a first purchase, a renewal, or a change of plan. */
export async function currentPaymentKind(organizationId: string, targetPlanId: string): Promise<string> {
  const subscription = await prisma.subscription.findUnique({
    where: { organizationId },
    select: {
      planId: true,
      status: true,
      trialEndsAt: true,
      plan: { select: { sortOrder: true } },
    },
  });
  if (!subscription) return SUBSCRIPTION_PAYMENT_KIND.INITIAL;

  // A business paying again after a lapse is renewing, whatever it is also changing to,
  // and recording it as an upgrade would put the wrong event in the ledger.
  if (
    subscription.status === SUBSCRIPTION_STATUS.EXPIRED ||
    subscription.status === SUBSCRIPTION_STATUS.CANCELED ||
    subscription.status === SUBSCRIPTION_STATUS.PAST_DUE
  ) {
    return SUBSCRIPTION_PAYMENT_KIND.RENEWAL;
  }
  if (subscription.trialEndsAt && subscription.trialEndsAt > new Date()) {
    return SUBSCRIPTION_PAYMENT_KIND.UPGRADE;
  }

  const target = await prisma.plan.findUnique({
    where: { id: targetPlanId },
    select: { sortOrder: true },
  });
  if (!target) return SUBSCRIPTION_PAYMENT_KIND.INITIAL;
  return target.sortOrder > subscription.plan.sortOrder
    ? SUBSCRIPTION_PAYMENT_KIND.UPGRADE
    : SUBSCRIPTION_PAYMENT_KIND.DOWNGRADE;
}

// ============================================================================
// Recurring billing on the provider's own engine
// ============================================================================

/**
 * Makes sure a price row has its Paystack plan, and returns the plan code.
 *
 * Created on first use rather than up front, so a fresh installation is not asking a
 * payment provider to build four plans before anybody has sold anything, and so an
 * administrator who re-prices a plan is not silently left charging the old number:
 * a code whose amount or currency no longer matches the row is replaced.
 *
 * The write is guarded by the row's own `paystackPlanCode` being null, so two checkouts
 * racing here converge on one code; the loser re-reads the winner's.
 */
export async function ensurePaystackPlan(input: {
  planKey: string;
  planName: string;
  price: {
    id: string;
    interval: string;
    amountCents: number;
    currency: string;
    paystackPlanCode?: string | null;
  };
}): Promise<string | null> {
  const { price } = input;
  if (price.amountCents === 0 || price.interval === "custom") return null;

  if (price.paystackPlanCode) {
    const plan = await fetchPlan(price.paystackPlanCode).catch(() => null);
    const stillMatches =
      plan &&
      plan.amount === price.amountCents &&
      plan.currency?.toUpperCase() === price.currency.toUpperCase();
    if (stillMatches) return price.paystackPlanCode;
    // The code no longer describes this price (a re-priced row, a plan deleted at
    // Paystack). It is cleared so the next step creates one that does.
    await prisma.planPrice
      .update({ where: { id: price.id }, data: { paystackPlanCode: null } })
      .catch(() => undefined);
  }

  try {
    const created = await createPlan({
      name: `KaziOS ${input.planName} (${price.interval})`,
      interval: price.interval,
      amountInCents: price.amountCents,
      currency: price.currency,
    });

    const claimed = await prisma.planPrice.updateMany({
      where: { id: price.id, paystackPlanCode: null },
      data: { paystackPlanCode: created.plan_code },
    });
    if (claimed.count > 0) return created.plan_code;

    // Somebody else stored a code between our create and our write. Theirs is as good
    // as ours; the plan we just made at Paystack is an orphan nobody will subscribe to,
    // which is tidy-up for a dashboard rather than a customer-facing problem.
    const row = await prisma.planPrice.findUnique({
      where: { id: price.id },
      select: { paystackPlanCode: true },
    });
    return row?.paystackPlanCode ?? created.plan_code;
  } catch (err) {
    if (err instanceof PaystackError) {
      throw new AppError(
        502,
        `Checkout could not be started: the payment provider rejected the plan (${err.message})`,
        "PAYSTACK_UNAVAILABLE"
      );
    }
    throw err;
  }
}

/**
 * Subscribes the business to Paystack so renewals are charged automatically.
 *
 * Called only from `confirmCheckout`, i.e. only after the money has been confirmed by
 * asking Paystack directly. Everything in here is best effort by design: the payment is
 * already real and the entitlements already granted, so an outage at Paystack must not
 * roll the customer back to an unpaid state. A failure leaves the existing manual
 * renewal path (checkout kind RENEWAL, grace, reminders) fully intact as the fallback,
 * and the failure itself is written to the ledger rather than swallowed silently.
 */
export async function syncRecurringBilling(input: {
  organizationId: string;
  planId: string;
  planKey: string;
  planName: string;
  interval: string;
  actorUserId?: string | null;
}): Promise<void> {
  try {
    if (!subscriptionPaymentsReady()) return;
    if (input.interval === "custom") return; // Enterprise is quoted, never subscribed.

    const price = await prisma.planPrice.findFirst({
      where: { planId: input.planId, interval: input.interval, isActive: true },
      orderBy: { currency: "asc" },
    });
    if (!price || price.amountCents === 0) return;

    const planCode = await ensurePaystackPlan({
      planKey: input.planKey,
      planName: input.planName,
      price,
    });
    if (!planCode) return;

    const subscription = await prisma.subscription.findUnique({
      where: { organizationId: input.organizationId },
      select: {
        id: true,
        providerCustomerId: true,
        providerSubscriptionCode: true,
        cancelAtPeriodEnd: true,
      },
    });
    if (!subscription) return;

    // The customer of record. The first active user of the business is stable across
    // retries and never points at a visitor who happened to hold a session.
    let customerCode = subscription.providerCustomerId;
    if (!customerCode) {
      const owner = await prisma.user.findFirst({
        where: { organizationId: input.organizationId, status: "ACTIVE" },
        orderBy: { createdAt: "asc" },
        select: { email: true, name: true },
      });
      if (!owner) return;

      const customer =
        (await findCustomerByEmail(owner.email).catch(() => null)) ??
        (await createCustomer({
          email: owner.email,
          firstName: owner.name?.split(" ")[0] || undefined,
        }));

      customerCode = customer.customer_code;
      await prisma.subscription.update({
        where: { organizationId: input.organizationId },
        data: { provider: "PAYSTACK", providerCustomerId: customerCode },
      });
    }

    // Already subscribed to this very plan? Leave the cadence alone: cancelling and
    // re-subscribing on every payment would reset the renewal date each period.
    if (subscription.providerSubscriptionCode) {
      const existing = await fetchSubscription(subscription.providerSubscriptionCode).catch(
        () => null
      );
      if (
        existing &&
        existing.plan?.plan_code === planCode &&
        existing.status === "active" &&
        !subscription.cancelAtPeriodEnd
      ) {
        return;
      }
      if (existing && existing.status === "active" && existing.plan?.plan_code !== planCode) {
        // An upgrade replaces the subscription so the new plan is what renews. The old
        // one is stopped, never left charging alongside the new one.
        await disableSubscription(subscription.providerSubscriptionCode).catch(() => undefined);
      }
    }

    const created = await createSubscription({ customerCode, planCode });
    await prisma.subscription.update({
      where: { organizationId: input.organizationId },
      data: { provider: "PAYSTACK", providerSubscriptionCode: created.subscription_code },
    });

    await recordEvent({
      subscriptionId: subscription.id,
      type: "RECURRING_BILLING_ACTIVE",
      reason: `Renewals will be charged automatically on the ${input.planName} plan`,
      actorUserId: input.actorUserId ?? null,
      metadata: { planCode, subscriptionCode: created.subscription_code },
    });
  } catch (err) {
    console.error("Could not set up recurring billing:", (err as Error).message);
    const sub = await prisma.subscription
      .findUnique({ where: { organizationId: input.organizationId }, select: { id: true } })
      .catch(() => null);
    if (sub) {
      await recordEvent({
        subscriptionId: sub.id,
        type: "RECURRING_BILLING_FAILED",
        reason: `Automatic renewal could not be arranged: ${(err as Error).message}. The plan stays active; renewals fall back to manual payment.`,
      });
    }
  }
}

// ============================================================================
// Confirmation
// ============================================================================

export interface ConfirmResult {
  status: string;
  settled: boolean;
  planKey?: string;
  message: string;
}

/**
 * Settles a subscription payment after asking Paystack what really happened.
 *
 * This is reached from a signed webhook and from a customer who has just come back from
 * the payment popup. Both are answered by the same question to Paystack, because both are
 * merely claims that something might have been paid. The browser's version of events is
 * never used to decide that a plan has changed.
 *
 * The amount Paystack confirms is checked against what was owed. A mismatch raises rather
 * than being recorded: recording it would grant a plan against a charge for some other
 * amount, which is exactly the substitution this system must not permit.
 */
export async function confirmCheckout(reference: string): Promise<ConfirmResult> {
  const record = await prisma.subscriptionPayment.findUnique({
    where: { reference },
    include: { plan: { select: { key: true, name: true, trialDays: true } } },
  });
  if (!record) throw new AppError(404, "Subscription payment not found");

  const alreadySettled = record.status === SUBSCRIPTION_PAYMENT_STATUS.SUCCESS;
  let transaction;

  try {
    transaction = await verifyTransaction(reference);
  } catch {
    // The provider could not be reached. The row stays PENDING and the business keeps
    // whatever it had, which is the safe answer: nobody has been proven to have paid.
    throw new AppError(
      502,
      "The payment provider could not be reached, so this payment has not been confirmed yet. Please try again in a moment.",
      "PAYSTACK_UNAVAILABLE"
    );
  }

  if (transaction.status !== "success") {
    if (transaction.status === "failed" || transaction.status === "abandoned") {
      await prisma.subscriptionPayment
        .update({
          where: { reference },
          data: {
            status: SUBSCRIPTION_PAYMENT_STATUS.FAILED,
            failureReason: `Paystack reported ${transaction.status}`,
          },
        })
        .catch(() => undefined);

      await recordPaymentFailure({
        organizationId: record.organizationId,
        paymentId: record.id,
        reason: `Paystack reported ${transaction.status}`,
        interval: record.billingInterval,
      });
    }
    return {
      status: transaction.status,
      settled: false,
      message:
        "Your payment has not completed. Nothing has been charged and your plan has not changed.",
    };
  }

  if (
    transaction.amount !== record.amountCents ||
    transaction.currency?.toUpperCase() !== record.currency.toUpperCase()
  ) {
    throw new AppError(
      409,
      "The amount Paystack confirmed does not match the plan price. The payment has been left unapplied; please contact support.",
      "AMOUNT_MISMATCH"
    );
  }

  // Already settled once. Doing the work again would push the renewal date out a second
  // period, which is exactly what a replayed webhook must never be able to do.
  if (alreadySettled) {
    return {
      status: "SUCCESS",
      settled: true,
      planKey: record.plan.key,
      message: `This payment was already applied. You are on the ${record.plan.name} plan.`,
    };
  }

  const subscription = await prisma.subscription.findUnique({
    where: { organizationId: record.organizationId },
    select: { id: true, planId: true, trialEndsAt: true, status: true },
  });
  if (!subscription) throw new AppError(404, "No subscription for this payment");

  // A lapsed business paying again is renewing rather than buying something new, so the
  // period continues from where it stopped instead of restarting and losing paid days.
  const isRenewal =
    record.kind === SUBSCRIPTION_PAYMENT_KIND.RENEWAL ||
    subscription.status === SUBSCRIPTION_STATUS.CANCELED ||
    subscription.status === SUBSCRIPTION_STATUS.PAST_DUE;

  if (isRenewal) {
    await renewSubscription({
      organizationId: record.organizationId,
      paymentId: record.id,
      interval: record.billingInterval,
      providerRef: String(transaction.transaction_id),
    });
  } else {
    await activateSubscription({
      organizationId: record.organizationId,
      planKey: record.plan.key,
      interval: record.billingInterval,
      paymentId: record.id,
      provider: "PAYSTACK",
      providerRef: String(transaction.transaction_id),
      paymentMethodBrand: cardBrand(transaction),
      paymentMethodLast4: cardLast4(transaction),
    });
  }

  // A trial only starts on a first purchase, and never when one is already running.
  // Starting one on an upgrade would hand a business a second fortnight for nothing.
  if (
    record.plan.trialDays > 0 &&
    record.kind === SUBSCRIPTION_PAYMENT_KIND.INITIAL &&
    !subscription.trialEndsAt
  ) {
    await startTrial({
      organizationId: record.organizationId,
      planId: record.planId,
      planKey: record.plan.key,
      trialDays: record.plan.trialDays,
    });
  }

  // With the money confirmed and the period set, arrange the automatic renewal that
  // replaces the manual "pay again next month" dance. It runs only now, never before,
  // and it can never un-settle the payment above: a failure here leaves the manual
  // renewal path as the fallback and writes the reason to the ledger.
  await syncRecurringBilling({
    organizationId: record.organizationId,
    planId: record.planId,
    planKey: record.plan.key,
    planName: record.plan.name,
    interval: record.billingInterval,
  });

  invalidateEntitlements(record.organizationId);

  return {
    status: "SUCCESS",
    settled: true,
    planKey: record.plan.key,
    message: isRenewal
      ? `Payment received. Your ${record.plan.name} plan has been renewed.`
      : `Payment received. You are now on the ${record.plan.name} plan.`,
  };
}

/** The card brand Paystack reported, for display as "Visa ending 4242". */
function cardBrand(transaction: any): string | null {
  const auth = transaction?.authorization;
  return typeof auth?.card_type === "string" ? auth.card_type : null;
}

function cardLast4(transaction: any): string | null {
  const auth = transaction?.authorization;
  return typeof auth?.last4 === "string" ? auth.last4 : null;
}

/**
 * Handles a webhook that names a subscription payment.
 *
 * Called only after the signature on the request has been verified against the raw body,
 * and still does not trust the payload: it confirms through Paystack exactly as the
 * browser path does, so a forged event that somehow got past the signature check cannot
 * grant a plan on its own.
 */
export async function handleSubscriptionWebhook(reference: string): Promise<ConfirmResult> {
  return confirmCheckout(reference);
}

// ============================================================================
// Recurring renewals arriving from the provider
// ============================================================================

/**
 * Applies a renewal charge that Paystack generated for a subscription we run.
 *
 * These charges have a reference we have never seen, because no checkout was opened:
 * the provider simply charged the card token at the end of the period. The reference is
 * still verified against Paystack before anything moves, the row is created under the
 * same unique reference constraint as every other payment (so a webhook and a retry that
 * race each other settle exactly once), and the period continues from where it stopped
 * rather than restarting.
 */
export async function applyRenewalCharge(input: {
  organizationId: string;
  reference: string;
}): Promise<ConfirmResult> {
  const already = await prisma.subscriptionPayment.findUnique({
    where: { reference: input.reference },
    include: { plan: { select: { key: true, name: true } } },
  });
  if (already) {
    // A second delivery of the same charge: answer from what is already true rather
    // than applying the period a second time.
    if (already.status === SUBSCRIPTION_PAYMENT_STATUS.SUCCESS) {
      return {
        status: "SUCCESS",
        settled: true,
        planKey: already.plan.key,
        message: `This payment was already applied. You are on the ${already.plan.name} plan.`,
      };
    }
    return confirmCheckout(input.reference);
  }

  const subscription = await prisma.subscription.findUnique({
    where: { organizationId: input.organizationId },
    include: {
      plan: { select: { id: true, key: true, name: true, isFree: true } },
      planPrice: { select: { amountCents: true, currency: true } },
    },
  });
  if (!subscription || subscription.plan.isFree) {
    throw new AppError(404, "Payment reference not found");
  }

  let transaction;
  try {
    transaction = await verifyTransaction(input.reference);
  } catch {
    throw new AppError(
      502,
      "The payment provider could not be reached, so this payment has not been confirmed yet.",
      "PAYSTACK_UNAVAILABLE"
    );
  }

  if (transaction.status !== "success") {
    // A renewal that did not complete. Nothing is recorded as paid, and the normal
    // failure path (PAST_DUE, grace, a warning to the business) is what runs.
    await recordPaymentFailure({
      organizationId: input.organizationId,
      reason: `Paystack reported ${transaction.status} for the automatic renewal`,
      interval: subscription.billingInterval,
    });
    return {
      status: transaction.status,
      settled: false,
      message:
        "The automatic renewal did not complete. Your plan has not changed yet; please update your payment method.",
    };
  }

  // The amount the subscription is owed is the price row it is billed at, never the
  // amount the payload claims. A mismatch is refused rather than recorded, exactly as
  // in the checkout path.
  const expected = subscription.planPrice;
  if (
    expected &&
    (transaction.amount !== expected.amountCents ||
      transaction.currency?.toUpperCase() !== expected.currency.toUpperCase())
  ) {
    throw new AppError(
      409,
      "The amount Paystack confirmed does not match the plan price. The payment has been left unapplied; please contact support.",
      "AMOUNT_MISMATCH"
    );
  }

  let payment;
  try {
    payment = await prisma.subscriptionPayment.create({
      data: {
        subscriptionId: subscription.id,
        organizationId: input.organizationId,
        planId: subscription.planId,
        reference: input.reference,
        amountCents: transaction.amount,
        currency: (transaction.currency || subscription.planPrice?.currency || "KES").toUpperCase(),
        kind: SUBSCRIPTION_PAYMENT_KIND.RENEWAL,
        status: SUBSCRIPTION_PAYMENT_STATUS.PENDING,
        billingInterval: subscription.billingInterval,
        provider: "PAYSTACK",
      },
    });
  } catch {
    // A concurrent delivery of the same charge won the race on the unique reference.
    // Whoever won is applying it; this one is done.
    const winner = await prisma.subscriptionPayment.findUnique({
      where: { reference: input.reference },
      select: { status: true, plan: { select: { key: true, name: true } } },
    });
    if (winner?.status === SUBSCRIPTION_PAYMENT_STATUS.SUCCESS) {
      return {
        status: "SUCCESS",
        settled: true,
        planKey: winner.plan.key,
        message: `This payment was already applied. You are on the ${winner.plan.name} plan.`,
      };
    }
    throw new AppError(409, "This renewal is already being processed", "DUPLICATE_RENEWAL");
  }

  await renewSubscription({
    organizationId: input.organizationId,
    paymentId: payment.id,
    interval: subscription.billingInterval,
    providerRef: String(transaction.transaction_id),
  });

  invalidateEntitlements(input.organizationId);

  return {
    status: "SUCCESS",
    settled: true,
    planKey: subscription.plan.key,
    message: `Payment received. Your ${subscription.plan.name} plan has been renewed.`,
  };
}

/**
 * Keeps KaziOS's subscription state in step with events that happened at Paystack
 * itself: a renewal invoice that failed, a subscription disabled from the dashboard, a
 * customer who turned renewal off.
 *
 * Reached only from the signed webhook path. The codes in the payload are matched
 * against the codes we stored when the subscription was created, so an event that names
 * nothing we own changes nothing.
 */
export async function handlePaystackLifecycleEvent(input: {
  event: string;
  data: Record<string, any>;
}): Promise<{ handled: boolean; detail: string }> {
  const data = input.data ?? {};
  const providerCode =
    (typeof data.subscription_code === "string" && data.subscription_code) ||
    (typeof data.subscription?.subscription_code === "string" &&
      data.subscription.subscription_code) ||
    null;
  const customerCode =
    typeof data.customer?.customer_code === "string" ? data.customer.customer_code : null;

  let subscription = null as Awaited<ReturnType<typeof prisma.subscription.findFirst>>;
  if (providerCode) {
    subscription = await prisma.subscription.findFirst({
      where: { providerSubscriptionCode: providerCode },
      include: { plan: { select: { key: true, name: true } } },
    });
  }
  if (!subscription && customerCode) {
    subscription = await prisma.subscription.findFirst({
      where: { providerCustomerId: customerCode },
      include: { plan: { select: { key: true, name: true } } },
    });
  }
  if (!subscription) return { handled: false, detail: "No subscription matches this event" };

  switch (input.event) {
    case "subscription.create": {
      // Usually written by us already; this closes the window where we created the
      // provider subscription and died before storing its code.
      if (providerCode && subscription.providerSubscriptionCode !== providerCode) {
        await prisma.subscription.update({
          where: { id: subscription.id },
          data: { provider: "PAYSTACK", providerSubscriptionCode: providerCode },
        });
      }
      await recordEvent({
        subscriptionId: subscription.id,
        type: "PROVIDER_SUBSCRIPTION_CREATED",
        reason: "Paystack confirmed the recurring subscription",
        metadata: { providerCode },
      });
      return { handled: true, detail: "Subscription linked" };
    }

    case "subscription.enable": {
      await prisma.subscription.updateMany({
        where: { id: subscription.id, canceledAt: { not: null } },
        data: { cancelAtPeriodEnd: false, canceledAt: null, endsAt: null },
      });
      await recordEvent({
        subscriptionId: subscription.id,
        type: "PROVIDER_SUBSCRIPTION_ENABLED",
        reason: "Automatic renewal was turned back on at Paystack",
      });
      invalidateEntitlements(subscription.organizationId);
      return { handled: true, detail: "Renewal re-enabled" };
    }

    case "subscription.not_renew": {
      await prisma.subscription.updateMany({
        where: { id: subscription.id, cancelAtPeriodEnd: false },
        data: { cancelAtPeriodEnd: true, canceledAt: new Date() },
      });
      await recordEvent({
        subscriptionId: subscription.id,
        type: "PROVIDER_SUBSCRIPTION_NOT_RENEWING",
        reason:
          "Automatic renewal was switched off at Paystack. Access continues to the end of the paid period.",
        metadata: { providerCode },
      });
      invalidateEntitlements(subscription.organizationId);
      return { handled: true, detail: "Scheduled to stop renewing" };
    }

    case "subscription.disable": {
      // Stopped at Paystack: a cancellation, a failed recovery, or a disable from the
      // dashboard. Our side records the same decision the cancel route would make:
      // no further charges, access until the period already paid for runs out.
      const now = new Date();
      const effectiveAt =
        subscription.currentPeriodEnd && subscription.currentPeriodEnd > now
          ? subscription.currentPeriodEnd
          : now;
      await prisma.subscription.update({
        where: { id: subscription.id },
        data: {
          cancelAtPeriodEnd: true,
          canceledAt: subscription.canceledAt ?? now,
          endsAt: subscription.endsAt ?? effectiveAt,
          status:
            subscription.status === SUBSCRIPTION_STATUS.CANCELED || now < effectiveAt
              ? subscription.status
              : SUBSCRIPTION_STATUS.CANCELED,
        },
      });
      await recordEvent({
        subscriptionId: subscription.id,
        type: "PROVIDER_SUBSCRIPTION_DISABLED",
        fromStatus: subscription.status,
        reason:
          "The Paystack subscription was disabled. No further charges will be made; your data is untouched.",
        metadata: { providerCode },
      });
      invalidateEntitlements(subscription.organizationId);
      return { handled: true, detail: "Subscription disabled" };
    }

    case "invoice.payment_failed": {
      const amount = typeof data.amount === "number" ? data.amount : null;
      await recordPaymentFailure({
        organizationId: subscription.organizationId,
        reason: `The automatic renewal payment failed${amount ? ` (charged ${amount})` : ""}`,
        interval: subscription.billingInterval,
      });
      return { handled: true, detail: "Renewal marked as failed" };
    }

    default:
      return { handled: false, detail: `No action for ${input.event}` };
  }
}

/** When a period bought at this interval, opened on this date, would end. */
export { addInterval };
