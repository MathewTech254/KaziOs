import {
  zEmail,
  zLoginSchema,
  zRegisterSchema,
  zPosSaleSchema,
  zForgotPasswordSchema,
  zResetPasswordSchema,
  stockStatusFor,
  availableStock,
  SETTING_DEFINITIONS,
  parseSettingValue,
  settingDefaults,
} from "./index";

/**
 * The validation layer is where a real world mistake is cheapest to catch and most
 * expensive to discover late. A rejected request is a message to one user; an accepted
 * bad one becomes a wrong ledger entry nobody notices until reconciliation.
 */
describe("validation", () => {
  describe("zEmail", () => {
    it("stores an address in lower case whatever the user typed", () => {
      // The bug this prevents: register accepted "Owner@Shop.com" and stored it with
      // capitals, while password reset lowercased before looking anybody up. The
      // account existed, the reset found nobody, and no mail was ever sent.
      expect(zEmail.parse("Owner@Shop.COM")).toBe("owner@shop.com");
      expect(zEmail.parse("  ACHIENG@Example.co.ke  ")).toBe("achieng@example.co.ke");
    });

    it("still rejects something that is not an address", () => {
      // Normalising must not have turned this into an anything-goes schema.
      expect(() => zEmail.parse("not-an-email")).toThrow();
      expect(() => zEmail.parse("")).toThrow();
    });
  });

  describe("zRegisterSchema", () => {
    const valid = {
      name: "Faith Njeri",
      email: "Faith@Example.co.ke",
      password: "Str0ngPass",
      organizationName: "Highlands Provisions",
    };

    it("normalises the email it returns", () => {
      expect(zRegisterSchema.parse(valid).email).toBe("faith@example.co.ke");
    });

    it("fills in the defaults a new shop can rely on", () => {
      const parsed = zRegisterSchema.parse(valid);
      expect(parsed.country).toBe("KE");
      expect(parsed.currency).toBe("KES");
      expect(parsed.timezone).toBe("Africa/Nairobi");
    });

    it("refuses a short password", () => {
      expect(() => zRegisterSchema.parse({ ...valid, password: "short1" })).toThrow();
    });
  });

  describe("zLoginSchema", () => {
    it("accepts the same address in any case", () => {
      // Signing in has to work with whatever the browser or a password manager
      // supplies, otherwise the account exists but cannot be reached.
      const a = zLoginSchema.parse({ email: "USER@Shop.com", password: "x" });
      const b = zLoginSchema.parse({ email: "user@shop.com", password: "x" });
      expect(a.email).toBe(b.email);
    });

    it("still requires a password", () => {
      expect(() => zLoginSchema.parse({ email: "a@b.com" })).toThrow();
    });
  });

  describe("zPosSaleSchema", () => {
    const base = {
      items: [{ productId: "3f1b0c9e-1111-4111-8111-aaaaaaaaaaaa", quantity: 1 }],
      payments: [{ provider: "CASH", methodType: "cash", amount: 100 }],
    };

    it("rejects a sale with no items", () => {
      // An empty basket has no total, so nothing downstream could be trusted.
      expect(() => zPosSaleSchema.parse({ ...base, items: [] })).toThrow();
    });

    it("rejects a non positive quantity", () => {
      // A negative quantity would credit stock and debit a customer.
      expect(() =>
        zPosSaleSchema.parse({
          ...base,
          items: [{ productId: "3f1b0c9e-1111-4111-8111-aaaaaaaaaaaa", quantity: -2 }],
        })
      ).toThrow();
    });
  });

  describe("stock", () => {
    it("reports out of stock at zero and below", () => {
      expect(stockStatusFor(0, 5)).toBe("OUT_OF_STOCK");
    });

    it("reports low stock at or below the reorder level", () => {
      expect(stockStatusFor(5, 5)).toBe("LOW_STOCK");
      expect(stockStatusFor(3, 10)).toBe("LOW_STOCK");
    });

    it("reports in stock above the reorder level", () => {
      expect(stockStatusFor(11, 10)).toBe("IN_STOCK");
    });

    it("treats a product with no reorder level as always in stock", () => {
      // minStock of 0 means "do not manage", so it must not raise a false alert.
      expect(stockStatusFor(1, 0)).toBe("IN_STOCK");
    });

    it("subtracts reserved stock from what is really available", () => {
      // Reserved stock is promised to an order; selling it would oversell.
      expect(availableStock(10, 4)).toBe(6);
    });

    it("never reports negative availability", () => {
      expect(availableStock(2, 5)).toBe(0);
    });
  });

  describe("settings", () => {
    it("gives every key a full set of defaults", () => {
      // The preferences screen renders straight from these, so a missing default is a
      // blank control the user has to guess the meaning of.
      for (const key of Object.keys(SETTING_DEFINITIONS)) {
        const defaults = settingDefaults(key as never);
        expect(defaults).toBeDefined();
        for (const [field, value] of Object.entries(defaults)) {
          expect(value).not.toBeUndefined();
          expect(field).toBeTruthy();
        }
      }
    });

    it("rejects a preference of the wrong type", () => {
      expect(() =>
        parseSettingValue("pos" as never, { autoPrintReceipt: "yes please" } as never)
      ).toThrow();
    });

    it("rejects an unknown setting key rather than storing it", () => {
      // Otherwise a typo becomes a setting the application silently ignores.
      expect(() => parseSettingValue("nonsense" as never, {} as never)).toThrow();
    });
  });
});

describe("password reset input", () => {
  describe("zForgotPasswordSchema", () => {
    it("accepts an ordinary address", () => {
      expect(zForgotPasswordSchema.parse({ email: "amina@highlands.test" }).email).toBe(
        "amina@highlands.test"
      );
    });

    it("rejects an address that is not one", () => {
      // This is the only input to the endpoint, so a loose check here would let the
      // route go looking up junk on every stray request.
      expect(() => zForgotPasswordSchema.parse({ email: "not-an-email" })).toThrow();
    });

    it("requires the field to be present at all", () => {
      expect(() => zForgotPasswordSchema.parse({})).toThrow();
    });
  });

  describe("zResetPasswordSchema", () => {
    const good = { token: "abc123", password: "longenough1", confirmPassword: "longenough1" };

    it("accepts a matching pair", () => {
      expect(zResetPasswordSchema.parse(good).password).toBe("longenough1");
    });

    it("rejects a password under the minimum length", () => {
      // A weak reset password would undo the point of the reset.
      expect(() =>
        zResetPasswordSchema.parse({ ...good, password: "short1", confirmPassword: "short1" })
      ).toThrow();
    });

    it("rejects a confirmation that does not match", () => {
      const result = zResetPasswordSchema.safeParse({
        ...good,
        confirmPassword: "somethingelse",
      });
      expect(result.success).toBe(false);
      expect(result.error?.issues[0].path).toEqual(["confirmPassword"]);
    });

    it("requires a token, so a blank form cannot reach the database", () => {
      expect(() => zResetPasswordSchema.parse({ ...good, token: "" })).toThrow();
    });

    it("rejects a body that is missing entirely", () => {
      expect(() => zResetPasswordSchema.parse(undefined)).toThrow();
    });
  });
});
