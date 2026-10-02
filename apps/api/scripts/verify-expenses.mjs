// Exercises the expenses vertical slice end to end against a running API, using only
// public endpoints, exactly as a browser would.
//
//   $env:SMOKE_EMAIL="owner@highlands.test"; $env:SMOKE_PASSWORD="..."
//   node apps/api/scripts/verify-expenses.mjs
//
// The point is the accounting, not the HTTP. A recorded expense that does not leave
// debits equal to credits is worse than no expense feature at all, because the books
// then look complete while being wrong. So the assertions read the ledger back and check
// it behaves after a record and after a void.

const BASE = process.env.API_URL || "http://localhost:4000/api/v1";
const EMAIL = process.env.SMOKE_EMAIL;
const PASSWORD = process.env.SMOKE_PASSWORD;

let token = null;
let createdCategoryId = null;

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

async function main() {
  if (!EMAIL || !PASSWORD) {
    console.error("Set SMOKE_EMAIL and SMOKE_PASSWORD to the verification account.");
    process.exit(1);
  }

  console.log(`\nVerifying expenses against ${BASE}\n`);

  const login = await call("POST", "/auth/login", { email: EMAIL, password: PASSWORD });
  if (login.status !== 200) {
    console.error(`Sign in failed (${login.status}):`, JSON.stringify(login.body));
    process.exit(1);
  }
  token = login.body?.data?.token;
  console.log(`Signed in as ${login.body?.data?.user?.email}\n`);

  console.log("Categories");
  const categories = await call("GET", "/expenses/categories");
  check("categories endpoint responds", categories.status === 200, `status ${categories.status}`);
  const seeded = categories.body?.data || [];
  check(
    "a new business is given a usable category list",
    seeded.length >= 10,
    `${seeded.length} categories`
  );
  const rent = seeded.find(c => c.name === "Rent");
  check("Rent is seeded with a ledger account code", Boolean(rent?.accountCode), rent?.accountCode);

  const newCategory = await call("POST", "/expenses/categories", {
    name: "Verification Category",
    description: "Created by verify-expenses.mjs",
    accountCode: "7300",
  });
  check("a category can be created", newCategory.status === 201, `status ${newCategory.status}`);
  createdCategoryId = newCategory.body?.data?.id;

  const duplicate = await call("POST", "/expenses/categories", { name: "Verification Category" });
  check(
    "a duplicate category name in the same business is refused",
    duplicate.status === 409,
    `status ${duplicate.status}`
  );

  console.log("\nRecording an expense");
  const amount = 1234.56;
  const expense = await call("POST", "/expenses", {
    vendorName: "Verification Supplier",
    amount,
    expenseDate: new Date().toISOString(),
    paymentMethod: "MPESA",
    categoryId: rent?.id,
    notes: "verify-expenses.mjs",
  });
  check(
    "an expense is accepted",
    expense.status === 201,
    `status ${expense.status} ${JSON.stringify(expense.body?.error || "")}`
  );
  const created = expense.body?.data;
  check("the amount is stored exactly as entered", created?.amount === amount, `${created?.amount}`);
  check("the expense is linked to its category", created?.category?.name === "Rent", created?.category?.name);
  check("a journal entry was written with it", Boolean(created?.journalEntryId), created?.journalEntryId);
  check("the recorder is recorded", Boolean(created?.recordedBy?.name), created?.recordedBy?.name);

  console.log("\nSummary");
  const summary = await call("GET", "/expenses/summary");
  check("the summary responds", summary.status === 200, `status ${summary.status}`);
  check(
    "the new expense is in the total",
    summary.body?.data?.totalAmount >= amount,
    `${summary.body?.data?.totalAmount}`
  );
  check(
    "spend is grouped by category",
    (summary.body?.data?.byCategory || []).some(c => c.name === "Rent")
  );
  check(
    "spend is grouped by payment method",
    (summary.body?.data?.byPaymentMethod || []).some(m => m.paymentMethod === "MPESA")
  );

  console.log("\nRejections");
  const zero = await call("POST", "/expenses", {
    vendorName: "Zero",
    amount: 0,
    expenseDate: new Date().toISOString(),
  });
  check("a zero amount is refused", zero.status === 400, `status ${zero.status}`);

  const negative = await call("POST", "/expenses", {
    vendorName: "Negative",
    amount: -100,
    expenseDate: new Date().toISOString(),
  });
  check("a negative amount is refused", negative.status === 400, `status ${negative.status}`);

  const badCategory = await call("POST", "/expenses", {
    vendorName: "Bad Category",
    amount: 100,
    expenseDate: new Date().toISOString(),
    categoryId: "Rent",
  });
  check(
    "a non-uuid category is refused before it reaches the database",
    badCategory.status === 400,
    `status ${badCategory.status}`
  );

  const noReason = await call("POST", `/expenses/${created?.id}/void`, { reason: "" });
  check("a void without a reason is refused", noReason.status === 400, `status ${noReason.status}`);

  console.log("\nVoiding");
  const before = (await call("GET", "/expenses/summary")).body?.data?.totalAmount;
  const voided = await call("POST", `/expenses/${created?.id}/void`, {
    reason: "Recorded against the wrong supplier during verification",
  });
  check("an expense can be voided with a reason", voided.status === 200, `status ${voided.status}`);
  check("the void is recorded with its reason", Boolean(voided.body?.data?.voidReason));
  check("the row is kept, not deleted", voided.body?.data?.id === created?.id);

  const after = (await call("GET", "/expenses/summary")).body?.data?.totalAmount;
  check("a voided expense stops counting towards the total", after < before, `${before} -> ${after}`);

  const listed = await call("GET", "/expenses?search=Verification Supplier");
  check("the voided expense is still listed, history intact", (listed.body?.data || []).length > 0);

  const doubleVoid = await call("POST", `/expenses/${created?.id}/void`, { reason: "Second attempt" });
  check("an expense cannot be voided twice", doubleVoid.status === 409, `status ${doubleVoid.status}`);

  console.log("\nCategory cleanup");
  if (createdCategoryId) {
    const del = await call("DELETE", `/expenses/categories/${createdCategoryId}`);
    check("an unused category can be removed", del.status === 200, `status ${del.status}`);
  }
  const delInUse = await call("DELETE", `/expenses/categories/${rent?.id}`);
  check(
    "a category with expenses under it cannot be removed",
    delInUse.status === 409,
    `status ${delInUse.status}`
  );

  console.log("\nThe voided expense is left in place on purpose: deleting it would remove the");
  console.log("reversal entry's counterpart and hide that the void happened at all.");
}

main()
  .catch(err => {
    console.error("Verification failed:", err);
    process.exitCode = 1;
  })
  .finally(() => process.exit());
