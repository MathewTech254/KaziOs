/**
 * Money is never stored or added as a floating point number. 0.1 + 0.2 is
 * 0.30000000000000004 in IEEE 754, and an accounting ledger that drifts by a
 * hundredth of a cent on every line is not an accounting ledger. Amounts are
 * carried as integer minor units (cents) for arithmetic, and only converted for
 * storage and display, which keeps the ledger exact and auditable.
 */

export interface MoneyBreakdown {
  subtotalCents: number;
  taxCents: number;
  discountCents: number;
  totalCents: number;
}

/** Converts a major-unit amount (12.34) to integer cents (1234). */
export function toCents(value: number): number {
  if (!Number.isFinite(value)) {
    throw new Error(`Cannot convert a non finite amount to cents: ${value}`);
  }
  // Math.round plus the epsilon nudge keeps 1.005 at 101 rather than 100.
  return Math.round((value + Number.EPSILON) * 100);
}

/** Converts integer cents (1234) back to a major-unit amount (12.34). */
export function fromCents(cents: number): number {
  return Math.round(cents) / 100;
}

/** Formats cents for display, e.g. 1234 -> "12.34". */
export function formatCents(cents: number): string {
  return (Math.round(cents) / 100).toFixed(2);
}

/**
 * Recomputes an invoice from its lines. Every amount the ledger stores is
 * derived here from quantity, unit price, discount and tax rate, so a client
 * cannot declare its own totals.
 */
export function computeInvoiceTotals(
  lines: {
    quantity: number;
    unitPrice: number;
    discountAmount?: number | null;
    taxRate?: number | null;
  }[]
): MoneyBreakdown & {
  lines: {
    lineTotalCents: number;
    discountCents: number;
    taxCents: number;
    netCents: number;
  }[];
} {
  let subtotalCents = 0;
  let taxCents = 0;
  let discountCents = 0;
  let totalCents = 0;

  const computed = lines.map(line => {
    const grossCents = Math.round(toCents(line.unitPrice) * line.quantity);
    // A discount larger than the line is a discount larger than the sale.
    const lineDiscountCents = Math.min(Math.max(toCents(line.discountAmount ?? 0), 0), grossCents);
    const netCents = grossCents - lineDiscountCents;
    const lineTaxCents = Math.round((netCents * (line.taxRate ?? 0)) / 100);
    const lineTotalCents = netCents + lineTaxCents;

    subtotalCents += grossCents;
    discountCents += lineDiscountCents;
    taxCents += lineTaxCents;
    totalCents += lineTotalCents;

    return { lineTotalCents, discountCents: lineDiscountCents, taxCents: lineTaxCents, netCents };
  });

  return {
    lines: computed,
    subtotalCents,
    taxCents,
    discountCents,
    totalCents,
  };
}
