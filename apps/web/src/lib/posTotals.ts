/**
 * Cart arithmetic for the till, kept deliberately identical to the server's own maths
 * in apps/api/src/routes/pos.ts.
 *
 * The till has to show a total before a sale is posted, but the server recomputes every
 * line from scratch and refuses a payment that does not match its total. Two
 * implementations that disagree by a cent therefore do not produce a slightly wrong
 * receipt, they produce a sale that cannot be rung up at all, so the exclusive and
 * inclusive rules below are mirrored from the route rather than invented here.
 *
 * Money is carried as integer cents. 0.1 + 0.2 is 0.30000000000000004 in IEEE 754, and
 * a total that drifts by a hundredth of a cent is a total the server will reject.
 */

export interface PricedLine {
  sellingPrice: number;
  quantity: number;
  discountAmount: number;
  taxRate: number;
  taxMode: "EXCLUSIVE" | "INCLUSIVE";
}

export interface CartTotals {
  subtotalCents: number;
  taxCents: number;
  discountCents: number;
  totalCents: number;
}

/** Converts a major-unit amount (12.34) to integer cents (1234). */
export function toCents(value: number): number {
  return Math.round(value * 100);
}

/** Converts integer cents (1234) back to a major-unit amount (12.34). */
export function toCurrency(cents: number): number {
  return cents / 100;
}

function roundCents(value: number): number {
  return Math.round(value + Number.EPSILON);
}

/** A line before tax: the shelf price times the quantity, less the line discount. */
export function lineBaseCents(line: PricedLine): number {
  const grossCents = roundCents(toCents(line.sellingPrice) * line.quantity);
  // A discount larger than the line is a discount larger than the sale.
  const discountCents = Math.min(grossCents, Math.max(0, toCents(line.discountAmount)));
  return grossCents - discountCents;
}

/** The VAT on a line, extracted or added depending on how its price was quoted. */
export function lineTaxCents(line: PricedLine, baseCents: number): number {
  const rate = line.taxRate || 0;
  // EXCLUSIVE means the shelf price excludes VAT, so the tax is added on top and the
  // net is the line as priced. INCLUSIVE means the price already contains the VAT, so
  // it is extracted and the net is smaller than the price.
  return line.taxMode === "INCLUSIVE"
    ? baseCents - Math.round(baseCents / (1 + rate / 100))
    : Math.round((baseCents * rate) / 100);
}

/**
 * The cart total exactly as the server will compute it: the net of each line plus the
 * tax sitting on top of it.
 */
export function computeCartTotals(cart: PricedLine[]): CartTotals {
  let subtotalCents = 0;
  let taxCents = 0;
  let discountCents = 0;
  let totalCents = 0;

  for (const line of cart) {
    const baseCents = lineBaseCents(line);
    const lineTax = lineTaxCents(line, baseCents);
    // For an inclusive price the VAT comes back out of the base; for an exclusive one
    // the base is already the net. Summing the base alone would quote an exclusive
    // line short by its own VAT.
    const netCents = line.taxMode === "INCLUSIVE" ? baseCents - lineTax : baseCents;

    subtotalCents += netCents;
    taxCents += lineTax;
    discountCents += roundCents(toCents(line.sellingPrice) * line.quantity) - baseCents;
    totalCents += netCents + lineTax;
  }

  return { subtotalCents, taxCents, discountCents, totalCents };
}

export interface TenderSummary {
  tenderedCents: number;
  /** How far short of the total the cashier is, so the till can say by how much. */
  shortfallCents: number;
  changeCents: number;
  coversTotal: boolean;
}

/**
 * What the cash in hand means against the total.
 *
 * An empty or unparseable field is read as nothing tendered rather than NaN, so a
 * half-typed amount is reported as a shortfall instead of quietly passing a comparison
 * that NaN always fails.
 */
export function summarizeTender(tenderedAmount: string, totalCents: number): TenderSummary {
  const parsed = Number(tenderedAmount);
  const tenderedCents = Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed * 100) : 0;
  const difference = tenderedCents - totalCents;
  return {
    tenderedCents,
    shortfallCents: difference < 0 ? -difference : 0,
    changeCents: difference > 0 ? difference : 0,
    coversTotal: difference >= 0,
  };
}
