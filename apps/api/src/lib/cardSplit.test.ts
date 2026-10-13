import { computeSplitCharge, SplitConfig } from "./cardSplit";

describe("computeSplitCharge", () => {
  const base: SplitConfig = { subaccountCode: "ACCT_test" };

  it("does not split when no subaccount code is configured", () => {
    const r = computeSplitCharge(10000, { subaccountCode: null });
    expect(r.applySplit).toBe(false);
    expect(r.platformFeeCents).toBe(0);
    expect(r.subaccountReceivesCents).toBe(0);
  });

  it("treats a blank or whitespace subaccount code as no split", () => {
    const r = computeSplitCharge(10000, { subaccountCode: "   " });
    expect(r.applySplit).toBe(false);
    expect(r.platformFeeCents).toBe(0);
  });

  it("gives the whole charge to the shop when no fee is configured", () => {
    const r = computeSplitCharge(10000, base);
    expect(r.applySplit).toBe(true);
    expect(r.platformFeeCents).toBe(0);
    expect(r.subaccountReceivesCents).toBe(10000);
  });

  it("takes a percentage fee in whole cents", () => {
    const r = computeSplitCharge(10000, { ...base, platformFeePercent: 2.5 });
    // 2.5% of 10000 = 250.
    expect(r.platformFeeCents).toBe(250);
    expect(r.subaccountReceivesCents).toBe(9750);
  });

  it("rounds a percentage fee to the nearest cent", () => {
    const r = computeSplitCharge(333, { ...base, platformFeePercent: 2.5 });
    // 2.5% of 333 = 8.325 -> 8.
    expect(r.platformFeeCents).toBe(8);
    expect(r.subaccountReceivesCents).toBe(325);
  });

  it("lets an explicit flat fee override the percentage", () => {
    const r = computeSplitCharge(10000, {
      ...base,
      platformFeePercent: 5,
      platformFeeCents: 300,
    });
    expect(r.platformFeeCents).toBe(300);
    expect(r.subaccountReceivesCents).toBe(9700);
  });

  it("never lets the platform fee exceed the whole sale", () => {
    const r = computeSplitCharge(10000, { ...base, platformFeeCents: 999999 });
    expect(r.platformFeeCents).toBe(10000);
    expect(r.subaccountReceivesCents).toBe(0);
  });

  it("ignores a negative flat fee and falls back to the percentage", () => {
    const r = computeSplitCharge(10000, {
      ...base,
      platformFeePercent: 1,
      platformFeeCents: -500,
    });
    // A negative flat fee is rejected; 1% of 10000 = 100.
    expect(r.platformFeeCents).toBe(100);
  });

  it("returns a zero split for a non-positive total", () => {
    const r = computeSplitCharge(0, { ...base, platformFeePercent: 2 });
    expect(r.applySplit).toBe(true);
    expect(r.platformFeeCents).toBe(0);
    expect(r.subaccountReceivesCents).toBe(0);
  });

  it("keeps every value an integer number of cents that sum to the total", () => {
    for (const total of [1, 333, 999, 10001, 250050]) {
      const r = computeSplitCharge(total, { ...base, platformFeePercent: 2.5 });
      expect(Number.isInteger(r.platformFeeCents)).toBe(true);
      expect(Number.isInteger(r.subaccountReceivesCents)).toBe(true);
      expect(r.platformFeeCents + r.subaccountReceivesCents).toBe(total);
    }
  });
});
