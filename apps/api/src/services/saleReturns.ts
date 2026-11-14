import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { AppError } from "../middleware/errorHandler";
import { generateId } from "../lib/utils";
import { applyStockChange } from "./inventory";

/**
 * Undoing a sale, in one place.
 *
 * A sale is not one row: it is an invoice, its lines, the Inventory rows it
 * decremented, the StockMovement ledger, a journal entry and any payments. Voiding
 * only the invoice leaves the goods gone and the books still showing the revenue, so
 * every path that cancels a sale goes through here and the five things move together
 * in one Serializable transaction.
 *
 * Three callers, one rule: the till's Return sale, the till's Cancel sale (a cashier
 * correcting their own unpaid sale) and the invoice screen's Void.
 */
export interface ReverseSaleInput {
  invoiceId: string;
  organizationId: string;
  /** Where the goods go back to. A sale rung at one till can be corrected at another. */
  warehouseId: string;
  reason?: string | null;
}

export interface ReverseSaleResult {
  invoiceNumber: string;
  invoice: { id: string; status: string; paidAmount: number };
  /** Where the goods went back to. The till shows this so the cashier can see the shelf moved. */
  warehouse: { id: string; name: string };
  /** Lines that actually put stock back, for the confirmation message. */
  restored: { description: string; quantity: number }[];
}

/** Products that never occupied a shelf have nothing to give back. */
function isTracked(item: {
  product?: { trackStock?: boolean; productType?: string } | null;
}): boolean {
  const product = item.product;
  if (!product?.trackStock) return false;
  return product.productType !== "SERVICE" && product.productType !== "DIGITAL";
}

/**
 * Restores stock, reverses the accounting and marks the invoice void.
 *
 * Throws rather than partially applying: a caller that cannot say which warehouse the
 * goods came from gets a 400 before anything is written.
 */
export async function reverseSale(input: ReverseSaleInput): Promise<ReverseSaleResult> {
  const { invoiceId, organizationId, warehouseId } = input;

  const warehouse = await prisma.warehouse.findFirst({
    where: { id: warehouseId, organizationId },
  });
  if (!warehouse)
    throw new AppError(400, "The selected warehouse is not available in this organization");

  const invoice = await prisma.invoice.findFirst({
    where: { id: invoiceId, organizationId },
    include: { items: { include: { product: true } } },
  });
  if (!invoice) throw new AppError(404, "Sale not found");

  if (invoice.status === "VOID")
    throw new AppError(409, "This sale has already been cancelled or returned");
  if (invoice.status === "DRAFT")
    throw new AppError(400, "A draft sale never left the shelf, so there is nothing to return");

  const restored: { description: string; quantity: number }[] = [];

  const updated = await prisma.$transaction(
    async tx => {
      for (const item of invoice.items) {
        if (!isTracked(item) || !item.productId) continue;

        await applyStockChange(tx, {
          organizationId,
          productId: item.productId,
          warehouseId,
          branchId: invoice.branchId ?? null,
          delta: Number(item.quantity),
          type: "RETURN",
          reason: input.reason || `Sale reversed ${invoice.invoiceNumber}`,
          reference: invoice.invoiceNumber,
          productName: item.product?.name,
        });
        restored.push({ description: item.description, quantity: Number(item.quantity) });
      }

      // Reverse the accounting the sale posted. Without this the revenue and cash stay
      // on the books while the goods come back, and the trial balance can no longer be
      // derived from the sale records. The reversal mirrors the original entry
      // line-for-line with debit/credit swapped, following the same pattern as the
      // expense-void reversal.
      const original = await tx.journalEntry.findFirst({
        where: {
          organizationId,
          description: `POS sale ${invoice.invoiceNumber}`,
        },
        include: { lines: true },
        orderBy: { journalDate: "desc" },
      });
      if (original) {
        await tx.journalEntry.create({
          data: {
            reference: `JE-RETURN-${generateId()}`,
            description: `POS return ${invoice.invoiceNumber}`,
            journalDate: new Date(),
            status: "POSTED",
            organizationId,
            lines: {
              create: original.lines.map(line => ({
                accountId: line.accountId,
                description: `Reversal: ${line.description ?? invoice.invoiceNumber}`,
                // Swapped, not copied: repeating the original direction would double
                // the sale instead of undoing it.
                debit: line.credit,
                credit: line.debit,
              })),
            },
          },
        });
      }

      // Cash handed back over the counter (or voided card intent) is no longer money in
      // hand: mark linked payments refunded and zero the collected amount so the invoice
      // cannot read as both void and paid.
      await tx.payment.updateMany({
        where: { invoiceId: invoice.id, organizationId },
        data: { status: "REFUNDED" },
      });

      return tx.invoice.update({
        where: { id: invoice.id },
        data: { status: "VOID", paidAmount: 0 },
      });
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
  );

  return {
    invoiceNumber: invoice.invoiceNumber,
    invoice: { id: updated.id, status: updated.status, paidAmount: updated.paidAmount },
    warehouse: { id: warehouse.id, name: warehouse.name },
    restored,
  };
}

/**
 * True when voiding this invoice would strand stock on a shelf that no longer counts
 * it. Callers use this to decide whether they must ask for a warehouse.
 */
export async function saleHasTrackedStock(invoiceId: string, organizationId: string) {
  const items = await prisma.invoiceItem.findMany({
    where: { invoiceId, invoice: { organizationId } },
    include: { product: { select: { trackStock: true, productType: true } } },
  });
  return items.some(isTracked);
}
