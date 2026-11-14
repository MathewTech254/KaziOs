import { AppError } from "../../middleware/errorHandler";

/**
 * The invoice in the shape KRA needs it, derived from what we already store.
 *
 * This is deliberately a pure function over plain data rather than a Prisma query: the
 * payload is the part of the eTIMS integration that has to be exactly right, and a pure
 * function can be tested against a fixed invoice without a database, a control unit or a
 * network.
 *
 * It is also deliberately *our* envelope, not a guess at KRA's wire format. The adapter
 * that talks to KRA maps this onto whatever schema the control unit expects; keeping the
 * two apart means the mapping can change without touching the till, the outbox or the
 * reports that read them.
 */

export interface EtimsLineInput {
  description: string;
  quantity: number;
  unitPrice: number;
  discountAmount: number;
  taxRate: number;
  taxAmount: number;
  lineTotal: number;
}

export interface EtimsEnvelopeInput {
  organization: {
    name: string;
    taxNumber: string | null;
    address: string | null;
    phone: string | null;
    email: string | null;
  };
  invoice: {
    id: string;
    invoiceNumber: string;
    issueDate: Date;
    currency: string;
    subtotal: number;
    taxTotal: number;
    discountTotal: number;
    total: number;
  };
  customer: { name: string; taxNumber: string | null; phone: string | null } | null;
  items: EtimsLineInput[];
  payments: { provider: string; methodType: string; amount: number }[];
}

export interface EtimsTaxBand {
  /** VAT rate as a percentage, e.g. 16. */
  rate: number;
  taxable: number;
  tax: number;
}

export interface EtimsEnvelope {
  version: string;
  organisation: {
    name: string;
    pin: string;
    address: string | null;
    phone: string | null;
    email: string | null;
  };
  invoice: {
    /** Our number, kept alongside KRA's so the two can always be reconciled. */
    number: string;
    issueDate: string;
    currency: string;
    subtotal: number;
    discountTotal: number;
    taxTotal: number;
    total: number;
  };
  customer: { name: string; pin: string | null; phone: string | null } | null;
  lines: {
    description: string;
    quantity: number;
    unitPrice: number;
    discountAmount: number;
    taxRate: number;
    taxable: number;
    taxAmount: number;
    lineTotal: number;
  }[];
  taxBands: EtimsTaxBand[];
  payments: { method: string; amount: number }[];
}

/** Money is stored as a float in this schema, so every figure that leaves is re-rounded. */
function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/**
 * Builds the KRA payload for one invoice.
 *
 * Throws if the business has no PIN, because a submission without one is not a submission:
 * it would be accepted by nothing, and a row that claims to have been filed against no tax
 * number is worse than a row that admits it was not.
 */
export function buildEtimsEnvelope(input: EtimsEnvelopeInput): EtimsEnvelope {
  const pin = (input.organization.taxNumber || "").trim();
  if (!pin) {
    throw new AppError(
      400,
      "This business has no KRA PIN on file. Add it in Settings before submitting an invoice to KRA.",
      "ETIMS_NO_PIN"
    );
  }

  const lines = input.items.map(item => {
    // lineTotal is gross (net + tax), so the taxable figure is what is left after the
    // tax is taken back out. Deriving it this way rather than trusting a separate column
    // means an inclusive-priced and an exclusive-priced line both come out right.
    const lineTotal = round2(item.lineTotal);
    const taxAmount = round2(item.taxAmount);
    const taxable = round2(lineTotal - taxAmount);

    return {
      description: item.description,
      quantity: item.quantity,
      unitPrice: round2(item.unitPrice),
      discountAmount: round2(item.discountAmount),
      taxRate: item.taxRate,
      taxable,
      taxAmount,
      lineTotal,
    };
  });

  // KRA wants VAT grouped by rate, not one figure per line: a shop selling 16% beer and
  // 0% bottled water files two lines, not thirty.
  const byRate = new Map<number, EtimsTaxBand>();
  for (const line of lines) {
    const band = byRate.get(line.taxRate) || { rate: line.taxRate, taxable: 0, tax: 0 };
    band.taxable = round2(band.taxable + line.taxable);
    band.tax = round2(band.tax + line.taxAmount);
    byRate.set(line.taxRate, band);
  }

  return {
    version: "1.0",
    organisation: {
      name: input.organization.name,
      pin,
      address: input.organization.address,
      phone: input.organization.phone,
      email: input.organization.email,
    },
    invoice: {
      number: input.invoice.invoiceNumber,
      issueDate: input.invoice.issueDate.toISOString(),
      currency: input.invoice.currency,
      subtotal: round2(input.invoice.subtotal),
      discountTotal: round2(input.invoice.discountTotal),
      taxTotal: round2(input.invoice.taxTotal),
      total: round2(input.invoice.total),
    },
    customer: input.customer
      ? {
          name: input.customer.name,
          pin: input.customer.taxNumber?.trim() || null,
          phone: input.customer.phone,
        }
      : null,
    lines,
    taxBands: Array.from(byRate.values()).sort((a, b) => a.rate - b.rate),
    payments: input.payments.map(payment => ({
      method: payment.provider,
      amount: round2(payment.amount),
    })),
  };
}
