import { prisma } from "../lib/prisma";
import { AppError } from "../middleware/errorHandler";
import {
  describeStkFailure,
  isMpesaEnabled,
  MpesaError,
  normalizeMsisdn,
  stkPush,
  stkQuery,
} from "../lib/mpesa";
import {
  SUBSCRIPTION_PAYMENT_KIND,
  SUBSCRIPTION_PAYMENT_STATUS,
  SUBSCRIPTION_STATUS,
} from "@kazios/types";
import {
  activateSubscription,
  ensureSubscription,
  getPlanByKey,
  newSubscriptionReference,
  recordPaymentFailure,
  renewSubscription,
  startTrial,
} from "./subscriptions";
import { currentPaymentKind } from "./billing";
import { invalidateEntitlements } from "./entitlements";

/**
 * Subscription billing over M-PESA (Safaricom Daraja STK Push), the second rail.
 *
 * This sits beside `services/billing.ts` rather than inside it, deliberately:
 * Paystack's checkout path (`openCheckout`, `confirmCheckout`, `lib/paystack`,
 * the signed webhook) is not edited for this feature, so a change for M-PESA
 * cannot break card payments and a card payment can never settle an M-PESA row.
 * Every row opened here carries `provider: "MPESA"` and only this file settles
 * it, so references cannot cross rails.
 *
 * The two rules from `docs/SUBSCRIPTIONS.md`, restated in M-PESA's terms:
 *
 *   `openMpesaCheckout` only opens: it writes a PENDING row and sends the
 *   prompt to the customer's phone. `confirmMpesaCheckout` asks Safaricom what
 *   really happened (`stkQuery`, keyed on the CheckoutRequestID we stored) and
 *   only then activates. Daraja callbacks carry no signature (there is no HMAC
 *   equivalent), so the query *is* the verification — a callback or a returning
 *   browser may only ever trigger it, never substitute for it.
 *
 * M-PESA has no card token, so `syncRecurringBilling` is never called from
 * here: renewals fall back to the manual path (grace, reminders, another
 * checkout), which is the fallback the Paystack path keeps for itself too.
 *
 * Amounts: M-PESA has no subunit, so a charge is whole shillings worked out
 * from the plan's own KES price row (`amountCents / 100`) and never from
 * anything the browser said.
 */

const API_URL = (process.env.API_URL || "http://localhost:4000").replace(/\/+$/, "");

/**
 * Spacing between two questions about the same checkout.
 *
 * The browser's poll, Safaricom's callback and a returning customer all ask
 * about one checkout at the same moment, and Daraja's sandbox answers a burst
 * with HTTP 429 — a response that contains no verdict at all. A question
 * asked a few seconds too early is therefore a question wasted; this window
 * makes the early ones cost nothing. It can only ever delay a verdict, never
 * produce one: everything skipped is answered exactly like an unasked
 * question — PENDING.
 */
const QUERY_SPACING_MS = 4_000;
const lastQueryAt = new Map<string, number>();

/**
 * Clears the spacing window. Only tests need this: they run back-to-back in
 * milliseconds, where a wall-clock window would leak from one case into the
 * next, while real sessions are minutes apart.
 */
export function resetMpesaQueryThrottle(): void {
  lastQueryAt.clear();
}

/**
 * Where Safaricom posts the STK result.
 *
 * Daraja refuses anything that is not HTTPS, so `MPESA_CALLBACK_URL` is the
 * escape hatch for development (an ngrok or cloudflared tunnel, say). Nothing
 * is lost without a reachable callback: the callback can only ever trigger a
 * query, and `confirmMpesaCheckout` runs that same query whether the callback
 * arrived or not.
 */
function mpesaCallbackUrl(): string {
  const explicit = process.env.MPESA_CALLBACK_URL?.trim();
  return explicit ? explicit : `${API_URL}/api/v1/webhooks/mpesa`;
}

/**
 * MpesaError already carries the truth about what went wrong; this only gives
 * it a stable machine code and a status an Express error handler accepts.
 */
function mpesaAppError(err: unknown, context: string): AppError {
  if (err instanceof AppError) return err;
  if (err instanceof MpesaError) {
    const status = err.status === 400 ? 400 : err.status === 503 ? 503 : 502;
    const code =
      status === 400
        ? "MPESA_REJECTED"
        : status === 503
          ? "MPESA_NOT_CONFIGURED"
          : "MPESA_UNAVAILABLE";
    return new AppError(
      status,
      status === 400 ? err.message : `${context}: ${err.message}`,
      code
    );
  }
  return new AppError(502, `${context}: M-PESA could not be reached`, "MPESA_UNAVAILABLE");
}

export interface MpesaCheckoutOpenResult {
  reference: string;
  checkoutRequestId: string;
  amountShillings: number;
  currency: string;
  phone: string;
  customerMessage: string;
}

/**
 * Opens an M-PESA checkout: the plan's own KES price, a PENDING row, and the
 * STK prompt sent to the customer's phone.
 *
 * The mirror of `openCheckout`, with the same rules in different clothes. The
 * price comes from the plan's KES price row and is never taken from the
 * request; nothing is activated here; a failure keeps the row as FAILED rather
 * than deleting it, because the attempt itself is worth knowing about later.
 *
 * The prompt is addressed by `CheckoutRequestID`, which Safaricom hands back
 * from the push and which is stored on the row before anything else can
 * happen. Everything later — the callback, a returning browser, a support
 * question — joins on that one value.
 */
export async function openMpesaCheckout(input: {
  organizationId: string;
  planKey: string;
  interval: string;
  phone: string;
  idempotencyKey?: string;
  actorUserId?: string | null;
}): Promise<MpesaCheckoutOpenResult> {
  if (!isMpesaEnabled()) {
    throw new AppError(
      503,
      "M-PESA payments are not configured on this server",
      "MPESA_NOT_CONFIGURED"
    );
  }

  const phone = normalizeMsisdn(input.phone);
  if (!phone) {
    throw new AppError(
      400,
      "Enter a valid Kenyan phone number (e.g. 0712345678)",
      "MPESA_PHONE_INVALID"
    );
  }

  // Daraja refuses the whole push when CallBackURL is not HTTPS, so this is
  // checked before any row is written. Failing here with an actionable
  // sentence beats Daraja's own opaque 400 minutes later; locally it means
  // an ngrok tunnel (see docs/MPESA.md).
  const callbackUrl = mpesaCallbackUrl();
  if (!callbackUrl.startsWith("https://")) {
    throw new AppError(
      400,
      "Safaricom only accepts HTTPS callback URLs. Set MPESA_CALLBACK_URL to your public HTTPS endpoint (docs/MPESA.md explains, an ngrok tunnel works locally).",
      "MPESA_CALLBACK_UNSAFE"
    );
  }

  const plan = await getPlanByKey(input.planKey);
  if (!plan || plan.status !== "ACTIVE" || plan.visibility === "PRIVATE") {
    throw new AppError(404, "That plan is not available", "PLAN_UNAVAILABLE");
  }

  // The price row, in shillings, straight from the catalogue. M-PESA can only
  // charge what is denominated in KES; a plan priced any other way is refused
  // by name rather than converted, because inventing an exchange rate here is
  // charging a number no price row ever stated.
  const price = await prisma.planPrice.findFirst({
    where: { planId: plan.id, interval: input.interval, isActive: true, currency: "KES" },
  });
  if (!price) {
    throw new AppError(
      400,
      `The ${plan.name} plan is not priced in Kenyan shillings, so it cannot be paid by M-PESA. Contact us to arrange payment.`,
      "MPESA_PRICE_UNAVAILABLE"
    );
  }
  if (price.amountCents === 0) {
    throw new AppError(400, "That plan is free and does not need a checkout", "PLAN_IS_FREE");
  }

  const amountShillings = price.amountCents / 100;
  if (!Number.isInteger(amountShillings) || amountShillings < 1) {
    // Not a bug to round: charging a different number than the price row
    // states is the substitution this system must never permit.
    throw new AppError(
      400,
      "M-PESA can only charge whole shillings, and this plan's price is not a whole-shilling amount. Contact us to arrange payment.",
      "MPESA_WHOLE_SHILLINGS"
    );
  }

  const subscriptionId = await ensureSubscription(input.organizationId);

  // Reusing an open checkout for the same intent is what stops a double tap on
  // "Upgrade" from sending two prompts and charging twice, exactly as the
  // Paystack path does. The key is scoped to M-PESA rows so a card checkout
  // opened for the same plan and day can never be returned here, nor this one
  // returned there.
  let reference = "";
  let paymentId = "";
  if (input.idempotencyKey) {
    const existing = await prisma.subscriptionPayment.findFirst({
      where: {
        organizationId: input.organizationId,
        idempotencyKey: input.idempotencyKey,
        status: SUBSCRIPTION_PAYMENT_STATUS.PENDING,
        provider: "MPESA",
      },
      select: { id: true, reference: true, providerRef: true, amountCents: true, currency: true },
    });
    if (existing?.providerRef) {
      return {
        reference: existing.reference,
        checkoutRequestId: existing.providerRef,
        amountShillings: existing.amountCents / 100,
        currency: existing.currency,
        phone,
        customerMessage: "Check your phone for the M-PESA prompt",
      };
    }
    // A row left PENDING without an id (a process died between the push and the
    // write): that row is this attempt, so it is reused rather than duplicated.
    if (existing) {
      reference = existing.reference;
      paymentId = existing.id;
    }
  }

  if (!paymentId) {
    reference = newSubscriptionReference(plan.key);
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
        provider: "MPESA",
      },
    });
    paymentId = payment.id;
  }

  try {
    const push = await stkPush({
      phone,
      amountShillings,
      reference,
      callbackUrl,
    });

    await prisma.subscriptionPayment.update({
      where: { id: paymentId },
      data: { providerRef: push.checkoutRequestId },
    });

    return {
      reference,
      checkoutRequestId: push.checkoutRequestId,
      amountShillings,
      currency: price.currency,
      phone,
      customerMessage: push.customerMessage,
    };
  } catch (err) {
    // The prompt was never accepted, so nothing was charged. The row is kept
    // as failed rather than deleted: it is the record of the attempt, and
    // removing it would leave a hole in the billing history.
    await prisma.subscriptionPayment
      .update({
        where: { id: paymentId },
        data: {
          status: SUBSCRIPTION_PAYMENT_STATUS.FAILED,
          failureReason: err instanceof Error ? err.message : "The M-PESA prompt could not be sent",
        },
      })
      .catch(() => undefined);

    throw mpesaAppError(err, "Checkout could not be started");
  }
}

export interface MpesaConfirmResult {
  status: string;
  settled: boolean;
  planKey?: string;
  /**
   * Set when no verdict was obtained because Safaricom could not be asked —
   * busy, rate-limited, unreachable, or asked moments ago. The callback
   * answers with a retryable status for these so Safaricom delivers again,
   * and the browser simply asks again; a plain PENDING means Safaricom was
   * asked and has not decided.
   */
  retryable?: boolean;
  message: string;
}

/**
 * Settles a subscription payment after asking Safaricom what really happened.
 *
 * The mirror of `confirmCheckout`, reached from the unsigned Daraja callback
 * (which may only trigger it) and from the customer who has just approved the
 * prompt on their phone. Both are answered by the same question to Safaricom —
 * `stkQuery`, keyed on the CheckoutRequestID stored at push time — because
 * both are merely claims that something might have been paid. Neither the
 * callback's own ResultCode nor the browser's word is ever used to decide
 * that a plan has changed.
 *
 * Once a payment is settled, `providerRef` holds the M-PESA receipt (the
 * permanent record of the charge) and there is nothing left to ask: a replay
 * finds the row already settled and answers from it, without another call and
 * without ever demoting a payment that was confirmed.
 */
export async function confirmMpesaCheckout(reference: string): Promise<MpesaConfirmResult> {
  const record = await prisma.subscriptionPayment.findUnique({
    where: { reference },
    include: { plan: { select: { key: true, name: true, trialDays: true } } },
  });
  if (!record) throw new AppError(404, "Subscription payment not found");
  if (record.provider !== "MPESA") {
    // A card checkout reference pressed against this route, or the reverse.
    // The two rails never settle each other's rows.
    throw new AppError(
      409,
      "This payment belongs to the other payment method. Confirm it the way it was opened.",
      "WRONG_PAYMENT_RAIL"
    );
  }

  const alreadySettled = record.status === SUBSCRIPTION_PAYMENT_STATUS.SUCCESS;
  const checkoutRequestId = record.providerRef;

  if (alreadySettled) {
    return {
      status: "SUCCESS",
      settled: true,
      planKey: record.plan.key,
      message: `This payment was already applied. You are on the ${record.plan.name} plan.`,
    };
  }

  if (!checkoutRequestId) {
    // The push never reached Safaricom (the row was marked FAILED at open
    // time), so there is nothing to ask about and nothing has been charged.
    return {
      status: record.status,
      settled: false,
      message:
        "This M-PESA payment was never sent to your phone, so nothing has been charged. Start the checkout again.",
    };
  }

  // The poll, the callback and a returning customer arrive together; only one
  // of them earns a trip to Daraja per spacing window. The others are answered
  // from the window — PENDING, because nothing has been learned either way.
  const lastAsk = lastQueryAt.get(checkoutRequestId);
  if (lastAsk !== undefined && Date.now() - lastAsk < QUERY_SPACING_MS) {
    return {
      status: "PENDING",
      settled: false,
      retryable: true,
      message:
        "M-PESA is still being asked about this payment. Nothing has been charged; the check continues in a moment.",
    };
  }

  let result;
  try {
    lastQueryAt.set(checkoutRequestId, Date.now());
    result = await stkQuery(checkoutRequestId);
  } catch (err) {
    // A missing configuration is a real fact about this server and stays an
    // error the customer can act on. Everything else — rate-limited, busy,
    // unreachable — means no verdict exists: the row stays PENDING and the
    // business keeps whatever it had. The answer says so plainly instead of
    // being dressed up as a rejection, which it is not.
    if (err instanceof MpesaError && err.status === 503) {
      throw mpesaAppError(err, "The payment has not been confirmed yet");
    }
    return {
      status: "PENDING",
      settled: false,
      retryable: true,
      message:
        "M-PESA has not answered yet (Safaricom is busy or unreachable). Nothing has been charged; we will ask again in a moment.",
    };
  }

  if (result.state === "PENDING") {
    return {
      status: "PENDING",
      settled: false,
      message:
        "M-PESA has not decided this payment yet. Enter the PIN on your phone if the prompt is still showing, then check again in a moment.",
    };
  }

  // A verdict, whichever way it went, ends the spacing: the next confirm has
  // nothing left to ask about except the row's own state.
  lastQueryAt.delete(checkoutRequestId);

  if (result.state === "FAILED") {
    const reason = describeStkFailure(result.resultCode, result.resultDesc);
    await prisma.subscriptionPayment
      .update({
        where: { reference },
        data: { status: SUBSCRIPTION_PAYMENT_STATUS.FAILED, failureReason: reason },
      })
      .catch(() => undefined);

    await recordPaymentFailure({
      organizationId: record.organizationId,
      paymentId: record.id,
      reason,
      interval: record.billingInterval,
    });

    return { status: "FAILED", settled: false, message: reason };
  }

  // Safaricom says the push succeeded. The amount it reports is checked when
  // it reports one: a mismatch is refused rather than recorded, because
  // recording it would grant a plan against a charge for some other amount.
  // When the query carries no metadata (Daraja's query response often does
  // not), the CheckoutRequestID is itself the binding: it names the one push
  // we opened with this exact price, so success on that key is success for
  // this amount.
  if (
    record.currency !== "KES" ||
    (result.amountShillings != null && result.amountShillings * 100 !== record.amountCents)
  ) {
    throw new AppError(
      409,
      "The amount M-PESA confirmed does not match the plan price. The payment has been left unapplied; please contact support.",
      "AMOUNT_MISMATCH"
    );
  }

  const subscription = await prisma.subscription.findUnique({
    where: { organizationId: record.organizationId },
    select: { id: true, planId: true, trialEndsAt: true, status: true },
  });
  if (!subscription) throw new AppError(404, "No subscription for this payment");

  // A lapsed business paying again is renewing rather than buying something
  // new, so the period continues from where it stopped instead of restarting
  // and losing paid days — the same rule the card path applies.
  const isRenewal =
    record.kind === SUBSCRIPTION_PAYMENT_KIND.RENEWAL ||
    subscription.status === SUBSCRIPTION_STATUS.CANCELED ||
    subscription.status === SUBSCRIPTION_STATUS.PAST_DUE;

  // The receipt is the permanent record of the charge, so it is what the row
  // ends up holding; without metadata from the query, the CheckoutRequestID —
  // the key everything joined on until now — remains the reference.
  const providerRef = result.receipt ?? checkoutRequestId;

  if (isRenewal) {
    await renewSubscription({
      organizationId: record.organizationId,
      paymentId: record.id,
      interval: record.billingInterval,
      providerRef,
    });
  } else {
    await activateSubscription({
      organizationId: record.organizationId,
      planKey: record.plan.key,
      interval: record.billingInterval,
      paymentId: record.id,
      provider: "MPESA",
      providerRef,
      // Shown beside "M-PESA" in the billing screen. The full number is never
      // stored: this system only ever keeps a brand and enough digits to
      // recognise the method, exactly as it does for a card.
      paymentMethodBrand: "M-PESA",
      paymentMethodLast4: null,
    });
  }

  // A trial only starts on a first purchase, and never when one is already
  // running — the same sentence the card path lives by.
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

  // Deliberately no `syncRecurringBilling` here: M-PESA has no card token to
  // charge again, so renewal falls back to the manual path (grace, reminders,
  // another checkout) that the Paystack path keeps as its own fallback.
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

