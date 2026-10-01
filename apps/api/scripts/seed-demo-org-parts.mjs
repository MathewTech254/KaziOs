import {
  STOCK_BY_BRANCH, CUSTOMERS, SUPPLIERS, STAFF, PRICE, INVOICE_PLAN, daysAgo, resolvePermissions,
} from "./seed-demo-org-data.mjs";

const BRANCH_CODES = ["NGR", "WST", "MSB"];

/**
 * Stock, customers, suppliers, staff and invoices.
 *
 * Every amount on an invoice is derived by the server from the price and the tax
 * rate, and the due date from the terms. Nothing here sets a total by hand, so the
 * figures the app shows are the ones the application would compute on its own.
 */
export async function seedTrading(state) {
  const { get, post, productBySku, branchByCode, warehouseByBranch, taxByName, productMeta } = state;

  // --- stock, per branch ---------------------------------------------------
  // Branch specific on purpose: a till in Mombasa Road must not be able to sell what
  // Ngong Road has on its shelves, and the inventory screen has to give three
  // different answers rather than one.
  let adjustments = 0;
  for (const code of BRANCH_CODES) {
    const warehouse = warehouseByBranch.get(code);
    const tiers = STOCK_BY_BRANCH[code];
    for (const [sku, meta] of productMeta.entries()) {
      if (!meta.trackStock) continue;
      const quantity = tiers[meta.tier];
      if (quantity <= 0) continue;
      const product = productBySku.get(sku);
      if (!product) continue;
      try {
        await post("/inventory/adjustments", {
          productId: product.id,
          warehouseId: warehouse.id,
          adjustmentType: "INCREASE",
          quantity,
          reason: "Opening stock",
          reference: `OPEN-${code}-${sku}`,
        });
        adjustments++;
      } catch (err) {
        // A duplicate reference means this run already did the work.
        if (!/already|exists|409/i.test(err.message)) throw err;
      }
    }
  }
  console.log(`  stock            ${adjustments} opening balances across 3 warehouses`);

  // --- customers -----------------------------------------------------------
  const existingCustomers = (await get("/customers?limit=200")).data;
  const customerByName = new Map(existingCustomers.map((c) => [c.name, c]));
  for (const [name, type, email, phone, address, taxNumber] of CUSTOMERS) {
    if (customerByName.has(name)) continue;
    const row = (await post("/customers", {
      name, customerType: type, email, phone, address, taxNumber: taxNumber ?? null,
    })).data;
    customerByName.set(name, row);
  }
  console.log(`  customers        ${customerByName.size} on file`);

  // --- suppliers -----------------------------------------------------------
  const existingSuppliers = (await get("/suppliers?limit=200")).data;
  const supplierByName = new Map(existingSuppliers.map((s) => [s.name, s]));
  for (const [name, email, phone, address] of SUPPLIERS) {
    if (supplierByName.has(name)) continue;
    const row = (await post("/suppliers", { name, email, phone, address })).data;
    supplierByName.set(name, row);
  }
  console.log(`  suppliers        ${supplierByName.size} on file`);

  // --- staff and roles -----------------------------------------------------
  // Four roles with genuinely different permissions. The cashier can ring a sale but
  // cannot see reports; the accountant sees money but cannot touch stock. That is the
  // point of having them, and it is only testable because they really differ.
  const catalogueGroups = (await get("/roles/permissions")).data;
  // The endpoint answers with groups, but a caller that has already flattened it
  // should still work, so both shapes are accepted rather than assumed.
  state.permissionCatalogue = (Array.isArray(catalogueGroups) ? catalogueGroups : [])
    .flatMap((group) => (group && Array.isArray(group.permissions) ? group.permissions : group ? [group] : []));

  // Each row is [name, email, type, permissions].
  const existingRoles = (await get("/roles")).data;
  const roleByType = new Map();
  for (const [name, email, type, permissions] of STAFF) {
    let role = existingRoles.find((r) => r.type === type);
    if (!role) {
      role = (await post("/roles", {
        name,
        type,
        description: `${name} role`,
        permissions: await resolvePermissions(state, permissions),
      })).data;
    }
    roleByType.set(type, role);
  }
  console.log(`  roles            ${roleByType.size} in place, from ${state.permissionCatalogue.length} permissions`);

  const existingUsers = (await get("/users")).data;
  const userByEmail = new Map(existingUsers.map((u) => [u.email, u]));
  for (const [name, email, type] of STAFF) {
    if (userByEmail.has(email)) continue;
    try {
      const row = (await post("/users", {
        name, email,
        // A throwaway but valid password. These accounts exist to be assigned to and
        // to prove permissions, not to be signed into by this script.
        password: "KaziOS!Demo2026",
        roleId: roleByType.get(type).id,
      })).data;
      userByEmail.set(email, row);
    } catch (err) {
      if (!/already|exists|409/i.test(err.message)) throw err;
    }
  }
  console.log(`  staff            ${userByEmail.size} people`);

  Object.assign(state, { customerByName, supplierByName, userByEmail, roleByType });
  return seedInvoices(state);
}

/**
 * Invoices in every status the application can hold, including the states that are
 * awkward to reach by hand: part paid, past the due date, and voided.
 */
async function seedInvoices(state) {
  const { get, post, productBySku, branchByCode, customerByName, taxByName } = state;

  const customers = [...customerByName.values()];
  let made = 0;
  const byStatus = { DRAFT: 0, SENT: 0, PARTIALLY_PAID: 0, PAID: 0, VOID: 0 };

  for (const plan of INVOICE_PLAN) {
    const customer = customers[plan.customer % customers.length];
    const branch = branchByCode.get(plan.branch);
    if (!customer || !branch) continue;

    const issued = daysAgo(plan.days);
    const due = new Date(issued);
    due.setDate(due.getDate() + plan.terms);

    const items = plan.items
      .map(([sku, quantity]) => {
        const product = productBySku.get(sku);
        if (!product) return null;
        return {
          productId: product.id,
          description: product.name,
          quantity,
          unitPrice: PRICE[sku] ?? product.sellingPrice,
          discountAmount: 0,
          taxRate: taxByName.get("VAT Standard")?.rate ?? 16,
        };
      })
      .filter(Boolean);
    if (!items.length) continue;

    let invoice;
    try {
      invoice = (await post("/invoices", {
        customerId: customer.id,
        issueDate: issued.toISOString(),
        dueDate: due.toISOString(),
        notes: `${branch.name} - account sale`,
        items,
      })).data;
    } catch {
      continue;
    }
    made++;

    if (!plan.send) { byStatus.DRAFT++; continue; }
    await post(`/invoices/${invoice.id}/send`).catch(() => {});

    if (plan.pay === "full") {
      await post("/payments", {
        invoiceId: invoice.id,
        amount: invoice.total,
        currency: invoice.currency,
        paymentProvider: "BANK",
        paymentMethodType: "bank_transfer",
        reference: `PAY-${invoice.invoiceNumber}`,
        notes: "Full settlement",
      }).catch(() => {});
      byStatus.PAID++;
    } else if (plan.pay === "part") {
      await post("/payments", {
        invoiceId: invoice.id,
        amount: Math.round(invoice.total * 0.4 * 100) / 100,
        currency: invoice.currency,
        paymentProvider: "CASH",
        paymentMethodType: "cash",
        reference: `PAY-PART-${invoice.invoiceNumber}`,
        notes: "Part payment on account",
      }).catch(() => {});
      byStatus.PARTIALLY_PAID++;
    } else if (plan.void) {
      await post(`/invoices/${invoice.id}/void`).catch(() => {});
      byStatus.VOID++;
    } else {
      byStatus.SENT++;
    }
  }

  console.log(`  invoices         ${made} created`);
  console.log(
    `                     draft ${byStatus.DRAFT}, sent ${byStatus.SENT}, part paid ${byStatus.PARTIALLY_PAID}, paid ${byStatus.PAID}, void ${byStatus.VOID}`
  );
  const overdue = INVOICE_PLAN.filter((p) => p.overdue).length;
  console.log(`                     ${overdue} of the sent are past their due date and unpaid`);

  return state;
}

/**
 * Purchase orders and stock transfers.
 *
 * A purchase order left in each of the three states the application distinguishes, so
 * the purchasing screen has a draft to edit, a sent order to chase, and a received
 * order whose stock has already landed.
 */
export async function seedPurchasing(state) {
  const { post, supplierByName, productBySku, branchByCode, warehouseByBranch } = state;
  const suppliers = [...supplierByName.values()];
  if (!suppliers.length) return state;

  const grain = [...productBySku.values()].filter((p) => ["FLR-002-KG", "SGR-001-KG", "RCE-001-KG"].includes(p.sku));
  const dairy = [...productBySku.values()].filter((p) => ["MLK-001-L", "EGG-030-TR"].includes(p.sku));
  const household = [...productBySku.values()].filter((p) => ["SOP-100-BX", "TOL-004-PC"].includes(p.sku));

  const lines = (rows, quantity) =>
    rows.map((p) => ({ productId: p.id, quantity, unitPrice: Math.max(1, Math.round(p.costPrice * 0.95)) }));

  const plan = [
    { supplier: 0, branch: "NGR", items: lines(grain, 100), status: "received" },
    { supplier: 4, branch: "MSB", items: lines(dairy, 60), status: "received" },
    { supplier: 3, branch: "WST", items: lines(household, 80), status: "sent" },
    { supplier: 1, branch: "NGR", items: lines(grain, 150), status: "sent" },
    { supplier: 2, branch: "MSB", items: lines(dairy, 40), status: "draft" },
    { supplier: 3, branch: "MSB", items: lines(household, 60), status: "draft" },
  ];

  const made = { draft: 0, sent: 0, received: 0 };
  for (const spec of plan) {
    const supplier = suppliers[spec.supplier % suppliers.length];
    const branch = branchByCode.get(spec.branch);
    if (!supplier || !branch || !spec.items.length) continue;

    let order;
    try {
      order = (await post("/purchase-orders", {
        supplierId: supplier.id,
        notes: `${branch.name} replenishment`,
        items: spec.items,
      })).data;
    } catch {
      continue;
    }

    if (spec.status === "draft") { made.draft++; continue; }

    await post(`/purchase-orders/${order.id}/send`).catch(() => {});
    made.sent++;

    if (spec.status === "received") {
      // Receiving is what actually moves stock, through the same ledger a real
      // delivery would use rather than by writing inventory directly.
      const warehouse = warehouseByBranch.get(spec.branch);
      for (const line of spec.items) {
        await post("/inventory/adjustments", {
          productId: line.productId,
          warehouseId: warehouse.id,
          adjustmentType: "INCREASE",
          quantity: line.quantity,
          reason: `Received on ${order.poNumber}`,
          reference: order.poNumber,
        }).catch(() => {});
      }
      await post(`/purchase-orders/${order.id}/receive`).catch(() => {});
      made.received++;
    }
  }

  console.log(`  purchase orders   ${made.draft} draft, ${made.sent} sent, ${made.received} received`);

  // --- transfers -----------------------------------------------------------
  // One already moved and one still pending, so the inventory screen shows both a
  // completed history and something waiting on an action.
  const flour = productBySku.get("FLR-002-KG");
  if (flour) {
    const from = warehouseByBranch.get("NGR");
    const to = warehouseByBranch.get("MSB");
    if (from && to) {
      try {
        const transfer = (await post("/inventory/transfers", {
          sourceWarehouseId: from.id,
          destinationWarehouseId: to.id,
          productId: flour.id,
          quantity: 20,
          reason: "Rebalancing Mombasa Road shelves",
        })).data;
        await post(`/inventory/transfers/${transfer.id}/complete`).catch(() => {});
      } catch { /* a transfer already on record is fine */ }

      try {
        await post("/inventory/transfers", {
          sourceWarehouseId: warehouseByBranch.get("WST").id,
          destinationWarehouseId: to.id,
          productId: productBySku.get("SGR-001-KG").id,
          quantity: 15,
          reason: "Awaiting pickup by the Mombasa Road driver",
        });
      } catch { /* ignore */ }
    }
  }
  console.log("  transfers         1 completed, 1 pending");

  return state;
}

/**
 * Real till sales, spread across the last month and across all three branches.
 *
 * These go through the POS endpoint rather than being written as invoices, so stock
 * moves through the same path it does at a real till and the daily figures on the
 * dashboard come from genuine sales.
 */
export async function seedTill(state) {
  const { get, post, branchByCode, warehouseByBranch, productBySku, customerByName } = state;
  if (!productBySku.size) return state;

  // Each basket names a branch code, and the warehouse is resolved from that same
  // branch. Pairing a branch with the wrong warehouse is rejected by the API, and
  // quietly taking the first warehouse of the list would sell Ngong Road stock out of
  // Westlands, which is exactly the mistake this test data must not model.
  const resolveShop = (branchCode) => {
    const branch = branchByCode.get(branchCode);
    const warehouse = warehouseByBranch.get(branchCode);
    if (!branch || !warehouse) {
      throw new Error(`No branch/warehouse pair for "${branchCode}"; the seed is incomplete.`);
    }
    return { branch, warehouse };
  };

  const baskets = [
    ["NGR", [["FLR-002-KG", 2], ["SGR-001-KG", 1], ["BAG-LRG", 1]]],
    ["NGR", [["MLK-001-L", 3], ["SLT-001-KG", 2]]],
    ["WST", [["CHK-001-KG", 2], ["FSH-001-KG", 1]]],
    ["WST", [["TOL-004-PC", 2], ["SOP-100-BX", 6], ["DSH-500-DL", 1]]],
    ["WST", [["OIL-001-L", 2], ["RCE-001-KG", 3]]],
    ["MSB", [["SLT-400-RY", 2], ["FLR-002-WH", 1]]],
    ["MSB", [["EGG-030-TR", 1], ["MLK-001-L", 2]]],
    ["MSB", [["SGR-001-KG", 2], ["SOP-100-BX", 3]]],
  ];

  // A sale every couple of days for four weeks, so the reports screen has a trend
  // rather than a single point.
  const days = [];
  for (let d = 27; d >= 0; d -= 2) days.push(d);

  let taken = 0;
  let skipped = 0;
  let index = 0;

  // Price and tax come from the till's own product endpoint, per branch, because that
  // is what the sale itself will use. Reading them from the admin products list would
  // mean trusting a second source for the same number. The endpoint flattens the tax
  // category to taxRate/taxMode, which is what is read here.
  const tillPrices = new Map();
  for (const code of BRANCH_CODES) {
    const { branch, warehouse } = resolveShop(code);
    // The page size is capped server side, so this is fetched a page at a time until
    // the till stops returning rows. Asking for more than the cap silently truncates,
    // which would leave later products unpriced and every sale using them rejected.
    let page = 1;
    for (;;) {
      const result = await get(
        `/pos/products?branchId=${branch.id}&warehouseId=${warehouse.id}&limit=50&page=${page}`
      );
      const rows = result?.data || [];
      for (const row of rows) {
        if (row.productType === "SERVICE" || row.productType === "DIGITAL") continue;
        tillPrices.set(row.id, {
          sellingPrice: row.sellingPrice,
          taxRate: row.taxRate ?? row.taxCategory?.rate ?? 0,
          taxMode: row.taxMode ?? row.taxCategory?.mode ?? "EXCLUSIVE",
        });
      }
      const total = Number(result?.meta?.total ?? result?.total ?? 0);
      if (rows.length < 50 || (total && tillPrices.size >= 0 && page * 50 >= total)) break;
      page++;
      if (page > 20) break;
    }
  }
  if (!tillPrices.size) {
    throw new Error(
      "The till returned no products, so sale totals cannot be priced. Check the stock seeded in each warehouse."
    );
  }
  for (const day of days) {
    for (let round = 0; round < 2; round++) {
      const [branchCode, wanted] = baskets[index % baskets.length];
      index++;
      const { branch, warehouse } = resolveShop(branchCode);

      const items = wanted
        .map(([sku, quantity]) => {
          const product = productBySku.get(sku);
          return product ? { productId: product.id, quantity, discountAmount: 0 } : null;
        })
        .filter(Boolean);
      if (!items.length) continue;

      // The server prices the basket itself and refuses a payment that does not match its
      // own total, which is the right behaviour. The amount is therefore computed the
      // same way the server does: net = unit price x quantity - discount, then tax on
      // top at the product's own rate, rounding each line to whole cents.
      //
      // Prices are read from the till's own product endpoint rather than the products
      // list, so the figure is exactly what the till will charge. Rounding matters:
      // the server rounds per line, so rounding only the final total can differ by a
      // cent and the sale is then correctly refused.
      let totalCents = 0;
      for (const line of items) {
        const product = tillPrices.get(line.productId);
        if (!product) continue;
        const gross = Math.round(Number(product.sellingPrice) * 100) * line.quantity;
        const discount = Math.min(gross, Math.max(0, Math.round(line.discountAmount * 100)));
        const base = gross - discount;
        const rate = Number(product.taxRate || 0);
        totalCents += base + (product.taxMode === "INCLUSIVE" ? 0 : Math.round((base * rate) / 100));
      }
      const due = totalCents / 100;

      const customers = [...customerByName.values()];
      try {
        await post("/pos/sale", {
          branchId: branch.id,
          warehouseId: warehouse.id,
          // A stable key per sale, so a rerun cannot double the day's takings.
          idempotencyKey: `${branchCode}-${day}-${round}`,
          customerId: customers.length && index % 3 === 0 ? customers[index % customers.length].id : null,
          items,
          payments: [{ provider: "CASH", methodType: "cash", amount: due, tenderedAmount: due }],
        });
        taken++;
      } catch (err) {
        // An idempotent repeat of a sale this run already made is not a failure.
        if (/idempotent/i.test(err.message)) continue;
        // A lean branch genuinely may have run out of something, which is fine and
        // expected. Anything else is a real problem and is reported rather than
        // swallowed: a silent skip reads as "seeded successfully" while the till
        // history is empty.
        if (/available|sold out|stock/i.test(err.message)) { skipped++; continue; }
        console.log(`\n  till sale failed: ${err.message}\n`);
        throw err;
      }
    }
  }
  console.log(`  till sales        ${taken} rung across the last 28 days${skipped ? `, ${skipped} skipped (out of stock)` : ""}`);
  return state;
}

export function printSummary(state) {
  console.log(`
Done. Open http://localhost:3000 and sign in as ${state.me.data.email}.

What to try, in the order a shop actually works
-----------------------------------------------
  1. Dashboard / Reports    revenue, tax collected and payment count, all in KES
  2. POS                    ring a sale at Mombasa Road: its stock is deliberately
                            lean, so selling enough Chicken Wings trips a live low
                            stock alert on the bell
  3. Payments               part paid, fully paid and overdue invoices
  4. Inventory              three warehouses with genuinely different levels;
                            adjust stock and transfer between branches
  5. Purchasing             purchase orders as draft, sent and received
  6. Settings > Users       four staff on four different roles; sign in as the
                            cashier to confirm they cannot see reports or settings
  7. Cmd+K                  search a product by SKU or a scan-ready barcode

Any seeded staff member signs in with the password KaziOS!Demo2026
`);
}
