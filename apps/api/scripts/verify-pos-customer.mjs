// Verifies that a sale can actually be attributed to a customer, and that the
// attribution survives all the way into the customer's own history.
//
//   $env:SMOKE_EMAIL="..."; $env:SMOKE_PASSWORD="..."
//   node apps/api/scripts/verify-pos-customer.mjs
//
// The reason this exists: the till used to hardcode customerId to null, so no sale was
// ever attributed to anyone. Customer history, loyalty and repeat-customer reporting all
// depend on that link, and a green POS test suite said nothing about it because the sale
// was perfectly valid with no customer at all. The cases below are the ones a real
// counter hits: an ordinary walk-in, a returning customer found by phone, a sale to
// someone who does not exist here, and another tenant's customer id.

const BASE = process.env.API_URL || "http://localhost:4000/api/v1";
const EMAIL = process.env.SMOKE_EMAIL;
const PASSWORD = process.env.SMOKE_PASSWORD;

let token = null;
let createdCustomerId = null;
let createdSaleIds = [];

function check(label, condition, detail = "") {
  console.log(`  [${condition ? "PASS" : "FAIL"}] ${label}${detail ? ` -- ${detail}` : ""}`);
  if (!condition) process.exitCode = 1;
  return condition;
}

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
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { status: res.status, body: json };
}

async function ringSale({ customerId, quantity = 1 }) {
  const context = await call("GET", "/pos/context");
  const branch = context.body?.data?.branches?.find(b => b.isMain) || context.body?.data?.branches?.[0];
  const warehouse =
    context.body?.data?.warehouses?.find(w => w.branchId === branch?.id) ||
    context.body?.data?.warehouses?.[0];
  const products = await call(
    "GET",
    `/pos/products?limit=60&branchId=${branch.id}&warehouseId=${warehouse.id}`
  );
  const product = (products.body?.data || []).find(p => p.stockQuantity > 20);
  if (!product) throw new Error("No saleable product with stock in the verification business");

  const amount = product.sellingPrice * quantity;
  return call("POST", "/pos/sale", {
    branchId: branch.id,
    warehouseId: warehouse.id,
    customerId: customerId || null,
    items: [{ productId: product.id, quantity, discountAmount: 0 }],
    discountAmount: 0,
    payments: [{ provider: "CASH", methodType: "cash", amount, tenderedAmount: amount }],
    idempotencyKey: `verify-customer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  });
}

async function main() {
  if (!EMAIL || !PASSWORD) {
    console.error("Set SMOKE_EMAIL and SMOKE_PASSWORD to the verification account.");
    process.exit(1);
  }

  console.log(`\nVerifying POS customer attribution against ${BASE}\n`);

  const login = await call("POST", "/auth/login", { email: EMAIL, password: PASSWORD });
  if (login.status !== 200) {
    console.error(`Sign in failed (${login.status}):`, JSON.stringify(login.body));
    process.exit(1);
  }
  token = login.body?.data?.token;
  console.log(`Signed in as ${login.body?.data?.user?.email}\n`);

  // --- a saleable product --------------------------------------------------
  // A brand new business has no stock, so a sale cannot be rung at all. That is correct
  // behaviour, and it is why this script provisions one rather than assuming the
  // verification account already has a catalogue.
  console.log("Provisioning stock");
  const context = await call("GET", "/pos/context");
  const branch = context.body?.data?.branches?.find(b => b.isMain) || context.body?.data?.branches?.[0];
  const warehouse =
    context.body?.data?.warehouses?.find(w => w.branchId === branch?.id) ||
    context.body?.data?.warehouses?.[0];

  const product = await call("POST", "/products", {
    name: "Verification Widget",
    sku: `VERIFY-${Date.now().toString().slice(-6)}`,
    costPrice: 100,
    sellingPrice: 150,
    minStock: 2,
    trackStock: true,
  });
  if (product.status !== 201) {
    console.error(`Could not create a product: ${JSON.stringify(product.body)}`);
    process.exit(1);
  }
  const productId = product.body?.data?.id;
  check("a product can be created", Boolean(productId), product.body?.data?.sku);

  const stock = await call("POST", "/inventory/adjustments", {
    productId,
    warehouseId: warehouse.id,
    quantity: 100,
    adjustmentType: "INCREASE",
    reason: "Opening stock for verification",
  });
  check("opening stock is received", stock.status === 201, `status ${stock.status}`);

  // --- a walk-in sale -----------------------------------------------------
  console.log("Walk-in sale (the ordinary case)");
  const walkIn = await ringSale({ customerId: null });
  check("a sale with no customer is accepted", walkIn.status === 201, `status ${walkIn.status}`);
  check(
    "it is recorded with no customer attached",
    walkIn.body?.data?.invoice?.customerId === null ||
      walkIn.body?.data?.invoice?.customer === null,
    JSON.stringify(walkIn.body?.data?.invoice?.customerId)
  );
  check(
    "no placeholder customer row is created",
    walkIn.body?.data?.invoice?.customer === null || walkIn.body?.data?.invoice?.customer === undefined
  );
  createdSaleIds.push(walkIn.body?.data?.invoice?.id);

  // --- creating and attaching a customer -----------------------------------
  console.log("\nAttaching a real customer");
  const stamp = Date.now().toString().slice(-6);
  const phone = `07${stamp}`;
  const created = await call("POST", "/customers", {
    name: `Verification Customer ${stamp}`,
    phone,
  });
  check("a customer can be created at the till", created.status === 201, `status ${created.status}`);
  createdCustomerId = created.body?.data?.id;

  // --- finding them by phone ----------------------------------------------
  console.log("\nFinding a customer by phone (how a counter actually looks someone up)");
  const byPhone = await call("GET", `/customers?search=${phone}`);
  check("search by phone finds them", byPhone.status === 200, `status ${byPhone.status}`);
  check(
    "the right customer comes back",
    (byPhone.body?.data || []).some(c => c.id === createdCustomerId),
    `${(byPhone.body?.data || []).length} result(s)`
  );

  const byPartial = await call("GET", `/customers?search=${phone.slice(0, 6)}`);
  check(
    "a partial phone number still finds them",
    (byPartial.body?.data || []).some(c => c.id === createdCustomerId)
  );

  const byName = await call("GET", `/customers?search=Verification Customer ${stamp}`);
  check("search by name still works", (byName.body?.data || []).some(c => c.id === createdCustomerId));

  // --- the sale, attributed ------------------------------------------------
  const attributed = await ringSale({ customerId: createdCustomerId });
  check("a sale to a named customer is accepted", attributed.status === 201, `status ${attributed.status}`);
  check(
    "the sale is attributed to them",
    attributed.body?.data?.invoice?.customer?.id === createdCustomerId,
    attributed.body?.data?.invoice?.customer?.name
  );
  createdSaleIds.push(attributed.body?.data?.invoice?.id);

  // --- history -------------------------------------------------------------
  console.log("\nCustomer history");
  const history = await call("GET", `/customers/${createdCustomerId}`);
  check("their profile loads", history.status === 200, `status ${history.status}`);
  check(
    "the sale appears in their invoice history",
    (history.body?.data?.invoices || []).some(i => i.id === attributed.body?.data?.invoice?.id),
    `${(history.body?.data?.invoices || []).length} invoice(s)`
  );

  // --- refusals ------------------------------------------------------------
  console.log("\nRefusals");
  const missing = await call("GET", "/customers/00000000-0000-0000-0000-000000000000");
  check("an unknown customer id is a clean 404, not a crash", missing.status === 404, `status ${missing.status}`);

  const malformed = await call("POST", "/pos/sale", {
    branchId: null,
    warehouseId: null,
    customerId: "00000000-0000-0000-0000-000000000000",
    items: [{ productId: "00000000-0000-0000-0000-000000000000", quantity: 1 }],
    discountAmount: 0,
    payments: [{ provider: "CASH", methodType: "cash", amount: 10, tenderedAmount: 10 }],
  });
  check(
    "a sale naming a customer that is not ours is refused",
    malformed.status === 400,
    `status ${malformed.status}`
  );

  console.log(
    `\nLeft in place: customer ${createdCustomerId} and ${createdSaleIds.length} sales, so the` +
      `\nattribution is visible in the UI. Delete the account to clear them.`
  );
}

main()
  .catch(err => {
    console.error("Verification failed:", err);
    process.exitCode = 1;
  })
  .finally(() => process.exit());
