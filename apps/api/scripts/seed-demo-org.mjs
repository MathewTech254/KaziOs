import {
  STOCK_BY_BRANCH, CUSTOMERS, SUPPLIERS, STAFF, PRICE, INVOICE_PLAN, daysAgo,
} from "./seed-demo-org-data.mjs";

// Builds a complete, realistic Kenyan trading organization across three branches, so
// every screen has something true to show and every flow can be exercised for real.
//
//   node apps/api/scripts/seed-demo-org.mjs            # dry run, prints the plan
//   node apps/api/scripts/seed-demo-org.mjs --apply    # build it
//
// It talks to the running API over HTTP as a normal signed in user, exactly as the
// browser does, so it can never write something the application itself would refuse.
// Money is derived by the server from quantity, price and tax rate; nothing here sets
// a total by hand.
//
// What it deliberately includes, because these are the cases that break real systems:
//   - three branches, each with its own warehouse, and genuinely different stock
//   - invoices in every status: DRAFT, SENT, PARTIALLY_PAID, PAID, OVERDUE, VOID
//   - overdue invoices the worker sweep will find and alert on
//   - products below their reorder level, and products at zero, so both alerts fire
//   - a pending transfer and a completed one, so both sides can be seen
//   - purchase orders as draft, sent and received
//   - staff on four different roles, so permissions can be tested rather than assumed
//   - two customers sharing a name prefix, so search discrimination is testable
//
// Re-running is safe. Everything is matched on a stable key first and the fixed
// reference OPEN-<branch>-<sku> means opening stock is never counted twice.

const KAZIOS_API_URL = process.env.KAZIOS_API_URL || "http://localhost:4000/api/v1";
const KAZIOS_SMOKE_EMAIL = process.env.KAZIOS_SMOKE_EMAIL || "admin@kazios.dev";
const KAZIOS_SMOKE_PASSWORD = process.env.KAZIOS_SMOKE_PASSWORD || "admin123";
const apply = process.argv.includes("--apply");

const MARKER = "kazios-demo-org";
const ORG_NAME = `${MARKER} Highlands Provisions`;

const BASE = KAZIOS_API_URL.replace(/\/+$/, "");
let token = "";

async function call(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { error: text.slice(0, 300) };
  }
  if (!res.ok) {
    const detail = json.details ? ` ${JSON.stringify(json.details).slice(0, 200)}` : "";
    throw new Error(`${method} ${path} -> ${res.status} ${json.error || ""}${detail}`);
  }
  return json;
}

const get = (path) => call("GET", path);
const post = (path, body) => call("POST", path, body);
const put = (path, body) => call("PUT", path, body);
const patch = (path, body) => call("PATCH", path, body);

// ---------------------------------------------------------------------------
// The business
//
// A mid sized neighbourhood grocery and provisions shop in Nairobi. Three branches
// because that is the smallest number at which branch scoped stock, transfers and
// role scoping actually matter: with one branch, "this branch only" is untestable.
// Ngong Road is the flagship and well stocked, Westlands is busy, and Mombasa Road is
// deliberately lean so it has genuinely low stock to reorder.
// ---------------------------------------------------------------------------

const BRANCHES = [
  { name: "Ngong Road", code: "NGR", address: "Ngong Road, Nairobi", phone: "+254700000101" },
  { name: "Westlands", code: "WST", address: "Westlands Road, Nairobi", phone: "+254700000102" },
  { name: "Mombasa Road", code: "MSB", address: "Mombasa Road, Nairobi", phone: "+254700000103" },
];

// name, sku, barcode, category, cost, sell, stock tier, tracks stock
const PRODUCTS = [
  ["Maize Flour 2kg", "FLR-002-KG", "6001001000017", "Staples", 145, 189, "full", true],
  ["Sugar 1kg", "SGR-001-KG", "6001001000024", "Staples", 132, 175, "full", true],
  ["Rice Parboiled 1kg", "RCE-001-KG", "6001001000031", "Staples", 148, 195, "full", true],
  ["Cooking Oil 1L", "OIL-001-L", "6001001000048", "Staples", 210, 265, "full", true],
  ["Wheat Flour 2kg", "FLR-002-WH", "6001001000055", "Staples", 168, 215, "full", true],
  ["Table Salt 1kg", "SLT-001-KG", "6001001000062", "Staples", 40, 65, "full", true],
  ["Royco SALT 400g", "SLT-400-RY", "6001001000079", "Spices", 95, 130, "full", true],
  ["Chicken Wings 1kg", "CHK-001-KG", "6001001000086", "Proteins", 480, 620, "lean", true],
  ["Beef Mince 500g", "BEF-500-G", "6001001000093", "Proteins", 520, 675, "lean", true],
  ["Fish Tilapia 1kg", "FSH-001-KG", "6001001000109", "Proteins", 430, 560, "lean", true],
  ["Eggs Tray 30", "EGG-030-TR", "6001001000116", "Proteins", 380, 470, "lean", true],
  ["Milk 1L", "MLK-001-L", "6001001000123", "Dairy", 105, 135, "lean", true],
  ["Premium Basmati 5kg", "RCE-005-PB", "6001001000130", "Staples", 890, 1150, "outOfStock", true],
  ["Olive Oil 500ml", "OIL-500-OL", "6001001000147", "Staples", 720, 950, "outOfStock", true],
  ["Bar Soap 100g", "SOP-100-BX", "6001001000154", "Household", 55, 85, "full", true],
  ["Toilet Roll (pack 4)", "TOL-004-PC", "6001001000161", "Household", 180, 250, "full", true],
  ["Dishwashing Liquid 500ml", "DSH-500-DL", "6001001000178", "Household", 110, 155, "full", true],
  ["Laundry Powder 1kg", "LDY-001-KG", "6001001000185", "Household", 195, 265, "full", true],
  ["Delivery - Ngong Road", "DLV-NGR", null, "Services", 1, 150, "full", false],
  ["Delivery - Westlands", "DLV-WST", null, "Services", 1, 150, "full", false],
  ["Shopping Bag (large)", "BAG-LRG", null, "Extras", 10, 25, "full", true],
];

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

async function main() {
  console.log(`\n${ORG_NAME}\n${"=".repeat(ORG_NAME.length)}\n`);
  console.log(`api   ${BASE}`);
  console.log(`as    ${KAZIOS_SMOKE_EMAIL}`);
  console.log(`mode  ${apply ? "APPLY" : "dry run (pass --apply to build)"}\n`);

  const login = await post("/auth/login", { email: KAZIOS_SMOKE_EMAIL, password: KAZIOS_SMOKE_PASSWORD });
  token = login.data.token;
  const me = await get("/auth/me");
  const orgId = me.data.organizationId;

  const org = await get("/org");
  console.log(`target organization: ${org.data.name} (${orgId})`);

  if (!apply) {
    console.log(`
Plan
----
  3 branches            ${BRANCHES.map((b) => b.name).join(", ")}
  1 warehouse each      stock differs per branch, one branch deliberately lean
  ${PRODUCTS.length} products        5 categories, tracked and untracked
  ${CUSTOMERS.length} customers     6 individuals, 4 businesses
  ${SUPPLIERS.length} suppliers
  ${STAFF.length} staff             manager, cashier, accountant, stock controller
  ${INVOICE_PLAN.length} invoices         every status incl. overdue and part paid
  notifications        low stock, overdue invoice and sale alerts

Run again with --apply to build it.
`);
    return null;
  }

  // --- organization profile ------------------------------------------------
  // Real Kenyan details so the settings screen and any future eTIMS filing have
  // something truthful to show rather than placeholder text.
  await patch("/org", {
    name: ORG_NAME,
    address: "Ngong Road, Nairobi, Kenya",
    phone: "+254700000100",
    email: "accounts@highlandsprovisions.co.ke",
    taxNumber: "PVT-2017-2244",
    businessCategory: "Retail - Supermarket and provisions",
    country: "KE",
    currency: "KES",
    timezone: "Africa/Nairobi",
  });
  console.log("  organization profile updated");

  // --- preferences ---------------------------------------------------------
  await put("/settings/invoicing", {
    invoicePrefix: "HGL",
    defaultPaymentTermsDays: 14,
    defaultTaxMode: "EXCLUSIVE",
    invoiceFooterNote: "Thank you for shopping with Highlands Provisions. Goods once sold are not returnable.",
  });
  await put("/settings/pos", {
    receiptFooterNote: "Karibu! Asante sana.",
    autoPrintReceipt: false,
    allowNegativeStock: false,
    cashRoundingEnabled: false,
  });
  await put("/settings/notifications", {
    lowStockAlerts: true,
    overdueInvoiceReminders: true,
    dailySalesSummary: false,
  });
  console.log("  preferences applied");

  // --- branches and warehouses ---------------------------------------------
  // Each branch gets its own warehouse: stock has to be separated for transfers and
  // for branch scoped roles to mean anything at all.
  const existingBranches = (await get("/org/branches")).data;
  const branchByCode = new Map();
  for (const spec of BRANCHES) {
    let row = existingBranches.find((b) => b.code === spec.code);
    if (!row) {
      row = (await post("/org/branches", spec)).data;
      console.log(`  branch created    ${row.name} (${row.code})`);
    } else {
      console.log(`  branch exists     ${row.name} (${row.code})`);
    }
    branchByCode.set(spec.code, row);
  }

  const existingWarehouses = (await get("/org/warehouses")).data;
  const warehouseByBranch = new Map();
  for (const spec of BRANCHES) {
    const branch = branchByCode.get(spec.code);
    let row = existingWarehouses.find((w) => w.branchId === branch.id);
    if (!row) {
      row = (await post("/org/warehouses", {
        name: `${branch.name} Store`,
        code: `WH-${spec.code}`,
        address: branch.address,
        branchId: branch.id,
      })).data;
      console.log(`  warehouse created ${row.name}`);
    }
    warehouseByBranch.set(spec.code, row);
  }

  // --- tax categories ------------------------------------------------------
  // Registration already made VAT Standard, Zero Rated and Exempt. Add the reduced
  // rate a real shop needs, and reuse whatever already exists by name.
  const taxes = (await get("/tax-categories")).data;
  const taxByName = new Map(taxes.map((t) => [t.name, t]));
  for (const [name, rate] of [["VAT Standard", 16], ["Zero Rated", 0], ["Exempt", 0], ["VAT Reduced 8%", 8]]) {
    if (!taxByName.has(name)) {
      const made = (await post("/tax-categories", { name, rate, mode: "EXCLUSIVE" })).data;
      taxByName.set(name, made);
      console.log(`  tax category      ${name} (${rate}%)`);
    }
  }

  // --- products ------------------------------------------------------------
  const existingProducts = (await get("/products?limit=200")).data;
  const productBySku = new Map(existingProducts.map((p) => [p.sku, p]));
  const counts = { full: 0, lean: 0, outOfStock: 0 };

  for (const [name, sku, barcode, category, costPrice, sellingPrice, tier, trackStock] of PRODUCTS) {
    if (productBySku.has(sku)) continue;
    const row = (await post("/products", {
      name,
      sku,
      barcode,
      costPrice,
      sellingPrice,
      productType: category === "Services" ? "SERVICE" : "PHYSICAL",
      // Proteins reorder far sooner than shelf stable staples; that difference is
      // what makes the low stock alerts worth looking at.
      minStock: category === "Proteins" || category === "Dairy" ? 10 : 5,
      reorderPoint: category === "Proteins" || category === "Dairy" ? 15 : 8,
      taxCategoryId: category === "Extras" ? taxByName.get("Zero Rated")?.id : taxByName.get("VAT Standard")?.id,
    })).data;
    productBySku.set(sku, row);
    counts[tier]++;
  }
  console.log(`  products          ${counts.full} full, ${counts.lean} lean, ${counts.outOfStock} out of stock`);

  return {
    get, post, put, patch,
    orgId,
    branchByCode,
    warehouseByBranch,
    taxByName,
    productBySku,
    productMeta: new Map(PRODUCTS.map((p) => [p[1], { tier: p[6], trackStock: p[7], category: p[3], sell: p[5] }])),
    me,
    org,
  };
}

main()
  .then(async (state) => {
    if (!state) return;
    const { seedTrading, seedPurchasing, seedTill, printSummary } = await import("./seed-demo-org-parts.mjs");
    await seedTrading(state);
    await seedPurchasing(state);
    await seedTill(state);
    printSummary(state);
  })
  .catch((err) => {
    console.error(`\n  FAILED: ${err.message}\n`);
    process.exit(1);
  });
