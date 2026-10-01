import { computeInvoiceTotals, toCents, fromCents, formatCents } from "./money";

/**
 * Money is the one part of this system that must never be wrong: it decides what a
 * customer is charged and what the business records as owing. These tests pin the
 * arithmetic that a regression would quietly corrupt.
 */
describe("money", () => {
  describe("toCents / fromCents", () => {
    it("moves between units without losing cents", () => {
      expect(toCents(189.99)).toBe(18999);
      expect(fromCents(18999)).toBe(189.99);
    });

    it("rounds to whole cents rather than truncating", () => {
      // Truncating here would silently lose money on every line of a large sale.
      expect(toCents(0.1 + 0.2)).toBe(30);
      expect(toCents(1.005)).toBe(101);
    });

    it("refuses an amount that is not a number", () => {
      // A NaN reaching the ledger would propagate into every total it touches.
      expect(() => toCents(Number.NaN)).toThrow();
      expect(() => toCents(Number.POSITIVE_INFINITY)).toThrow();
    });
  });

  describe("formatCents", () => {
    it("always shows two decimals, so columns line up", () => {
      expect(formatCents(5)).toBe("0.05");
      expect(formatCents(123456)).toBe("1234.56");
    });
  });

  describe("computeInvoiceTotals", () => {
    it("adds tax on top of an exclusive rate", () => {
      const result = computeInvoiceTotals([{ quantity: 2, unitPrice: 189, taxRate: 16 }]);
      // 378.00 net, 60.48 tax, 438.48 due.
      expect(result.subtotalCents).toBe(37800);
      expect(result.taxCents).toBe(6048);
      expect(result.totalCents).toBe(43848);
    });

    it("never lets a discount exceed the line", () => {
      // A discount bigger than the sale is a discount bigger than the invoice, and
      // must not be allowed to produce a negative total.
      const result = computeInvoiceTotals([
        { quantity: 1, unitPrice: 100, discountAmount: 500, taxRate: 16 },
      ]);
      expect(result.totalCents).toBe(0);
      expect(result.taxCents).toBe(0);
    });

    it("treats a missing discount as none rather than NaN", () => {
      const result = computeInvoiceTotals([{ quantity: 3, unitPrice: 50, taxRate: 0 }]);
      expect(result.subtotalCents).toBe(15000);
      expect(result.totalCents).toBe(15000);
    });

    it("is zero for no lines rather than NaN", () => {
      const result = computeInvoiceTotals([]);
      expect(result.totalCents).toBe(0);
      expect(result.taxCents).toBe(0);
    });

    it("keeps the arithmetic consistent across many lines", () => {
      const result = computeInvoiceTotals([
        { quantity: 3, unitPrice: 189.5, taxRate: 16 },
        { quantity: 2, unitPrice: 67.25, taxRate: 16 },
        { quantity: 7, unitPrice: 12.99, taxRate: 8 },
      ]);
      // The total must always be the subtotal plus the tax, whatever the mix of rates.
      expect(result.totalCents).toBe(result.subtotalCents + result.taxCents);
      expect(Number.isInteger(result.totalCents)).toBe(true);
    });

    it("rounds each line, not just the sum", () => {
      // Rounding only the final total drifts by a cent on a real basket, and a
      // till that computes a different total will refuse the sale.
      const lines = [
        { quantity: 1, unitPrice: 10.005, taxRate: 16 },
        { quantity: 1, unitPrice: 10.005, taxRate: 16 },
      ];
      const result = computeInvoiceTotals(lines);
      const perLine = computeInvoiceTotals([lines[0]]);
      expect(result.subtotalCents).toBe(perLine.subtotalCents * 2);
    });
  });
});
