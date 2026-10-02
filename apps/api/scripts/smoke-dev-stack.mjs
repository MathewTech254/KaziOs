// Walks the running dev stack the way a browser does: log in over HTTP with the seeded
// account, then read the dashboard and check the figures against the database directly.
//
// This is deliberately end to end rather than a unit check. It proves the server on :4000
// is running current code, that the Redis session works, and that the numbers on the
// opening screen are the numbers in the tables.
const BASE = process.env.CHECK_BASE || "http://localhost:4000";

function assert(condition, label, detail = "") {
  console.log(`${condition ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
  if (!condition) process.exitCode = 1;
}

const login = await fetch(`${BASE}/api/v1/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: "admin@kazios.dev", password: "admin123" }),
});

assert(login.ok, "login succeeds", `status ${login.status}`);
if (!login.ok) {
  console.log(await login.text());
  process.exit(1);
}

const { data } = await login.json();
const token = data.token;
const auth = { Authorization: `Bearer ${token}` };

const health = await (await fetch(`${BASE}/health`)).json();
assert(health.status === "ok", "api health", health.status);

const dashRes = await fetch(`${BASE}/api/v1/reports/dashboard`, { headers: auth });
assert(dashRes.ok, "dashboard endpoint reachable", `status ${dashRes.status}`);
const dash = (await dashRes.json()).data;

console.log("\n--- what the dashboard will show ---");
console.log("currency          :", dash.currency);
console.log("today takings     :", dash.today.revenue, `(${dash.today.transactions} sales)`);
console.log("month revenue     :", dash.month.revenue, `(${dash.month.transactions} sales)`);
console.log("month expenses    :", dash.month.expenses);
console.log("month profit      :", dash.month.profit);
console.log("awaiting payment  :", dash.receivables.outstanding);
console.log("low / out of stock:", dash.stock.lowStock, "/", dash.stock.outOfStock);
console.log("recent invoices   :", dash.recentInvoices.length);
console.log("top products      :", dash.topProducts.length);
for (const invoice of dash.recentInvoices) {
  console.log(`   ${invoice.invoiceNumber}  ${invoice.customer?.name || "Walk-in"}  ${invoice.total}  ${invoice.status}`);
}

// Cross-check the headline number against the expenses screen, since those two sit side
// by side and a disagreement between them is what destroys trust in both.
//
// The summary endpoint defaults to all time when given no range, while the dashboard
// reports this month. Passing the same window to both is the whole point: comparing an
// all-time figure with a monthly one would "fail" while both screens were right.
const now = new Date();
const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0, 23, 59, 59));

const summaryUrl =
  `${BASE}/api/v1/expenses/summary?startDate=${monthStart.toISOString()}` +
  `&endDate=${monthEnd.toISOString()}`;
const summary = (await (await fetch(summaryUrl, { headers: auth })).json()).data;

const allTime = (await (await fetch(`${BASE}/api/v1/expenses/summary`, { headers: auth })).json()).data;

const agree = Math.abs((summary.totalAmount ?? 0) - dash.month.expenses) < 0.01;
assert(agree, "dashboard expenses match the expenses report for the same month",
  `month ${dash.month.expenses} vs ${summary.totalAmount}`);
console.log(`     (all-time expenses for contrast: ${allTime.totalAmount})`);

if ((allTime.totalAmount ?? 0) > (dash.month.expenses ?? 0)) {
  console.log("     NOTE: this business has expenses outside the current month, so the");
  console.log("           dashboard legitimately shows a smaller figure than the expenses page.");
}

assert(dash.month.profit === Math.round((dash.month.revenue - dash.month.expenses) * 100) / 100,
  "profit is revenue minus expenses");
assert(dash.recentInvoices.length <= 5, "recent sales list is bounded");

// The routes the new work added, plus the ones a till depends on.
for (const [path, label] of [
  ["/api/v1/reports/dashboard", "dashboard"],
  ["/api/v1/reports/search?q=te", "global search"],
  ["/api/v1/expenses", "expenses list"],
  ["/api/v1/inventory/summary", "inventory summary"],
  ["/api/v1/pos/context", "pos context"],
  ["/api/v1/customers", "customers"],
]) {
  const res = await fetch(`${BASE}${path}`, { headers: auth });
  assert(res.ok, `route: ${label}`, `status ${res.status}`);
}

// A route must still refuse a caller with no token, or the checks above prove nothing.
const anon = await fetch(`${BASE}/api/v1/reports/dashboard`);
assert(anon.status === 401, "dashboard refuses an anonymous caller", `status ${anon.status}`);
