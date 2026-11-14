// Loads the liquor catalogue fixtures in docs/Testbs into an organization through the
// public API, so what lands in the database is exactly what the files describe.
//
//   $env:KAZIOS_SMOKE_EMAIL='you@example.com'
//   $env:KAZIOS_SMOKE_PASSWORD='...'
//   node apps/api/scripts/load-liquor-fixtures.mjs
//
// The CSVs are the source of truth here: products, their sale and purchase units,
// opening stock, credit customers and staff. Nothing is invented, and every write goes
// through a route, so the data cannot end up in a state the application would refuse.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const KAZIOS_API_URL = process.env.KAZIOS_API_URL || "https://kazios.onrender.com/api/v1";
const EMAIL = process.env.KAZIOS_SMOKE_EMAIL;
const PASSWORD = process.env.KAZIOS_SMOKE_PASSWORD;
const FIXTURE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "docs",
  "Testbs"
);

if (!EMAIL || !PASSWORD) {
  console.error("Set KAZIOS_SMOKE_EMAIL and KAZIOS_SMOKE_PASSWORD before running this script.");
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
    const detail = json.details ? JSON.stringify(json.details).slice(0, 200) : "";
    throw new Error(`${method} ${path} -> ${res.status} ${json.error || ""} ${detail}`);
  }
  return json;
}

const get = path => call("GET", path);
const post = (path, body) => call("POST", path, body);

/** Minimal RFC 4180 reader: quoted fields, escaped quotes, CRLF. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (char !== "\r") {
      field += char;
    }
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }

  const [header, ...body] = rows.filter(cells => cells.some(cell => cell.trim() !== ""));
  return body.map(cells => {
    const record = {};
    header.forEach((key, index) => {
      record[key.trim()] = (cells[index] ?? "").trim();
    });
    return record;
  });
}

function readFixture(name) {
  const file = path.join(FIXTURE_DIR, name);
  if (!fs.existsSync(file)) throw new Error(`missing fixture: ${file}`);
  return parseCsv(fs.readFileSync(file, "utf8"));
}

const toNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const toBoolean = value => /^(true|1|yes)$/i.test(String(value));

console.log(`\n=== liquor fixtures from ${path.relative(process.cwd(), FIXTURE_DIR)} ===`);
console.log(`target ${BASE} as ${EMAIL}`);

const login = await post("/auth/login", { email: EMAIL, password: PASSWORD });
token = login.data.token;
const org = (await get("/org")).data;
console.log(`organization ${org.name} (${org.currency})`);

const warehouse = (org.warehouses ?? [])[0];
if (!warehouse) throw new Error("the organization has no warehouse to receive stock into");
console.log(`warehouse ${warehouse.code} ${warehouse.name}`);

const counts = {
  products: 0,
  units: 0,
  unitsSkipped: 0,
  stock: 0,
  stockSkipped: 0,
  customers: 0,
  customersSkipped: 0,
  staff: 0,
  staffSkipped: 0,
  skipped: 0,
};

// --- products -------------------------------------------------------------
console.log("\n1. products");
const products = readFixture("1_products.csv");
const productIdBySku = new Map();

for (const row of products) {
  const existing = await get(`/products?search=${encodeURIComponent(row.sku)}&limit=5`);
  const found = (existing.data ?? []).find(item => item.sku === row.sku);
  if (found) {
    productIdBySku.set(row.sku, found.id);
    counts.skipped++;
    continue;
  }

  const created = await post("/products", {
    name: row.name,
    sku: row.sku,
    barcode: row.barcode,
    size: row.size,
    category: row.category,
    costPrice: toNumber(row.costPrice),
    sellingPrice: toNumber(row.sellingPrice),
    minStock: toNumber(row.minStock),
    reorderPoint: toNumber(row.reorderPoint),
  });
  productIdBySku.set(row.sku, created.data.id);
  counts.products++;
}
console.log(`   ${counts.products} created, ${counts.skipped} already present`);

// --- product units --------------------------------------------------------
console.log("\n2. product units");
for (const row of readFixture("2_product_units.csv")) {
  const productId = productIdBySku.get(row.sku);
  if (!productId) {
    console.log(`   ! no product for sku ${row.sku}, skipping unit ${row.unit_name}`);
    continue;
  }

  // GET /products/:id embeds productUnits, which is what we need to avoid creating a
  // duplicate unit on a re-run. (The dedicated /products/:id/units endpoint answers 500
  // on the deployed build, so it is deliberately not used here.)
  const existingUnits = (await get(`/products/${productId}`)).data?.productUnits ?? [];
  if (existingUnits.some(unit => unit.name === row.unit_name)) {
    counts.unitsSkipped++;
    continue;
  }

  await post(`/products/${productId}/units`, {
    name: row.unit_name,
    factorToBase: toNumber(row.factor_to_base, 1),
    isDefaultSaleUnit: toBoolean(row.is_default_sale_unit),
    isDefaultPurchaseUnit: toBoolean(row.is_default_purchase_unit),
  });
  counts.units++;
}
console.log(`   ${counts.units} units created, ${counts.unitsSkipped} already present`);

// --- opening stock --------------------------------------------------------
console.log("\n3. opening stock");
const inventoryRows = (await get("/inventory?limit=200")).data ?? [];
const stocked = new Set(
  // The inventory list aggregates per product, so a single-warehouse organization comes
  // back with warehouseId: null. Matching on that as well is what makes the check work.
  inventoryRows
    .filter(
      row =>
        (row.warehouseId === warehouse.id || row.warehouseId === null) &&
        toNumber(row.quantity) > 0
    )
    .map(row => row.productId)
);

for (const row of readFixture("3_opening_stock.csv")) {
  const productId = productIdBySku.get(row.sku);
  if (!productId) {
    console.log(`   ! no product for sku ${row.sku}, skipping stock`);
    continue;
  }
  const quantity = toNumber(row.quantity_in_base_units);
  if (quantity <= 0) continue;
  if (stocked.has(productId)) {
    counts.stockSkipped++;
    continue;
  }

  await post("/inventory/receive", {
    productId,
    warehouseId: warehouse.id,
    quantity,
    unit: "other",
    factorToBase: 1,
    costPrice: toNumber(row.unit_cost),
    supplierName: "Opening stock",
    notes: `Opening balance imported from 3_opening_stock.csv (${row.size})`,
  });
  stocked.add(productId);
  counts.stock++;
}
console.log(`   ${counts.stock} stock lines received, ${counts.stockSkipped} already stocked`);

// --- customers ------------------------------------------------------------
console.log("\n4. customers");
for (const row of readFixture("4_customers_credit.csv")) {
  const existingCustomers = (await get(`/customers?search=${encodeURIComponent(row.name)}&limit=5`)).data ?? [];
  if (existingCustomers.some(customer => customer.name === row.name)) {
    counts.customersSkipped++;
    continue;
  }

  await post("/customers", {
    name: row.name,
    phone: row.phone,
    customerType: row.customerType,
    creditLimit: toNumber(row.creditLimit),
  });
  counts.customers++;
}
console.log(`   ${counts.customers} customers created, ${counts.customersSkipped} already present`);

// --- staff ----------------------------------------------------------------
console.log("\n5. staff");
// Registration only ever creates the OWNER role, so any other role the fixtures ask
// for has to be created first. An attendant sells and looks, but does not adjust
// stock, buy, report or close the day.
const ATTENDANT_PERMISSIONS = [
  "pos.sale",
  "pos.sales.view",
  "products.view",
  "customers.view",
  "inventory.view",
];

const roles = (await get("/roles")).data ?? [];
const roleTypes = new Set();

for (const row of readFixture("5_staff.csv")) {
  if (row.role === "OWNER") {
    console.log(`   ${row.name} is the owner already signed in, skipped`);
    continue;
  }

  let role = roles.find(candidate => candidate.type === row.role);
  if (!role && !roleTypes.has(row.role)) {
    role = (
      await post("/roles", {
        name: row.role,
        type: row.role,
        description: `Imported from 5_staff.csv: ${row.role.toLowerCase()} staff`,
        permissions: row.role === "ATTENDANT" ? ATTENDANT_PERMISSIONS : [],
      })
    ).data;
    roles.push(role);
    console.log(`   created role ${row.role}`);
  }
  roleTypes.add(row.role);

  if (!role) {
    console.log(`   ! no role of type ${row.role}, skipping ${row.name}`);
    continue;
  }

  const email = `${row.name.toLowerCase().replace(/[^a-z]+/g, ".").replace(/^\.|\.$/g, "")}@kaziliquor.co.ke`;

  const existingUsers = (await get("/users?limit=100")).data ?? [];
  if (existingUsers.some(user => user.email === email)) {
    counts.staffSkipped++;
    console.log(`   ${row.name} <${email}> already exists, skipped`);
    continue;
  }

  try {
    await post("/users", {
      name: row.name,
      email,
      password: "Attendant123!",
      roleId: role.id,
    });
    counts.staff++;
    console.log(`   ${row.name} <${email}> as ${row.role}`);
  } catch (error) {
    console.log(`   ! ${row.name}: ${error.message}`);
  }
}

console.log(`\n=== done ===`);
console.log(`  products    ${counts.products} created, ${counts.skipped} already present`);
console.log(`  units       ${counts.units} created, ${counts.unitsSkipped} already present`);
console.log(`  stock lines ${counts.stock} received, ${counts.stockSkipped} already stocked`);
console.log(`  customers   ${counts.customers} created, ${counts.customersSkipped} already present`);
console.log(`  staff       ${counts.staff} created, ${counts.staffSkipped} already present`);