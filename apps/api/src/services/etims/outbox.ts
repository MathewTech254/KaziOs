import type { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { AppError } from "../../middleware/errorHandler";
import { getEtimsClient } from "./client";
import { buildEtimsEnvelope } from "./envelope";
import type { EtimsEnvelopeInput } from "./envelope";

/**
 * The eTIMS outbox.
 *
 * A sale is rung up whether or not KRA is reachable, so the KRA row is written at the
 * same time as the invoice and the submission is retried until KRA accepts it. Nothing
 * here is allowed to fail a sale: filing is a duty that follows the sale, not a
 * precondition for it.
 */

/** Beyond this the row stops being retried and waits for a person. */
const MAX_ATTEMPTS = 8;

/** How long to wait before retrying, by attempt count. Doubles, capped at an hour. */
function backoffMs(attempts: number): number {
  const minutes = Math.min(2 ** Math.max(0, attempts - 1), 60);
  return minutes * 60 * 1000;
}

async function loadEnvelopeInput(
  invoiceId: string,
  organizationId: string
): Promise<EtimsEnvelopeInput> {
  const invoice = await prisma.invoice.findFirst({
    where: { id: invoiceId, organizationId },
    include: {
      items: { include: { taxCategory: true } },
      customer: true,
      payments: true,
    },
  });
  if (!invoice) throw new AppError(404, "Invoice not found");

  const organization = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { name: true, taxNumber: true, address: true, phone: true, email: true },
  });
  if (!organization) throw new AppError(404, "Organization not found");

  return {
    organization,
    invoice: {
      id: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      issueDate: invoice.issueDate,
      currency: invoice.currency,
      subtotal: invoice.subtotal,
      taxTotal: invoice.taxTotal,
      discountTotal: invoice.discountTotal,
      total: invoice.total,
    },
    customer: invoice.customer
      ? {
          name: invoice.customer.name,
          taxNumber: invoice.customer.taxNumber,
          phone: invoice.customer.phone,
        }
      : null,
    items: invoice.items.map(item => ({
      description: item.description,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      discountAmount: item.discountAmount,
      taxRate: item.taxCategory?.rate ?? 0,
      taxAmount: item.taxAmount,
      lineTotal: item.lineTotal,
    })),
    payments: invoice.payments.map(payment => ({
      provider: payment.provider,
      methodType: payment.methodType,
      amount: payment.amount,
    })),
  };
}

/**
 * Creates the KRA row for an invoice if it does not have one.
 *
 * Idempotent, and never overwrites a row that has already been accepted: the accepted
 * number is the record of what was filed, and re-deriving it would lose that.
 */
export async function enqueueEtimsSubmission(invoiceId: string, organizationId: string) {
  const existing = await prisma.etimsSubmission.findUnique({ where: { invoiceId } });
  if (existing) return existing;

  return prisma.etimsSubmission.create({
    data: { invoiceId, organizationId, status: "PENDING" },
  });
}

/**
 * Files one invoice now, and records what happened.
 *
 * Used by the manual "submit" button and by the sweep. A client that is not configured
 * leaves the row PENDING with the reason on it, which is what lets the till fall back to
 * keying the KRA number by hand without pretending anything was filed.
 */
export async function submitEtimsInvoice(invoiceId: string, organizationId: string) {
  const submission = await enqueueEtimsSubmission(invoiceId, organizationId);
  if (submission.status === "ACCEPTED") return submission;

  const input = await loadEnvelopeInput(invoiceId, organizationId);
  const envelope = buildEtimsEnvelope(input);
  const client = getEtimsClient();

  if (!client.configured) {
    // Nothing to send and nothing to retry: the reason is already on the row, and
    // rewriting it every sweep would churn the table for every unpaid invoice on a
    // server that has no KRA credentials at all.
    if (submission.lastError === client.reason) return submission;

    return prisma.etimsSubmission.update({
      where: { id: submission.id },
      data: { lastError: client.reason, payload: envelope as unknown as Prisma.InputJsonValue },
    });
  }

  try {
    const result = await client.submit(envelope);
    return await prisma.etimsSubmission.update({
      where: { id: submission.id },
      data: {
        status: "ACCEPTED",
        payload: envelope as unknown as Prisma.InputJsonValue,
        kraInvoiceNumber: result.kraInvoiceNumber ?? null,
        qrCode: result.qrCode ?? null,
        lastError: null,
        attempts: { increment: 1 },
        submittedAt: new Date(),
      },
    });
  } catch (err) {
    return prisma.etimsSubmission.update({
      where: { id: submission.id },
      data: {
        status: "REJECTED",
        payload: envelope as unknown as Prisma.InputJsonValue,
        lastError: err instanceof Error ? err.message : String(err),
        attempts: { increment: 1 },
      },
    });
  }
}

/**
 * The sweep the worker runs. Picks up everything still owed to KRA, oldest first, and
 * gives up on a row that has tried too many times rather than hammering KRA forever.
 */
export async function submitPendingEtims(limit = 25) {
  const now = Date.now();

  const pending = await prisma.etimsSubmission.findMany({
    where: {
      status: { in: ["PENDING", "REJECTED"] },
      attempts: { lt: MAX_ATTEMPTS },
    },
    orderBy: { createdAt: "asc" },
    take: limit,
    select: { id: true, invoiceId: true, organizationId: true, attempts: true, updatedAt: true },
  });

  let filed = 0;
  let stillWaiting = 0;

  for (const row of pending) {
    // A row that was just tried is left alone: without this the sweep would retry a
    // rejected invoice every few seconds and KRA would rate-limit the whole business.
    if (row.attempts > 0 && now - row.updatedAt.getTime() < backoffMs(row.attempts)) continue;

    const updated = await submitEtimsInvoice(row.invoiceId, row.organizationId);
    if (updated.status === "ACCEPTED") filed += 1;
    else stillWaiting += 1;
  }

  return { considered: pending.length, filed, stillWaiting };
}

/**
 * Records a KRA invoice number somebody keyed in by hand.
 *
 * This is the path a business uses while its eTIMS credentials are still being issued, and
 * it is not a lesser record: the number came from KRA, so the invoice is filed. What it
 * does not do is submit anything on the business's behalf.
 */
export async function recordManualEtims(input: {
  invoiceId: string;
  organizationId: string;
  kraInvoiceNumber: string;
  qrCode?: string | null;
}) {
  const number = input.kraInvoiceNumber.trim();
  if (!number) throw new AppError(400, "Enter the KRA invoice number");

  return prisma.etimsSubmission.upsert({
    where: { invoiceId: input.invoiceId },
    create: {
      invoiceId: input.invoiceId,
      organizationId: input.organizationId,
      status: "MANUAL",
      kraInvoiceNumber: number,
      qrCode: input.qrCode?.trim() || null,
      submittedAt: new Date(),
    },
    update: {
      status: "MANUAL",
      kraInvoiceNumber: number,
      qrCode: input.qrCode?.trim() || null,
      lastError: null,
      submittedAt: new Date(),
    },
  });
}
