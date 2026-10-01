// Seeds the MathewTech production organization with a realistic multi branch
// trading business so every feature can be exercised end to end.
//
//   $env:KAZIOS_SMOKE_EMAIL='you@example.com'
//   $env:KAZIOS_SMOKE_PASSWORD='...'
//   node apps/api/scripts/seed-production.mjs            # dry run, prints the plan
//   node apps/api/scripts/seed-production.mjs --apply    # do it
//
// Credentials are read from the environment with no fallback on purpose. A password
// committed to a repository is a leaked password, so this script refuses to run rather
// than carry a default that would quietly end up in Git history.
//
// It authenticates as a normal user through the public API, exactly as the browser
// does, so it can never write something the application itself would refuse.
const KAZIOS_API_URL = process.env.KAZIOS_API_URL || "https://kazios.onrender.com/api/v1";
const KAZIOS_SMOKE_EMAIL = process.env.KAZIOS_SMOKE_EMAIL;
const KAZIOS_SMOKE_PASSWORD = process.env.KAZIOS_SMOKE_PASSWORD;
const apply = process.argv.includes("--apply");

if (!KAZIOS_SMOKE_EMAIL || !KAZIOS_SMOKE_PASSWORD) {
  console.error(
    "Set KAZIOS_SMOKE_EMAIL and KAZIOS_SMOKE_PASSWORD before running this script.\n" +
      "Credentials are intentionally not built in."
  );
  process.exit(1);
}

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
    json = { error: text.slice(0, 200) };
  }
  if (!res.ok) {
    const message = json.error || `${res.status}`;
    const detail = json.details ? JSON.stringify(json.details).slice(0, 200) : "";
    throw new Error(`${method} ${path} -> ${res.status} ${message} ${detail}`);
  }
  return json;
}

const get = (path) => call("GET", path);
const post = (path, body) => call("POST", path, body);
const patch = (path, body) => call("PATCH", path, body);

// Four Kenyan branches, each with its own warehouse, so stock can be moved between
// them and each branch can trade independently.
const BRANCHES = [
  { name: "Nairobi Head Office", code: "NRB", address: "Kenyatta Avenue, Nairobi", phone: "+254202000001" },
  { name: "Mombasa Branch", code: "MBA", address: "Nkrumah Road, Mombasa", phone: "+254202000002" },
  { name: "Kisumu Branch", code: "KSM", address: "Oginga Odinga Street, Kisumu", phone: "+254202000003" },
  { name: "Nakuru Branch", code: "NKR", address: "Kenyatta Avenue, Nakuru", phone: "+254202000004" },
];

const CATEGORIES = ["Groceries", "Beverages", "Bakery", "Household", "Personal Care", "Stationery"];

// A wholesaler trading across the four branches: cost, selling price and the unit a
// cashier will scan or read off the shelf.
const PRODUCTS = [
  { name: "Maize Flour 2kg", category: "Groceries", cost: 120, price: 180, sku: "GRC-MAIZE-2KG", barcode: "6001000000101" },
  { name: "Rice 5kg", category: "Groceries", cost: 550, price: 750, sku: "GRC-RICE-5KG", barcode: "6001000000102" },
  { name: "Sugar 1kg", category: "Groceries", cost: 130, price: 175, sku: "GRC-SUGAR-1KG", barcode: "6001000000103" },
  { name: "Cooking Oil 500ml", category: "Groceries", cost: 240, price: 320, sku: "GRC-OIL-500ML", barcode: "6001000000104" },
  { name: "Wheat Flour 1kg", category: "Groceries", cost: 95, price: 130, sku: "GRC-WHEAT-1KG", barcode: "6001000000105" },
  { name: "Table Salt 500g", category: "Groceries", cost: 45, price: 70, sku: "GRC-SALT-500G", barcode: "6001000000106" },
  { name: "Baking Beans 400g", category: "Groceries", cost: 160, price: 215, sku: "GRC-BEANS-400G", barcode: "6001000000107" },
  { name: "Groundnut Oil 1L", category: "Groceries", cost: 420, price: 540, sku: "GRC-GNOIL-1L", barcode: "6001000000108" },
  { name: "Tea Leaves 250g", category: "Beverages", cost: 280, price: 370, sku: "BEV-TEA-250G", barcode: "6001000000201" },
  { name: "Coffee Powder 100g", category: "Beverages", cost: 340, price: 450, sku: "BEV-COFFEE-100G", barcode: "6001000000202" },
  { name: "Cola 350ml", category: "Beverages", cost: 70, price: 100, sku: "BEV-COLA-350ML", barcode: "6001000000203" },
  { name: "Orange Juice 1L", category: "Beverages", cost: 180, price: 250, sku: "BEV-OJ-1L", barcode: "6001000000204" },
  { name: "Mineral Water 500ml", category: "Beverages", cost: 20, price: 35, sku: "BEV-WATER-500ML", barcode: "6001000000205" },
  { name: "Energy Drink 250ml", category: "Beverages", cost: 110, price: 150, sku: "BEV-ENERGY-250ML", barcode: "6001000000206" },
  { name: "White Bread", category: "Bakery", cost: 60, price: 90, sku: "BAK-BREAD-WHITE", barcode: "6001000000301" },
  { name: "Brown Bread", category: "Bakery", cost: 80, price: 115, sku: "BAK-BREAD-BROWN", barcode: "6001000000302" },
  { name: "Wholemeal Loaf", category: "Bakery", cost: 95, price: 135, sku: "BAK-BREAD-WHOLE", barcode: "6001000000303" },
  { name: "Milk 500ml", category: "Bakery", cost: 70, price: 100, sku: "BAK-MILK-500ML", barcode: "6001000000304" },
  { name: "Dishwashing Liquid 1L", category: "Household", cost: 190, price: 260, sku: "HHD-DISH-1L", barcode: "6001000000401" },
  { name: "Laundry Powder 1kg", category: "Household", cost: 320, price: 420, sku: "HHD-LAUNDRY-1KG", barcode: "6001000000402" },
  { name: "Toilet Paper 4 rolls", category: "Household", cost: 210, price: 290, sku: "HHD-TOILET-4", barcode: "6001000000403" },
  { name: "Hand Soap 500ml", category: "Household", cost: 150, price: 210, sku: "HHD-SOAP-500ML", barcode: "6001000000404" },
  { name: "Broom", category: "Household", cost: 250, price: 350, sku: "HHD-BROOM", barcode: "6001000000405" },
  { name: "Bar Soap 800g", category: "Personal Care", cost: 130, price: 185, sku: "PCE-SOAP-800G", barcode: "6001000000501" },
  { name: "Toothpaste 100ml", category: "Personal Care", cost: 175, price: 240, sku: "PCE-TOOTHPASTE-100", barcode: "6001000000502" },
  { name: "Shampoo 400ml", category: "Personal Care", cost: 380, price: 490, sku: "PCE-SHAMPOO-400", barcode: "6001000000503" },
  { name: "Body Lotion 200ml", category: "Personal Care", cost: 290, price: 380, sku: "PCE-LOTION-200", barcode: "6001000000504" },
  { name: "Sanitary Pads (pack)", category: "Personal Care", cost: 220, price: 300, sku: "PCE-PADS-PACK", barcode: "6001000000505" },
  { name: "Exercise Book A4", category: "Stationery", cost: 90, price: 130, sku: "STA-EXBOOK-A4", barcode: "6001000000601" },
  { name: "Ballpoint Pens (dozen)", category: "Stationery", cost: 180, price: 250, sku: "STA-PENS-12", barcode: "6001000000602" },
  { name: "A4 Ream 500 sheets", category: "Stationery", cost: 1250, price: 1550, sku: "STA-A4-REAM", barcode: "6001000000603" },
  { name: "Office Printer Paper", category: "Stationery", cost: 1450, price: 1800, sku: "STA-PRINTER-A4", barcode: "6001000000604" },
  { name: "Notebook 200 pages", category: "Stationery", cost: 160, price: 220, sku: "STA-NOTEBOOK-200", barcode: "6001000000605" },
  { name: "Stapler", category: "Stationery", cost: 320, price: 420, sku: "STA-STAPLER", barcode: "6001000000606" },
];


const CUSTOMERS = [
  { name: "Nairobi Supermarket Ltd", email: "purchasing@nairobisuper.co.ke", phone: "+254711000001", address: "Westlands, Nairobi", taxNumber: "KE-100200300" },
  { name: "Mombasa Wholesalers", email: "orders@mombasawholesalers.co.ke", phone: "+254711000002", address: "Nkrumah Road, Mombasa", taxNumber: "KE-100200301" },
  { name: "Kisumu Retail Hub", email: "info@kisumuretail.co.ke", phone: "+254711000003", address: "Oginga Odinga St, Kisumu", taxNumber: "KE-100200302" },
  { name: "Nakuru Traders", email: "buy@nakurutraders.co.ke", phone: "+254711000004", address: "Kenyatta Ave, Nakuru", taxNumber: "KE-100200303" },
  { name: "Karen Groceries", email: "karen@karengroceries.co.ke", phone: "+254711000005", address: "Karen, Nairobi" },
  { name: "Eastleigh Mini Mart", email: "eastleigh@mini.co.ke", phone: "+254711000006", address: "Eastleigh, Nairobi" },
  { name: "Nyali Beach Shop", email: "nyali@beachshop.co.ke", phone: "+254711000007", address: "Nyali, Mombasa" },
  { name: "Bamburi Stores", email: "bamburi@stores.co.ke", phone: "+254711000008", address: "Bamburi, Mombasa" },
  { name: "Kisumu Central Mart", email: "central@kisumumart.co.ke", phone: "+254711000009", address: "Kisumu" },
  { name: "Nakuru Mega Shop", email: "mega@nakurumega.co.ke", phone: "+254711000010", address: "Nakuru" },
  { name: "Rongai Corner Shop", email: "rongai@cornershop.co.ke", phone: "+254711000011", address: "Rongai, Nairobi" },
  { name: "Thika Traders", email: "thika@traders.co.ke", phone: "+254711000012", address: "Thika, Nairobi" },
  { name: "Kapsabet Kiosk", email: "kapsabet@kiosk.co.ke", phone: "+254711000013", address: "Kapsabet" },
  { name: "Malindi Resort Supplies", email: "supply@malindiresort.co.ke", phone: "+254711000014", address: "Malindi" },
  { name: "Kitengela Grocer", email: "kitengela@grocer.co.ke", phone: "+254711000015", address: "Kitengela" },
];

const SUPPLIERS = [
  { name: "Lake Basin Distributors", email: "sales@lakebasin.co.ke", phone: "+254722000001", address: "Kisumu", taxNumber: "KE-400500600" },
  { name: "Coastal Wholesale Ltd", email: "orders@coastalwholesale.co.ke", phone: "+254722000002", address: "Mombasa", taxNumber: "KE-400500601" },
  { name: "Highland Agri Supply", email: "info@highlandagri.co.ke", phone: "+254722000003", address: "Nakuru", taxNumber: "KE-400500602" },
  { name: "Nairobi Central Traders", email: "hello@nairob traders.co.ke".replace(" ", ""), phone: "+254722000004", address: "Nairobi", taxNumber: "KE-400500603" },
  { name: "Rift Valley Beverages", email: "bev@riftvalley.co.ke", phone: "+254722000005", address: "Nakuru", taxNumber: "KE-400500604" },
  { name: "Mombasa Bakery Supplies", email: "bakery@mbasa.co.ke", phone: "+254722000006", address: "Mombasa", taxNumber: "KE-400500605" },
  { name: "Savannah Packaging", email: "pack@savannah.co.ke", phone: "+254722000007", address: "Nairobi", taxNumber: "KE-400500606" },
  { name: "Western Fast Movers", email: "fast@westernfm.co.ke", phone: "+254722000008", address: "Kisumu", taxNumber: "KE-400500607" },
];


console.log(`\n=== seeding ${KAZIOS_SMOKE_EMAIL} at ${BASE} ===`);

const login = await post("/auth/login", { email: KAZIOS_SMOKE_EMAIL, password: KAZIOS_SMOKE_PASSWORD });
token = login.data.token;
const me = login.data.user;
const org = (await get("/org")).data;
console.log(`signed in as ${me.name}, organization ${org.name} (${org.currency})`);

const existing = {
  products: (await get("/products?limit=200")).total ?? 0,
  customers: (await get("/customers?limit=200")).total ?? 0,
  suppliers: (await get("/suppliers?limit=200")).total ?? 0,
};
console.log(`already has: ${existing.products} products, ${existing.customers} customers, ${existing.suppliers} suppliers`);

if (existing.products > 5) {
  console.log("\nThis organization is already populated. Nothing to do.");
  process.exit(0);
}

if (!apply) {
  console.log(`
DRY RUN. This would create:
  ${BRANCHES.length} branches and ${BRANCHES.length} warehouses (one per branch)
  ${PRODUCTS.length} products across ${CATEGORIES.length} categories
  ${CUSTOMERS.length} customers, ${SUPPLIERS.length} suppliers
  opening stock in every warehouse, purchase orders, invoices and payments

Re-run with --apply to do it.`);
  process.exit(0);
}

const created = { branches: [], warehouses: [], products: [], customers: [], suppliers: [], invoices: 0, payments: 0, adjustments: 0, orders: 0 };

// --- branches and a warehouse for each -----------------------------------
console.log("\n1. branches and warehouses");
const existingBranches = org.branches ?? [];
for (const branch of BRANCHES) {
  const found = existingBranches.find((b) => b.code === branch.code);
  if (found) {
    created.branches.push(found);
    console.log(`   ${branch.code} already exists`);
  } else {
    const res = await post("/org/branches", branch);
    created.branches.push(res.data);
    console.log(`   created ${branch.code} ${branch.name}`);
  }
}

const existingWarehouses = org.warehouses ?? [];
for (const [index, branch] of created.branches.entries()) {
  const code = `WH-${String(index + 1).padStart(2, "0")}`;
  const found = existingWarehouses.find((w) => w.code === code);
  if (found) {
    created.warehouses.push(found);
    console.log(`   ${code} already exists`);
  } else {
    const res = await post("/org/warehouses", {
      name: `${branch.name} Warehouse`,
      code,
      address: branch.address,
      branchId: branch.id,
    });
    created.warehouses.push(res.data);
    console.log(`   created ${code}`);
  }
}


// --- tax category --------------------------------------------------------
console.log("\n2. tax category");
const taxCategories = (await get("/tax-categories")).data ?? [];
let vat = taxCategories.find((t) => t.name === "VAT 16%");
if (!vat) {
  vat = (await post("/tax-categories", { name: "VAT 16%", rate: 16, mode: "EXCLUSIVE" })).data;
  console.log("   created VAT 16%");
} else {
  console.log("   VAT 16% already exists");
}

// --- products ------------------------------------------------------------
console.log("\n3. products");
for (const item of PRODUCTS) {
  const res = await post("/products", {
    name: item.name,
    sku: item.sku,
    barcode: item.barcode,
    costPrice: item.cost,
    sellingPrice: item.price,
    productType: "PHYSICAL",
    minStock: 20,
    reorderPoint: 10,
    taxCategoryId: vat.id,
  });
  created.products.push(res.data);
  console.log(`   ${item.sku} ${item.name}`);
}

// --- customers and suppliers --------------------------------------------
console.log("\n4. customers");
for (const person of CUSTOMERS) {
  const res = await post("/customers", person);
  created.customers.push(res.data);
}
console.log(`   created ${created.customers.length} customers`);

console.log("5. suppliers");
for (const supplier of SUPPLIERS) {
  const res = await post("/suppliers", supplier);
  created.suppliers.push(res.data);
}
console.log(`   created ${created.suppliers.length} suppliers`);


// --- opening stock in every warehouse -----------------------------------
// Each branch gets a different depth of stock so the inventory screens have something
// to show and a transfer between branches has a real reason to exist.
console.log("\n6. opening stock");
const depth = [60, 40, 25, 15];
for (const [index, warehouse] of created.warehouses.entries()) {
  let count = 0;
  for (const [productIndex, product] of created.products.entries()) {
    // Nairobi carries the most, Nakuru the least, and stock rotates so the two are not
    // identical lists.
    const base = depth[index];
    const spread = 1 + ((productIndex + index) % 5);
    const quantity = Math.max(5, Math.round((base * spread) / 3));
    try {
      await post("/inventory/adjustments", {
        productId: product.id,
        warehouseId: warehouse.id,
        quantity,
        reason: `Opening stock for ${warehouse.name}`,
        adjustmentType: "INCREASE",
      });
      created.adjustments += 1;
      count += 1;
    } catch (err) {
      console.log(`   skipped ${product.sku} in ${warehouse.code}: ${err.message}`);
    }
  }
  console.log(`   ${warehouse.code}: ${count} products stocked`);
}

// --- purchase orders -----------------------------------------------------
console.log("\n7. purchase orders");
for (let round = 0; round < 3; round += 1) {
  const supplier = created.suppliers[round % created.suppliers.length];
  const picks = created.products.slice(round * 4, round * 4 + 4);
  const order = await post("/purchase-orders", {
    supplierId: supplier.id,
    warehouseId: created.warehouses[round % created.warehouses.length].id,
    taxRate: 16,
    notes: `Restock round ${round + 1} from ${supplier.name}`,
    items: picks.map((product) => {
      const source = PRODUCTS.find((p) => p.sku === product.sku);
      return { productId: product.id, quantity: 20 + round * 5, unitPrice: source.cost };
    }),
  });
  // A draft and a sent order, so both sides of the lifecycle can be looked at.
  if (round > 0) {
    await post(`/purchase-orders/${order.data.id}/send`, {});
  }
  created.orders += 1;
  console.log(`   ${order.data.poNumber} ${order.data.status} from ${supplier.name}`);
}


// --- invoices and payments ----------------------------------------------
// A spread of statuses so every filter and every report has something in it.
console.log("\n8. invoices and payments");
const iso = (daysAgo) => new Date(Date.now() - daysAgo * 86400000).toISOString();

for (let round = 0; round < 8; round += 1) {
  const customer = created.customers[round % created.customers.length];
  const picks = created.products.slice(round * 3, round * 3 + 3);
  const items = picks.map((product) => {
    const source = PRODUCTS.find((p) => p.sku === product.sku);
    return {
      productId: product.id,
      description: product.name,
      quantity: 2 + (round % 4),
      unitPrice: source.price,
      discountAmount: round % 3 === 0 ? 50 : 0,
      taxRate: 16,
    };
  });

  try {
    const invoice = (
      await post("/invoices", {
        customerId: customer.id,
        issueDate: iso(round * 5 + 1),
        dueDate: iso(-30 + round * 5),
        currency: "KES",
        items,
        notes: `Order round ${round + 1}`,
      })
    ).data;
    created.invoices += 1;

    // Round 0 is a draft, round 1 is sent and unpaid, the rest are paid.
    if (round === 0) {
      console.log(`   ${invoice.invoiceNumber} DRAFT`);
      continue;
    }
    await post(`/invoices/${invoice.id}/send`, {});

    if (round >= 2) {
      // The payment is the full total, which the server recalculated.
      const detail = (await get(`/invoices/${invoice.id}`)).data;
      await post("/payments", {
        amount: detail.total,
        currency: "KES",
        // MPESA is the everyday mobile money rail in Kenya, so the ledger shows both a
        // bank transfer and a phone payment the way a real shop would.
        paymentProvider: round % 2 === 0 ? "BANK" : "MPESA",
        paymentMethodType: round % 2 === 0 ? "bank_transfer" : "mobile_money",
        invoiceId: invoice.id,
        customerId: customer.id,
        reference: `PAY-${invoice.invoiceNumber}`,
        notes: `Settlement for ${invoice.invoiceNumber}`,
      });
      created.payments += 1;
      console.log(`   ${invoice.invoiceNumber} SENT + paid (KES ${detail.total})`);
    } else {
      console.log(`   ${invoice.invoiceNumber} SENT, awaiting payment`);
    }
  } catch (err) {
    console.log(`   invoice round ${round + 1} failed: ${err.message}`);
  }
}

console.log(`
=== done ===
  branches      ${created.branches.length}
  warehouses    ${created.warehouses.length}
  products      ${created.products.length}
  customers     ${created.customers.length}
  suppliers     ${created.suppliers.length}
  stock moves   ${created.adjustments}
  purchase ords ${created.orders}
  invoices      ${created.invoices}
  payments      ${created.payments}
`);

const del = (path) => call("DELETE", path);
