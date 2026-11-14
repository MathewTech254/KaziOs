import { buildEtimsEnvelope } from "./envelope";
import type { EtimsEnvelopeInput } from "./envelope";

/**
 * The KRA payload is the one part of the eTIMS integration that has to be exactly right:
 * an invoice that is filed with the wrong VAT split is a compliance problem, not a display
 * bug. These tests pin the arithmetic against a fixed invoice so a regression shows up
 * here rather than at an audit.
 */

function baseInput(overrides: Partial<EtimsEnvelopeInput> = {}): EtimsEnvelopeInput {
  return {
    organization: {
      name: "Kazi Liquor Store",
      taxNumber: "P051234567X",
      address: "Ngong Road, Nairobi",
      phone: "+254700000000",
      email: "owner@kaziliquor.co.ke",
    },
    invoice: {
      id: "inv-1",
      invoiceNumber: "INV-0001",
      issueDate: new Date("2026-11-14T10:00:00.000Z"),
      currency: "KES",
      subtotal: 500,
      taxTotal: 80,
      discountTotal: 0,
      total: 580,
    },
    customer: { name: "Walk-in", taxNumber: null, phone: null },
    items: [
      {
        description: "Johnnie Walker Black 750ml",
        quantity: 1,
        unitPrice: 500,
        discountAmount: 0,
        taxRate: 16,
        taxAmount: 80,
        lineTotal: 580,
      },
    ],
    payments: [{ provider: "CASH", methodType: "cash", amount: 580 }],
    ...overrides,
  };
}

describe("buildEtimsEnvelope", () => {
  it("separates the taxable figure from the tax on a VAT line", () => {
    const envelope = buildEtimsEnvelope(baseInput());

    expect(envelope.lines[0]).toMatchObject({
      taxable: 500,
      taxAmount: 80,
      lineTotal: 580,
      taxRate: 16,
    });
  });

  it("groups VAT by rate rather than listing one band per line", () => {
    // A shop selling 16% beer and 0% water files two bands, not two identical ones.
    const envelope = buildEtimsEnvelope(
      baseInput({
        items: [
          {
            description: "Tusker 500ml",
            quantity: 2,
            unitPrice: 150,
            discountAmount: 0,
            taxRate: 16,
            taxAmount: 48,
            lineTotal: 348,
          },
          {
            description: "Dasani 500ml",
            quantity: 1,
            unitPrice: 100,
            discountAmount: 0,
            taxRate: 0,
            taxAmount: 0,
            lineTotal: 100,
          },
        ],
      })
    );

    expect(envelope.taxBands).toEqual([
      { rate: 0, taxable: 100, tax: 0 },
      { rate: 16, taxable: 300, tax: 48 },
    ]);
  });

  it("refuses to file for a business with no KRA PIN", () => {
    // A submission without a PIN is not a submission: it would be accepted by nothing,
    // and a row claiming to be filed against no tax number is worse than no row.
    expect(() =>
      buildEtimsEnvelope(
        baseInput({
          organization: { ...baseInput().organization, taxNumber: null },
        })
      )
    ).toThrow(/KRA PIN/);
  });

  it("ignores surrounding whitespace in the PIN", () => {
    const envelope = buildEtimsEnvelope(
      baseInput({
        organization: { ...baseInput().organization, taxNumber: "  P051234567X  " },
      })
    );

    expect(envelope.organisation.pin).toBe("P051234567X");
  });

  it("records a walk-in as having no customer rather than inventing one", () => {
    // A placeholder customer row would corrupt every customer count in the reports.
    const envelope = buildEtimsEnvelope(baseInput({ customer: null }));
    expect(envelope.customer).toBeNull();
  });

  it("carries the customer PIN through when there is one", () => {
    const envelope = buildEtimsEnvelope(
      baseInput({
        customer: { name: "Grace Wambui", taxNumber: "P051987654Y", phone: "+254711111111" },
      })
    );

    expect(envelope.customer).toEqual({
      name: "Grace Wambui",
      pin: "P051987654Y",
      phone: "+254711111111",
    });
  });

  it("rounds every money figure so float noise never reaches KRA", () => {
    // 0.1 + 0.2 is the classic case: unrounded, this files 0.30000000000000004.
    const envelope = buildEtimsEnvelope(
      baseInput({
        invoice: {
          ...baseInput().invoice,
          subtotal: 0.1 + 0.2,
          taxTotal: 0.1 + 0.2,
          total: 0.1 + 0.2,
        },
      })
    );

    expect(envelope.invoice.subtotal).toBe(0.3);
    expect(envelope.invoice.total).toBe(0.3);
  });
});
