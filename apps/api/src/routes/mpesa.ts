import { Router, type Request, type Response } from "express";
import { createHash } from "crypto";
import { prisma } from "../lib/prisma";
import { AppError } from "../middleware/errorHandler";
import { confirmMpesaCheckout } from "../services/mpesaBilling";

export const mpesaWebhookRouter = Router();

/**
 * Safaricom's own notification that an STK prompt was answered.
 *
 * It carries no session and — unlike Paystack's webhook — no signature: Daraja
 * has no HMAC equivalent, so there is nothing to verify against the raw bytes.
 * An unsigned endpoint that could settle a payment would be a button for
 * anybody to press, so this endpoint is built to be incapable of that:
 *
 *  1. The payload's own ResultCode is deliberately never read. The only thing
 *     a delivery may do is cause `confirmMpesaCheckout` to run, and that asks
 *     Safaricom directly with our own credentials, keyed on the
 *     CheckoutRequestID we stored at push time. The query is the verification.
 *  2. Every delivery is recorded first, under `mpesa:<CheckoutRequestID>`, so
 *     a redelivery is acknowledged without being applied twice and a delivery
 *     whose handler died mid-way is retried on the next attempt.
 *  3. A delivery naming nothing we own changes nothing and says so plainly.
 *  4. A payment already settled holds the M-PESA receipt in `providerRef`, so
 *     a late duplicate finds no row — which is correct: there is nothing left
 *     to apply, and the confirm route answers the customer either way.
 *
 * Failing to reach Safaricom is answered with a retryable status, because
 * "the provider could not be asked" must never be recorded as an answer.
 */
mpesaWebhookRouter.post("/mpesa", async (req: Request, res: Response) => {
  const payload = req.body ?? {};
  const stk = payload?.Body?.stkCallback;
  const checkoutRequestId =
    typeof stk?.CheckoutRequestID === "string" && stk.CheckoutRequestID.length > 0
      ? stk.CheckoutRequestID
      : "";

  // A stable identity for this delivery: Safaricom's own CheckoutRequestID
  // when the payload names one, a fingerprint of the exact bytes otherwise, so
  // a byte-identical redelivery still collides.
  const rawText = JSON.stringify(payload);
  const providerEventId = checkoutRequestId
    ? `mpesa:${checkoutRequestId}`
    : `mpesa:sha256:${createHash("sha256").update(rawText).digest("hex")}`;

  let stored;
  try {
    stored = await prisma.paymentWebhookEvent.create({
      data: {
        providerEventId,
        event: "mpesa.stk_callback",
        reference: checkoutRequestId || null,
        payload,
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
    // Without a CheckoutRequestID nothing can be asked about, so nothing is
    // applied. Retrying such a delivery could never help, so it is
    // acknowledged rather than refused.
    if (!checkoutRequestId) {
      await finish("IGNORED", { error: "The payload names no CheckoutRequestID" });
      return res.json({ received: true, handled: false });
    }

    const payment = await prisma.subscriptionPayment.findFirst({
      where: { providerRef: checkoutRequestId, provider: "MPESA" },
      select: { reference: true, organizationId: true },
    });
    if (!payment) {
      await finish("IGNORED", { error: "No M-PESA payment matches this checkout" });
      return res.json({ received: true, handled: false });
    }

    // Everything above only earned the right to ask the real question. The
    // answer decides, never this payload.
    const result = await confirmMpesaCheckout(payment.reference);

    if (result.status === "PENDING") {
      // No verdict — either Safaricom has not decided, or it could not be
      // asked (busy, rate-limited, or asked moments ago by the browser's
      // poll). The second kind is answered with a retryable status so
      // Safaricom delivers this callback again once the window has passed;
      // the first kind is acknowledged, because asking again right now
      // would learn nothing new.
      if (result.retryable) {
        await finish("FAILED", { error: result.message });
        return res.status(502).json({ received: true, handled: false, status: result.status });
      }
      await finish("IGNORED", { error: "Safaricom has not decided this checkout yet" });
      return res.json({ received: true, handled: false, status: result.status });
    }

    // Settled, or confirmed failed and written to the row: either way the
    // delivery was applied and must not be applied again.
    await finish("PROCESSED", { organizationId: payment.organizationId });
    return res.json({ received: true, handled: true, status: result.status });
  } catch (err) {
    if (err instanceof AppError) {
      await finish("FAILED", { error: err.message });
      return res.status(err.statusCode ?? 500).json({ message: err.message });
    }
    await finish("FAILED", { error: (err as Error).message });
    return res.status(500).json({ message: "Webhook could not be processed" });
  }
});
