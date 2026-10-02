import { computeCartTotals, summarizeTender, toCents, toCurrency } from "./posTotals";

/**
 * The till quotes a total before the sale is posted, and the server recomputes that
 * total from scratch and refuses any payment that does not match it. These tests pin
 * the two properties that keeps working: the cart total has to equal the server's
 * total, and the cash tendered has to be judged against that total rather than
 * freezing at whatever it held when the first product was rung up.
 */
describe("posTotals", () => {
  describe("computeCartTotals", () => {
    it("adds VAT on top of an exclusive price", () => {
      const totals = computeCartTotals([
        { sellingPrice: 100, quantity: 2, discountAmount: 0, taxRate: 16, taxMode: "EXCLUSIVE" },
      ]);
      // 200.00 net, 32.00 VAT, 232.00 due. Summing only the line bases would quote
      // 200.00 and the server would reject the payment for not matching its 232.00.
      expect(totals.subtotalCents).toBe(20000);
      expect(totals.taxCents).toBe(3200);
      expect(totals.totalCents).toBe(23200);
    });

    it("leaves an inclusive price as the amount actually due", () => {
      const totals = computeCartTotals([
        { sellingPrice: 100, quantity: 1, discountAmount: 0, taxRate: 16, taxMode: "INCLUSIVE" },
      ]);
      // The VAT is already inside the 100.00, so the customer pays 100.00 and the
      // net is what is left once the VAT is taken back out.
      expect(totals.taxCents).toBe(1379);
      expect(totals.subtotalCents).toBe(8621);
      expect(totals.totalCents).toBe(10000);
    });

    it("keeps the total equal to the subtotal plus the tax across mixed modes", () => {
      const totals = computeCartTotals([
        { sellingPrice: 189.5, quantity: 3, discountAmount: 0, taxRate: 16, taxMode: "EXCLUSIVE" },
        { sellingPrice: 67.25, quantity: 2, discountAmount: 0, taxRate: 16, taxMode: "INCLUSIVE" },
        { sellingPrice: 12.99, quantity: 7, discountAmount: 5, taxRate: 8, taxMode: "EXCLUSIVE" },
      ]);
      expect(totals.totalCents).toBe(totals.subtotalCents + totals.taxCents);
      expect(Number.isInteger(totals.totalCents)).toBe(true);
    });

    it("taxes what is left after a line discount", () => {
      const totals = computeCartTotals([
        {
          sellingPrice: 100,
          quantity: 1,
          discountAmount: 20,
          taxRate: 16,
          taxMode: "EXCLUSIVE",
        },
      ]);
      expect(totals.discountCents).toBe(2000);
      // 80.00 net, 12.80 VAT. Taxing the undiscounted 100.00 would overcharge.
      expect(totals.subtotalCents).toBe(8000);
      expect(totals.totalCents).toBe(9280);
    });

    it("never lets a discount exceed the line", () => {
      const totals = computeCartTotals([
        {
          sellingPrice: 100,
          quantity: 1,
          discountAmount: 500,
          taxRate: 16,
          taxMode: "EXCLUSIVE",
        },
      ]);
      expect(totals.subtotalCents).toBe(0);
      expect(totals.totalCents).toBe(0);
    });

    it("is zero for an empty cart rather than NaN", () => {
      const totals = computeCartTotals([]);
      expect(totals.totalCents).toBe(0);
      expect(totals.taxCents).toBe(0);
    });

    it("treats a product with no tax category as untaxed", () => {
      // The till is sent a rate of 0 for a product with no tax category, and that must
      // not be read as an inclusive price that quietly nets a VAT out of it.
      const totals = computeCartTotals([
        { sellingPrice: 50, quantity: 2, discountAmount: 0, taxRate: 0, taxMode: "INCLUSIVE" },
      ]);
      expect(totals.taxCents).toBe(0);
      expect(totals.totalCents).toBe(10000);
    });

    it("stays in whole cents for prices that float badly", () => {
      const totals = computeCartTotals([
        {
          sellingPrice: 10.005,
          quantity: 1,
          discountAmount: 0,
          taxRate: 16,
          taxMode: "EXCLUSIVE",
        },
      ]);
      expect(Number.isInteger(totals.totalCents)).toBe(true);
    });
  });

  describe("summarizeTender", () => {
    it("accepts cash that exactly covers the total", () => {
      const summary = summarizeTender("232.00", 23200);
      expect(summary.coversTotal).toBe(true);
      expect(summary.changeCents).toBe(0);
      expect(summary.shortfallCents).toBe(0);
    });

    it("reports the change when a note is larger than the total", () => {
      const summary = summarizeTender("500", 23200);
      expect(summary.coversTotal).toBe(true);
      expect(summary.changeCents).toBe(26800);
    });

    it("names the shortfall rather than only refusing", () => {
      // A tender left behind from a smaller cart fails here, and the cashier needs the
      // gap to fix it without re-adding the items one at a time to find it.
      const summary = summarizeTender("100.00", 25000);
      expect(summary.coversTotal).toBe(false);
      expect(summary.shortfallCents).toBe(15000);
    });

    it("treats an empty field as nothing tendered, not as valid", () => {
      // Number("") is 0, and a cleared or half typed field must never read as though
      // it covered the sale.
      const summary = summarizeTender("", 25000);
      expect(summary.coversTotal).toBe(false);
      expect(summary.tenderedCents).toBe(0);
      expect(summary.shortfallCents).toBe(25000);
    });

    it("treats an unparseable field as a shortfall, never as a silent pass", () => {
      // NaN fails every comparison, so an unguarded check would let "abc" through to
      // the server as a payment of NaN.
      const summary = summarizeTender("abc", 25000);
      expect(summary.coversTotal).toBe(false);
      expect(summary.tenderedCents).toBe(0);
    });

    it("covers the total at a cent either side of it", () => {
      expect(summarizeTender("249.99", 25000).coversTotal).toBe(false);
      expect(summarizeTender("250.00", 25000).coversTotal).toBe(true);
      expect(summarizeTender("250.01", 25000).coversTotal).toBe(true);
    });
  });

  describe("unit conversion", () => {
    it("moves between units without losing cents", () => {
      expect(toCents(189.99)).toBe(18999);
      expect(toCurrency(18999)).toBe(189.99);
    });
  });
});
