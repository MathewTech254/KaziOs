// Rings one real sale through the public POS API, the same way the till does, and
// reports the server's own numbers back. Used to prove the demo data is live.
const BASE = process.env.KAZIOS_API_URL || "http://localhost:4000/api/v1";
const EMAIL = process.env.KAZIOS_SMOKE_EMAIL || "admin@kazios.dev";
const PASSWORD = process.env.KAZIOS_SMOKE_PASSWORD || "admin123";

async function call(method, path, body, token) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(json)}`);
  return json;
}

const main = async () => {
  const { data: login } = await call("POST", "/auth/login", { email: EMAIL, password: PASSWORD });
  const token = login.token;

  const { data: ctx } = await call("GET", "/pos/context", null, token);
  const branch = ctx.branches.find((b) => b.name === "Westlands") || ctx.branches[0];
  const warehouse = ctx.warehouses.find((w) => w.name === `${branch.name} Store`) || ctx.warehouses[0];
  console.log(`till: ${branch.name} / ${warehouse.name}`);

  const { data: products } = await call(
    "GET",
    `/pos/products?warehouseId=${warehouse.id}&limit=50`,
    null,
    token
  );
  const product = products.find((p) => p.stockStatus === "IN_STOCK" && p.trackStock);
  if (!product) throw new Error("no in-stock product to sell");
  console.log(`product: ${product.name}  sell=${product.sellingPrice}  stock=${product.stockQuantity}`);

  const qty = 3;
  const base = product.sellingPrice * qty;
  // Mirror the server's own exclusive/inclusive maths so the tendered amount is close.
  const tax =
    product.taxMode === "INCLUSIVE"
      ? base - Math.round(base / (1 + product.taxRate / 100))
      : Math.round(base * product.taxRate) / 100;
  const total = Math.round((product.taxMode === "INCLUSIVE" ? base : base + tax) * 100) / 100;

  const sale = {
    branchId: branch.id,
    warehouseId: warehouse.id,
    items: [{ productId: product.id, quantity: qty, discountAmount: 0 }],
    discountAmount: 0,
    payments: [
      { provider: "CASH", methodType: "cash", amount: total, tenderedAmount: Math.ceil(total / 50) * 50 },
    ],
    idempotencyKey: `walkthrough-${Date.now()}`,
  };

  const { data } = await call("POST", "/pos/sale", sale, token);
  const inv = data.invoice;
  console.log("");
  console.log(`  invoice      ${inv.invoiceNumber}  (${inv.status})`);
  console.log(`  subtotal     ${inv.subtotal}`);
  console.log(`  VAT          ${inv.taxTotal}`);
  console.log(`  TOTAL        ${inv.total}`);
  console.log(`  paid         ${inv.paidAmount}`);
  console.log(`  change       ${data.changeAmount}`);

  const { data: after } = await call(
    "GET",
    `/pos/products?warehouseId=${warehouse.id}&limit=50`,
    null,
    token
  );
  const now = after.find((p) => p.id === product.id);
  console.log(`  stock        ${product.stockQuantity} -> ${now.stockQuantity} (sold ${qty})`);

  const { data: receipts } = await call("GET", `/pos/receipt/${inv.id}`, null, token);
  console.log(`  receipt ok   ${Boolean(receipts)}`);
};

main().catch((err) => {
  console.error("FAILED:", err.message);
  process.exit(1);
});
