import { Router, type Request, type Response } from "express";
import { prisma } from "../lib/prisma";
import type { AuthRequest } from "../middleware/auth";
import { requireAuth, requirePermission } from "../middleware/auth";
import { AppError } from "../middleware/errorHandler";
import { isValidWebhookSignature } from "../lib/paystack";
import { confirmCardPayment, paystackIsReady, startCardPayment } from "../lib/cardPayments";

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
 * Paystack's own notification that a payment finished. This is the normal way an invoice
 * gets marked paid. It carries no session, so it is deliberately unauthenticated and is
 * instead trusted only because the signature matches the secret key. An unsigned or
 * altered request is refused and nothing is written.
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

  if (event.event !== "charge.success") {
    return res.json({ received: true, handled: false });
  }

  const reference = String(data.reference ?? "");
  if (!reference) return res.json({ received: true, handled: false });

  try {
    // The signature proves the message came from Paystack. confirmCardPayment then asks
    // Paystack directly and settles the invoice once. An amount that does not match raises
    // rather than being recorded, so the sale is simply left unpaid.
    const settled = await confirmCardPayment(reference);
    return res.json({ received: true, handled: settled.settled, status: settled.status });
  } catch (err) {
    // A real mismatch must not be silently accepted, and the sale is not marked paid.
    if (err instanceof AppError) {
      return res.status(err.statusCode ?? 500).json({ message: err.message });
    }
    return res.status(500).json({ message: "Webhook could not be processed" });
  }
});
