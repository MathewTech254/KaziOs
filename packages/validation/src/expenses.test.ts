import { zExpenseSchema, zExpenseQuerySchema, zExpenseVoidSchema } from "./index";
import { zCustomerSchema } from "./index";

/**
 * A customer is looked up at a till by whatever the customer says out loud, which is
 * usually a phone number rather than a surname. These tests pin the field rules that
 * decide whether that lookup can succeed at all.
 */
describe("customer validation at the till", () => {
  it("accepts a name and a phone, which is all a walk-in capture needs", () => {
    // Forcing an email or an address here is what made cashiers avoid registering
    // anyone, and then the business had no customer history to work with.
    expect(zCustomerSchema.safeParse({ name: "Wanjiku", phone: "0712345678" }).success).toBe(true);
  });

  it("requires a name of at least two characters", () => {
    // A single character is a typo, and a customer row named "A" is unusable in a report.
    expect(zCustomerSchema.safeParse({ name: "A" }).success).toBe(false);
    expect(zCustomerSchema.safeParse({ name: "" }).success).toBe(false);
  });

  it("refuses a blank phone rather than storing an empty string", () => {
    // An empty string is not a phone number. Storing one would make "has a phone" true
    // for a customer who was never asked, and a search on it would match everyone.
    expect(zCustomerSchema.safeParse({ name: "Wanjiku", phone: "" }).success).toBe(false);
  });

  it("treats an omitted phone as absent, which is the normal case at a till", () => {
    // The route maps an omitted or blank field to null, so the column stays null rather
    // than holding "" and every "customer with a phone" report stays truthful.
    const parsed = zCustomerSchema.parse({ name: "Wanjiku" });
    expect(parsed.phone).toBeUndefined();
  });

  it("still refuses a malformed email when one is given", () => {
    // Optional does not mean unvalidated: a stored bad address cannot be mailed to, so
    // it is rejected here rather than discovered at receipt time.
    expect(zCustomerSchema.safeParse({ name: "Wanjiku", email: "not-an-email" }).success).toBe(
      false
    );
  });
});

/**
 * An expense is a financial record, so the rules that protect one are not cosmetic.
 * These tests pin the properties that stop a bad amount, a foreign category or an
 * unexplained void from reaching the ledger, and the ones that stop a valid record from
 * being rejected because a form left a field empty.
 */
describe("expense validation", () => {
  const valid = {
    vendorName: "Landlord Ltd",
    amount: 45000,
    expenseDate: "2026-09-25T00:00:00.000Z",
    paymentMethod: "MPESA" as const,
  };

  describe("zExpenseSchema", () => {
    it("accepts a normal expense", () => {
      expect(zExpenseSchema.safeParse(valid).success).toBe(true);
    });

    it("refuses a zero or negative amount, because spending nothing is not an expense", () => {
      // A negative expense is the shape an accidental subtraction produces, and letting
      // it through would turn a cost into income and corrupt every total it joins.
      expect(zExpenseSchema.safeParse({ ...valid, amount: 0 }).success).toBe(false);
      expect(zExpenseSchema.safeParse({ ...valid, amount: -500 }).success).toBe(false);
    });

    it("refuses an implausibly large amount rather than storing it", () => {
      // A missing decimal point is the classic data entry accident, and it poisons every
      // sum it is ever included in.
      expect(zExpenseSchema.safeParse({ ...valid, amount: 99999999999 }).success).toBe(false);
    });

    it("defaults to cash, which is how most small daily expenses are paid", () => {
      const parsed = zExpenseSchema.parse({ ...valid, paymentMethod: undefined });
      expect(parsed.paymentMethod).toBe("CASH");
    });

    it("accepts M-PESA, which is how a Kenyan business usually pays a supplier", () => {
      // The previous, unreferenced schema had no M-PESA option at all, which forced
      // every mobile money payment to be filed as something it was not.
      expect(zExpenseSchema.safeParse({ ...valid, paymentMethod: "MPESA" }).success).toBe(true);
    });

    it("treats the category and supplier as optional", () => {
      // Fuel bought at a filling station, or a market stall, genuinely has neither, and
      // forcing a category would mean inventing data rather than recording it.
      expect(zExpenseSchema.safeParse(valid).success).toBe(true);
    });

    it("still rejects a category that is not a uuid", () => {
      // The legacy column held free text, so anything non uuid has to be refused or the
      // foreign key would reject it at the database instead of in the request.
      expect(zExpenseSchema.safeParse({ ...valid, categoryId: "Rent" }).success).toBe(false);
    });

    it("requires a real vendor name", () => {
      expect(zExpenseSchema.safeParse({ ...valid, vendorName: "" }).success).toBe(false);
      expect(zExpenseSchema.safeParse({ ...valid, vendorName: "K" }).success).toBe(false);
    });

    it("requires a real date", () => {
      expect(zExpenseSchema.safeParse({ ...valid, expenseDate: "last tuesday" }).success).toBe(
        false
      );
    });
  });

  describe("zExpenseQuerySchema", () => {
    it("paginates with a safe default and a bounded ceiling", () => {
      const parsed = zExpenseQuerySchema.parse({});
      expect(parsed.page).toBe(1);
      expect(parsed.limit).toBe(50);
      // Without a cap one request could pull every expense the business has ever had.
      expect(zExpenseQuerySchema.safeParse({ limit: 100000 }).success).toBe(false);
    });

    it("coerces the numeric strings a query string always produces", () => {
      const parsed = zExpenseQuerySchema.parse({ page: "3", limit: "25" });
      expect(parsed.page).toBe(3);
      expect(parsed.limit).toBe(25);
    });

    it("rejects an unknown status rather than silently returning everything", () => {
      // An ignored filter would show a filtered list that is actually unfiltered, which
      // is how a report quietly starts lying.
      expect(zExpenseQuerySchema.safeParse({ status: "NONSENSE" }).success).toBe(false);
    });
  });

  describe("zExpenseVoidSchema", () => {
    it("demands a reason, because an unexplained void is not an audit trail", () => {
      expect(zExpenseVoidSchema.safeParse({ reason: "" }).success).toBe(false);
      expect(zExpenseVoidSchema.safeParse({ reason: "x" }).success).toBe(false);
      expect(zExpenseVoidSchema.safeParse({}).success).toBe(false);
    });

    it("accepts a stated reason", () => {
      expect(zExpenseVoidSchema.safeParse({ reason: "Duplicate of EXP-001" }).success).toBe(true);
    });
  });
});
