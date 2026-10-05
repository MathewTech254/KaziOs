import { Router, type Request, type Response } from "express";
import { createHash } from "crypto";
import { prisma } from "../lib/prisma";
import type { AuthRequest } from "../middleware/auth";
import { requireAuth, requirePermission } from "../middleware/auth";
import { AppError } from "../middleware/errorHandler";
import { isValidWebhookSignature } from "../lib/paystack";
import { confirmCardPayment, paystackIsReady, startCardPayment } from "../lib/cardPayments";
import {
  applyRenewalCharge,
  handlePaystackLifecycleEvent,
  handleSubscriptionWebhook,
} from "../services/billing";
import { recordPaymentFailure } from "../services/subscriptions";

export const cardPaymentRouter = Router();

/** A card payment is offered only when a secret key is actually configured. */
cardPaymentRouter.get(
  "/methods",
  requireAuth,
  requirePermission("invoices.view"),
  (_req: AuthRequest, res) => {
    res.json({ data: { cardEnabled: paystackIsReady() } });
  }
);

/**
 * Starts a card payment for an existing invoice. The cashier picks the invoice and the
 * customer's email; the amount always comes from the stored invoice.
 */
cardPaymentRouter.post(
  "/initialize",
  requireAuth,
  requirePermission("invoices.create"),
  async (req: AuthRequest, res, next) => {
    try {
      if (!paystackIsReady()) {
        throw new AppError(
          503,
          "Card payments are not configured on this terminal",
          "CARD_NOT_CONFIGURED"
        );
      }
      const invoiceId = String(req.body?.invoiceId ?? "");
      const email = String(req.body?.email ?? "")
        .trim()
        .toLowerCase();
      if (!invoiceId) throw new AppError(400, "An invoice is required");
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        throw new AppError(400, "A valid email is required so the customer can receive a receipt");
      }

      const result = await startCardPayment({
        invoiceId,
        organizationId: req.organizationId!,
        email,
      });
      res.json({ data: result });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * The customer returned from the payment popup. The browser only says "I am back"; the
 * server asks Paystack what actually happened, so a cashier cannot mark a card paid by
 * clicking a button.
 */
cardPaymentRouter.post(
  "/confirm",
  requireAuth,
  requirePermission("invoices.create"),
  async (req: AuthRequest, res, next) => {
    try {
      const reference = String(req.body?.reference ?? "");
      if (!reference) throw new AppError(400, "A payment reference is required");

      // The reference has to belong to this organization before anything else happens.
      const record = await prisma.cardPayment.findFirst({
        where: { reference, organizationId: req.organizationId! },
        select: { id: true },
      });
      if (!record) throw new AppError(404, "Payment not found");

      const result = await confirmCardPayment(reference);

      const payment = await prisma.cardPayment.findUnique({
        where: { reference },
        select: { invoiceId: true, status: true },
      });

      const full = payment
        ? await prisma.invoice.findUnique({
            where: { id: payment.invoiceId },
            select: {
              invoiceNumber: true,
              status: true,
              paidAmount: true,
              total: true,
              currency: true,
            },
          })
        : null;

      res.json({
        data: {
          ...result,
          invoice: full,
          message:
            result.status === "SUCCESS"
              ? `Payment received. ${full?.invoiceNumber ?? "The invoice"} is marked paid.`
              : "The payment has not completed yet. Ask the customer to try again, or take payment another way.",
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * Paystack's own notification that something happened to a payment or subscription.
 * It carries no session, so it is deliberately unauthenticated and is instead trusted
 * only because the signature matches the secret key. An unsigned or altered request is
 * refused and nothing is written.
 *
 * Three rules hold on this endpoint:
 *
 *  1. Every signed delivery is recorded first, under Paystack's own event id. A replay
 *     is acknowledged without being applied a second time; a delivery whose handler
 *     died mid-way is retried on the next attempt.
 *  2. A signature only proves the message came from Paystack. The money is still
 *     confirmed by asking Paystack directly before anything is granted.
 *  3. Events that change a subscription (a failed renewal invoice, a disable from the
 *     dashboard) are matched against the provider codes we stored, so an event naming
 *     nothing we own changes nothing.
 */
export const paystackWebhookRouter = Router();

paystackWebhookRouter.post("/paystack", async (req: Request, res: Response) => {
  const rawBody: Buffer | undefined = (req as any).rawBody;
  const signature = req.header("x-paystack-signature");
  const rawText = rawBody ? rawBody.toString("utf8") : JSON.stringify(req.body ?? {});

  if (!isValidWebhookSignature(rawText, signature)) {
    // Answered plainly so a misconfiguration is obvious in the dashboard, without saying
    // what is wrong to a caller probing the endpoint.
    return res.status(401).json({ message: "Invalid webhook signature" });
  }

  const event = req.body ?? {};
  const data = event?.data ?? {};
  const eventName = String(event.event ?? "");

  // A stable identity for this delivery. Paystack numbers its events; a payload without
  // one is fingerprinted from the exact bytes, so a byte-identical redelivery still
  // collides. This row is what makes every later step idempotent.
  const providerEventId =
    event.id != null && String(event.id).length > 0
      ? String(event.id)
      : `sha256:${createHash("sha256").update(rawText).digest("hex")}`;

  let stored;
  try {
    stored = await prisma.paymentWebhookEvent.create({
      data: {
        providerEventId,
        event: eventName || "unknown",
        reference: typeof data.reference === "string" ? data.reference : null,
        payload: event,
      },
    });
  } catch {
    const existing = await prisma.paymentWebhookEvent
      .findUnique({ where: { providerEventId } })
      .catch(() => null);
    if (!existing) {
      return res.status(500).json({ message: "Webhook could not be recorded" });
    }
    if (existing.status === "PROCESSED" || existing.status === "IGNORED") {
      return res.json({ received: true, duplicate: true, handled: false });
    }
    // FAILED, or a process died mid-handling: this redelivery is the retry we wanted.
    stored = await prisma.paymentWebhookEvent.update({
      where: { id: existing.id },
      data: { status: "RECEIVED", error: null },
    });
  }

  const finish = async (
    status: "PROCESSED" | "IGNORED" | "FAILED",
    options: { error?: string; organizationId?: string | null } = {}
  ) => {
    await prisma.paymentWebhookEvent
      .update({
        where: { id: stored.id },
        data: {
          status,
          error: options.error ?? null,
          organizationId: options.organizationId ?? null,
          processedAt: new Date(),
        },
      })
      .catch(() => undefined);
  };

  try {
    if (eventName === "charge.success") {
      const reference = String(data.reference ?? "");
      if (!reference) {
        await finish("IGNORED", { error: "The charge carries no reference" });
        return res.json({ received: true, handled: false });
      }

      // A charge can be for an invoice a customer is paying, or for a plan a business is
      // subscribing to. Both arrive here on the same provider account, so the reference is
      // looked up in both places rather than one being assumed.
      //
      // The card path is tried first and unchanged: it is the existing behaviour and it must
      // keep working exactly as it did.
      const isCardPayment = await prisma.cardPayment.findUnique({
        where: { reference },
        select: { id: true },
      });
      if (isCardPayment) {
        try {
          // The signature proves the message came from Paystack. confirmCardPayment then asks
          // Paystack directly and settles the invoice once. An amount that does not match
          // raises rather than being recorded, so the sale is simply left unpaid.
          const settled = await confirmCardPayment(reference);
          await finish("PROCESSED");
          return res.json({ received: true, handled: settled.settled, status: settled.status });
        } catch (err) {
          // A real mismatch must not be silently accepted, and the sale is not marked paid.
          if (err instanceof AppError) {
            await finish("FAILED", { error: err.message });
            return res.status(err.statusCode ?? 500).json({ message: err.message });
          }
          await finish("FAILED", { error: (err as Error).message });
          return res.status(500).json({ message: "Webhook could not be processed" });
        }
      }

      const isSubscriptionPayment = await prisma.subscriptionPayment.findUnique({
        where: { reference },
        select: { id: true, organizationId: true },
      });
      if (isSubscriptionPayment) {
        try {
          // Same discipline as the card path: the signature is trusted only to say the message
          // is from Paystack, and the plan is then granted only after Paystack confirms the
          // money. A forged payload cannot reach this state.
          const result = await handleSubscriptionWebhook(reference);
          await finish("PROCESSED", { organizationId: isSubscriptionPayment.organizationId });
          return res.json({
            received: true,
            handled: result.settled,
            status: result.status,
            kind: "subscription",
          });
        } catch (err) {
          if (err instanceof AppError) {
            await finish("FAILED", { error: err.message });
            return res.status(err.statusCode ?? 500).json({ message: err.message });
          }
          await finish("FAILED", { error: (err as Error).message });
          return res.status(500).json({ message: "Webhook could not be processed" });
        }
      }

      // A renewal Paystack charged on its own: no checkout was opened, so no reference
      // here is familiar. The plan or customer on the payload is, though, and that is
      // who the money belongs to. It is still verified with Paystack before it moves.
      const providerSubCode = String(
        data.plan?.subscription_code ?? data.subscription?.subscription_code ?? ""
      );
      const customerCode = String(data.customer?.customer_code ?? "");
      const byCode = providerSubCode
        ? await prisma.subscription.findFirst({
            where: { providerSubscriptionCode: providerSubCode },
            select: { organizationId: true },
          })
        : null;
      const owned =
        byCode ??
        (customerCode
          ? await prisma.subscription.findFirst({
              where: { providerCustomerId: customerCode },
              select: { organizationId: true },
            })
          : null);

      if (owned) {
        try {
          const result = await applyRenewalCharge({
            organizationId: owned.organizationId,
            reference,
          });
          await finish("PROCESSED", { organizationId: owned.organizationId });
          return res.json({
            received: true,
            handled: result.settled,
            status: result.status,
            kind: "renewal",
          });
        } catch (err) {
          if (err instanceof AppError) {
            await finish("FAILED", { error: err.message, organizationId: owned.organizationId });
            return res.status(err.statusCode ?? 500).json({ message: err.message });
          }
          await finish("FAILED", { error: (err as Error).message });
          return res.status(500).json({ message: "Webhook could not be processed" });
        }
      }

      // A charge for something this installation does not know about. This is deliberately a
      // 404 rather than an acknowledgement: an unknown reference means the event cannot be
      // acted on, and answering 200 would hand the caller a success that was never applied.
      // The signature was valid, so this is not a rejection of the sender.
      await finish("FAILED", { error: "Unknown payment reference" });
      return res.status(404).json({ message: "Payment reference not found" });
    }

    // ---------- Subscription lifecycle events ----------
    //
    // The states a recurring subscription moves through at Paystack. Each one is matched
    // against the codes stored on our own subscription, so an event naming nothing we
    // own is recorded and acknowledged but changes nothing.
    if (
      eventName === "subscription.create" ||
      eventName === "subscription.enable" ||
      eventName === "subscription.disable" ||
      eventName === "subscription.not_renew" ||
      eventName === "invoice.payment_failed"
    ) {
      const result = await handlePaystackLifecycleEvent({ event: eventName, data });
      if (result.handled) {
        await finish("PROCESSED");
        return res.json({ received: true, handled: true, detail: result.detail });
      }
      await finish("IGNORED", { error: result.detail });
      return res.json({ received: true, handled: false, detail: result.detail });
    }

    // A failed charge for a checkout we opened: the payment row is marked failed so the
    // history reads truthfully. A failed charge we cannot place is still recorded.
    if (eventName === "charge.failed") {
      const reference = String(data.reference ?? "");
      const failed = reference
        ? await prisma.subscriptionPayment.findUnique({
            where: { reference },
            select: {
              id: true,
              organizationId: true,
              status: true,
              billingInterval: true,
            },
          })
        : null;
      if (failed && failed.status !== "SUCCESS") {
        await recordPaymentFailure({
          organizationId: failed.organizationId,
          paymentId: failed.id,
          reason: "Paystack reported the charge failed",
          interval: failed.billingInterval,
        });
        await finish("PROCESSED", { organizationId: failed.organizationId });
        return res.json({ received: true, handled: true, detail: "Charge marked as failed" });
      }
      await finish("IGNORED", { error: "No pending payment matches this failed charge" });
      return res.json({ received: true, handled: false });
    }

    // Anything else (refunds, invoice creation, disputes...) is recorded and acknowledged.
    // It is not acted on, and the record means a support question can be answered from
    // what actually arrived rather than from memory.
    await finish("IGNORED", { error: `No handler for ${eventName || "unnamed event"}` });
    return res.json({ received: true, handled: false });
  } catch (err) {
    if (err instanceof AppError) {
      await finish("FAILED", { error: err.message });
      return res.status(err.statusCode ?? 500).json({ message: err.message });
    }
    await finish("FAILED", { error: (err as Error).message });
    return res.status(500).json({ message: "Webhook could not be processed" });
  }
});
