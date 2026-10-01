import { randomUUID } from "crypto";
import { prisma } from "./prisma";
import { AppError } from "../middleware/errorHandler";
import {
  initializeTransaction,
  isPaystackEnabled,
  minimumChargeCents,
  PaystackError,
  verifyTransaction,
} from "./paystack";

const APP_URL = (process.env.APP_URL || "http://localhost:3000").replace(/\/+$/, "");

/** A reference a cashier can read out over the phone if a payment is ever disputed. */
function newReference(invoiceNumber: string): string {
  return `${invoiceNumber.replace(/[^A-Za-z0-9]/g, "")}-${randomUUID().slice(0, 8)}`;
}

export function paystackIsReady(): boolean {
  return isPaystackEnabled();
}

/**
 * Opens a card payment for an invoice. The amount comes from the stored invoice, so a
 * caller cannot ask a customer's card to be charged a different number. Nothing is
 * marked paid here: that happens only once Paystack confirms the money.
 */
export async function startCardPayment(input: {
  invoiceId: string;
  organizationId: string;
  email: string;
}): Promise<{
  reference: string;
  authorizationUrl: string;
  amountCents: number;
  currency: string;
}> {
  const invoice = await prisma.invoice.findFirst({
    where: { id: input.invoiceId, organizationId: input.organizationId },
    select: { id: true, invoiceNumber: true, total: true, currency: true, status: true },
  });
  if (!invoice) throw new AppError(404, "Invoice not found");
  if (invoice.status === "VOID" || invoice.status === "CANCELLED") {
    throw new AppError(400, "This invoice has been cancelled and cannot be paid");
  }

  // Money is derived from the invoice in integer cents, never re-parsed from a float.
  const amountCents = Math.round(invoice.total * 100);
  const currency = (invoice.currency || "KES").toUpperCase();

  const minimum = minimumChargeCents(currency);
  if (amountCents < minimum) {
    throw new AppError(
      400,
      `Card payments start at ${(minimum / 100).toFixed(2)} ${currency}. Take this amount another way.`
    );
  }

  // A repeat attempt reuses the open payment, so a double tap at the till cannot
  // create two charges for one sale.
  const existing = await prisma.cardPayment.findFirst({
    where: { invoiceId: invoice.id, status: "PENDING" },
    orderBy: { createdAt: "desc" },
  });
  if (existing?.authorizationUrl) {
    return {
      reference: existing.reference,
      authorizationUrl: existing.authorizationUrl,
      amountCents: existing.amountCents,
      currency: existing.currency,
    };
  }

  const reference = newReference(invoice.invoiceNumber);

  try {
    const initialized = await initializeTransaction({
      email: input.email,
      amountInCents: amountCents,
      currency,
      reference,
      callbackUrl: `${APP_URL}/pos`,
      metadata: {
        invoiceId: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        organizationId: input.organizationId,
      },
    });

    await prisma.cardPayment.create({
      data: {
        reference,
        invoiceId: invoice.id,
        organizationId: input.organizationId,
        amountCents,
        currency,
        email: input.email,
        status: "PENDING",
        authorizationUrl: initialized.authorization_url,
      },
    });

    return { reference, authorizationUrl: initialized.authorization_url, amountCents, currency };
  } catch (err) {
    const reason =
      err instanceof PaystackError ? err.message : "The payment provider could not be reached";
    throw new AppError(502, `Card payment could not be started: ${reason}`, "PAYSTACK_UNAVAILABLE");
  }
}

export interface SettleResult {
  alreadySettled: boolean;
  reference: string;
  amountCents: number;
  currency: string;
}

/**
 * Records a confirmed card payment. This is the only path that marks an invoice paid,
 * and it is reached from a signed webhook or from the server asking Paystack itself, so a
 * browser claiming "the customer paid" achieves nothing.
 */
export async function settleCardPayment(
  reference: string,
  details: { providerRef?: string; paidAt?: Date | null },
  paymentStatus: string
): Promise<SettleResult> {
  const record = await prisma.cardPayment.findUnique({ where: { reference } });
  if (!record) throw new AppError(404, "Card payment not found");

  // Settling twice must not charge the customer twice, and a reference that already
  // failed cannot be revived by a late event.
  if (record.status === "SUCCESS" || record.status === "FAILED") {
    return {
      alreadySettled: true,
      reference,
      amountCents: record.amountCents,
      currency: record.currency,
    };
  }

  const invoice = await prisma.invoice.findUnique({
    where: { id: record.invoiceId },
    select: { id: true, total: true, paidAmount: true, invoiceNumber: true },
  });
  if (!invoice) throw new AppError(404, "Invoice not found");

  const succeeded = paymentStatus === "success";
  const amount = record.amountCents / 100;
  const newPaid = succeeded
    ? Number(((invoice.paidAmount || 0) + amount).toFixed(2))
    : invoice.paidAmount || 0;
  const fullyPaid = succeeded && newPaid + 0.001 >= invoice.total;

  await prisma.$transaction([
    prisma.payment.create({
      data: {
        reference,
        organizationId: record.organizationId,
        amount,
        currency: record.currency,
        provider: "PAYSTACK",
        methodType: "card",
        status: succeeded ? "SUCCESS" : "FAILED",
        providerRef: details.providerRef ?? null,
        invoiceId: record.invoiceId,
        notes: `Card payment for ${invoice.invoiceNumber}`,
      },
    }),
    prisma.invoice.update({
      where: { id: record.invoiceId },
      // A failed attempt leaves the invoice exactly as it was; only real money moves it on.
      data: succeeded
        ? { paidAmount: newPaid, status: fullyPaid ? "PAID" : "PARTIALLY_PAID" }
        : { paidAmount: newPaid },
    }),
    prisma.cardPayment.update({
      where: { reference },
      data: {
        status: succeeded ? "SUCCESS" : "FAILED",
        providerRef: details.providerRef ?? null,
        paidAt: succeeded ? (details.paidAt ?? new Date()) : null,
        failureReason: succeeded ? null : `Paystack reported ${paymentStatus}`,
      },
    }),
  ]);

  return {
    alreadySettled: false,
    reference,
    amountCents: record.amountCents,
    currency: record.currency,
  };
}

/**
 * The customer came back from the popup but the webhook has not landed yet, which happens
 * on a slow connection. The server asks Paystack directly rather than believing the
 * browser, and settles on the real answer.
 */
export async function confirmCardPayment(reference: string): Promise<{
  status: string;
  settled: boolean;
  amountCents?: number;
  currency?: string;
}> {
  const record = await prisma.cardPayment.findUnique({ where: { reference } });
  if (!record) throw new AppError(404, "Card payment not found");
  if (record.status === "SUCCESS") {
    return {
      status: "SUCCESS",
      settled: true,
      amountCents: record.amountCents,
      currency: record.currency,
    };
  }

  const transaction = await verifyTransaction(reference);
  if (transaction.status !== "success") {
    if (transaction.status === "failed" || transaction.status === "abandoned") {
      await prisma.cardPayment
        .update({
          where: { reference },
          data: { status: "FAILED", failureReason: `Paystack reported ${transaction.status}` },
        })
        .catch(() => undefined);
    }
    return { status: transaction.status, settled: false };
  }

  // Paystack is the authority, but a mismatch means something is wrong, and money must not
  // be recorded against an invoice it was not collected for.
  if (
    transaction.amount !== record.amountCents ||
    transaction.currency?.toUpperCase() !== record.currency.toUpperCase()
  ) {
    throw new AppError(
      409,
      "The amount Paystack confirmed does not match this invoice. Please check the payment before retrying.",
      "AMOUNT_MISMATCH"
    );
  }

  const result = await settleCardPayment(
    reference,
    {
      providerRef: String(transaction.transaction_id),
      paidAt: transaction.paid_at ? new Date(transaction.paid_at) : new Date(),
    },
    "success"
  );
  return {
    status: "SUCCESS",
    settled: true,
    amountCents: result.amountCents,
    currency: result.currency,
  };
}
