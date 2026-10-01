import {
  generateId,
  generateInvoiceNumber,
  generateOrderNumber,
  generatePoNumber,
  generateQuoteNumber,
  generateStockReference,
  paginate,
  toFloat,
} from "./utils";

/**
 * Document numbers and pagination are small, but they are load bearing: a duplicate
 * invoice number makes an audit trail ambiguous, and an unclamped page size lets one
 * request pull the whole ledger.
 */

describe("document numbers", () => {
  const cases: [string, (prefix?: string) => string, string][] = [
    ["invoice", generateInvoiceNumber, "INV"],
    ["purchase order", generatePoNumber, "PO"],
    ["quote", generateQuoteNumber, "QT"],
    ["sales order", generateOrderNumber, "SO"],
    ["stock movement", generateStockReference, "ADJ"],
  ];

  it.each(cases)("gives a %s its expected prefix", (_label, generate, prefix) => {
    expect(generate().startsWith(`${prefix}-`)).toBe(true);
  });

  it("includes a date so numbers sort roughly by when they were issued", () => {
    const now = new Date();
    const stamp = `${now.getFullYear().toString().slice(-2)}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
    expect(generateInvoiceNumber()).toContain(stamp);
  });

  it("accepts a custom prefix", () => {
    expect(generateStockReference("TRF").startsWith("TRF-")).toBe(true);
  });

  it("does not repeat itself across many calls", () => {
    // A collision would make two documents share an identifier.
    const numbers = new Set(Array.from({ length: 2000 }, () => generateInvoiceNumber()));
    expect(numbers.size).toBe(2000);
  });

  it("gives every row a distinct id", () => {
    expect(new Set(Array.from({ length: 2000 }, generateId)).size).toBe(2000);
  });
});

describe("paginate", () => {
  it("starts at the beginning by default", () => {
    expect(paginate()).toEqual({ skip: 0, take: 50, page: 1, limit: 50 });
  });

  it("offsets by whole pages", () => {
    expect(paginate(3, 20)).toEqual({ skip: 40, take: 20, page: 3, limit: 20 });
  });

  it("refuses a page below the first", () => {
    // A negative offset is a database error, not an empty list.
    expect(paginate(0, 20).page).toBe(1);
    expect(paginate(-5, 20).skip).toBe(0);
  });

  it("caps the page size so one request cannot pull the whole table", () => {
    expect(paginate(1, 100000).limit).toBe(100);
  });

  it("treats a zero or negative size as the minimum rather than returning nothing", () => {
    expect(paginate(1, 0).limit).toBe(1);
    expect(paginate(1, -10).limit).toBe(1);
  });
});

describe("toFloat", () => {
  it("keeps the value when it really is a number", () => {
    expect(toFloat(12.5)).toBe(12.5);
    expect(toFloat("12.50")).toBe(12.5);
    expect(toFloat(0)).toBe(0);
  });

  it("substitutes the fallback rather than producing NaN", () => {
    // NaN reaching a total silently poisons every figure it touches.
    expect(toFloat(null)).toBe(0);
    expect(toFloat(undefined)).toBe(0);
    expect(toFloat("abc")).toBe(0);
  });

  it("honours a caller supplied fallback", () => {
    expect(toFloat(null, 1)).toBe(1);
    expect(toFloat("nonsense", 2.5)).toBe(2.5);
  });
});
