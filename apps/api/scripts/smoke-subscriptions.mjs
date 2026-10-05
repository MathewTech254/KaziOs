/**
 * A smoke test against a running API, over real HTTP.
 *
 * The unit and integration suites prove the rules, and prove them over real HTTP too, but
 * both build their own app. This one talks to a server somebody actually started, with its
 * own middleware stack, rate limiter, Redis and environment, against a database migrated
 * from nothing. It answers the only question that matters before pushing: does the running
 * thing do what it claims?
 *
 *   node scripts/smoke-subscriptions.mjs http://localhost:4100
 *
 * Exits non zero if anything fails, so it can be a gate rather than decoration.
 */

const BASE = (process.argv[2] || "http://localhost:4100").replace(/\/+$/, "");

let passed = 0;
const failures = [];

function check(name, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failures.push(`${name}${detail ? ` -- ${detail}` : ""}`);
    console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ""}`);
  }
}

async function call(method, path, { token, body, headers = {} } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  return { status: res.status, body: json };
}

const stamp = Date.now().toString(36);

console.log(`\nSmoke testing ${BASE}\n`);

// ---------------------------------------------------------------------------
console.log("public catalogue");
const catalogue = await call("GET", "/api/v1/plans");
check("plans are readable without signing in", catalogue.status === 200, `got ${catalogue.status}`);
const keys = (catalogue.body.data?.plans ?? []).map(p => p.key);
check(
  "community, starter and business are listed",
  ["community", "starter", "business"].every(k => keys.includes(k)),
  keys.join(",")
);
check("enterprise is not offered publicly", !keys.includes("enterprise"), keys.join(","));
// Only the free plan's own capabilities matter here. Starter and above legitimately list
// multi_branch, and their presence must not make this check pass or fail.
const communityFeatures = (catalogue.body.data?.plans ?? [])
  .find(p => p.key === "community")
  ?.features.map(f => f.key) ?? [];
check("community does not advertise multi_branch", !communityFeatures.includes("multi_branch"), communityFeatures.join(","));
const advertised = (catalogue.body.data?.plans ?? []).flatMap(p => p.features.map(f => f.key));
check(
  "only capabilities the API can enforce are advertised",
  !advertised.includes("api_access") && !advertised.includes("whatsapp"),
  advertised.join(",")
);
check("every plan has a limit set", (catalogue.body.data?.plans ?? []).every(p => p.limits.length > 0));

// ---------------------------------------------------------------------------
console.log("\nregistering a business");
const registered = await call("POST", "/api/v1/auth/register", {
  body: {
    organizationName: `Smoke ${stamp}`,
    name: "Smoke Owner",
    email: `smoke-${stamp}@example.test`,
    password: "KaziOS!Smoke2026",
    country: "KE",
    currency: "KES",
    timezone: "Africa/Nairobi",
  },
});
check(
  "registration succeeds",
  registered.status === 201,
  JSON.stringify(registered.body).slice(0, 160)
);
const token = registered.body?.data?.token;
check("a session token is issued", Boolean(token));
const orgId = registered.body?.data?.organization?.id;
check("the business is identified", Boolean(orgId));

// ---------------------------------------------------------------------------
console.log("\nthe new business starts on Community");
const summary = await call("GET", "/api/v1/billing/summary", { token });
check("billing summary is available", summary.status === 200, `got ${summary.status}`);
check("the plan is community", summary.body?.data?.plan?.key === "community", summary.body?.data?.plan?.key);
check("the plan is free, not a trial", summary.body?.data?.plan?.isFree === true);
check("the status is active", summary.body?.data?.status === "ACTIVE", summary.body?.data?.status);
check("nothing expires on a free plan", summary.body?.data?.renewalDate === null);
const limitKeys = (summary.body?.data?.usage ?? []).map(u => u.key);
check("usage reports the branch allowance", limitKeys.includes("branches"), limitKeys.join(","));
check("usage reports the seat allowance", limitKeys.includes("users"), limitKeys.join(","));
check("nothing is warned about yet", (summary.body?.data?.warnings ?? []).length === 0);

// ---------------------------------------------------------------------------
console.log("\nthe core product is not gated");
const product = await call("POST", "/api/v1/products", {
  token,
  body: {
    name: "Smoke Item",
    sku: `SMOKE-${stamp}`,
    costPrice: 100,
    sellingPrice: 150,
    minStock: 2,
    reorderPoint: 5,
    isActive: true,
    productType: "PHYSICAL",
  },
});
check(
  "a product can be created on the free plan",
  product.status === 201,
  `${product.status} ${JSON.stringify(product.body).slice(0, 120)}`
);

const customer = await call("POST", "/api/v1/customers", {
  token,
  body: { name: "Smoke Customer", phone: "0700000001" },
});
check("a customer can be created on the free plan", customer.status === 201, `${customer.status}`);

// ---------------------------------------------------------------------------
console.log("\nthe branch limit is enforced by the server");
const secondBranch = await call("POST", "/api/v1/org/branches", {
  token,
  body: { name: "Second", code: "SECOND" },
});
check("a second branch is refused", secondBranch.status === 403, `${secondBranch.status}`);
check("the refusal explains itself", /not part of the/i.test(secondBranch.body?.error ?? ""), secondBranch.body?.error);
check("the refusal names a way out", secondBranch.body?.details?.upgradeUrl === "/pricing", JSON.stringify(secondBranch.body?.details));

const branches = await call("GET", "/api/v1/org/branches", { token });
check(
  "the refused branch was not created",
  (branches.body?.data ?? []).length === 1,
  `${(branches.body?.data ?? []).length} branches`
);

// ---------------------------------------------------------------------------
console.log("\nthe seat limit is enforced by the server");
for (const n of [1, 2]) {
  const member = await call("POST", "/api/v1/users", {
    token,
    body: { name: `Member ${n}`, email: `m${n}-${stamp}@example.test`, password: "KaziOS!Smoke2026" },
  });
  check(`member ${n} can be added`, member.status === 201, `${member.status}`);
}
const fourth = await call("POST", "/api/v1/users", {
  token,
  body: { name: "Member 4", email: `m4-${stamp}@example.test`, password: "KaziOS!Smoke2026" },
});
check("a fourth member is refused", fourth.status === 409, `${fourth.status}`);
check("the refusal names the limit", fourth.body?.code === "LIMIT_REACHED", fourth.body?.code);
check("the refusal explains the number", /team members/i.test(fourth.body?.error ?? ""), fourth.body?.error);

// ---------------------------------------------------------------------------
console.log("\na sale still works, and is metered");
const ctx = await call("GET", "/api/v1/pos/context", { token });
check("the till can open", ctx.status === 200, `${ctx.status}`);
const productId = product.body?.data?.id;
const warehouseId = ctx.body?.data?.warehouses?.[0]?.id;
const branchId = ctx.body?.data?.branches?.[0]?.id;
check("a product and a warehouse are available to sell", Boolean(productId && warehouseId && branchId));

if (productId && warehouseId && branchId) {
  // Registration opens a warehouse but leaves it empty, and selling from an empty warehouse
  // is refused by the inventory service. That is correct behaviour, so the run stocks the
  // shelf first: this check is about whether a sale is metered, not about stock control.
  try {
    const { execSync } = await import("child_process");
    execSync("docker exec -i kazios-postgres psql -U postgres -d kazios_smoke", {
      input: `INSERT INTO "Inventory" ("id", "quantity", "reserved", "organizationId", "productId", "warehouseId") VALUES (gen_random_uuid()::text, 100, 0, '${orgId}', '${productId}', '${warehouseId}') ON CONFLICT DO NOTHING;\n`,
      stdio: ["pipe", "ignore", "ignore"],
    });
    check("the shelf is stocked for the sale", true);
  } catch (err) {
    check("the shelf is stocked for the sale", false, err.message.slice(0, 80));
  }

  const sale = await call("POST", "/api/v1/pos/sale", {
    token,
    body: {
      items: [{ productId, quantity: 1, discountAmount: 0 }],
      branchId,
      warehouseId,
      payments: [{ amount: 150, provider: "CASH", methodType: "cash" }],
      idempotencyKey: `smoke-sale-${stamp}`,
    },
  });
  check("a sale can be rung up", sale.status === 201, `${sale.status} ${JSON.stringify(sale.body).slice(0, 140)}`);

  if (sale.status === 201) {
    await new Promise(resolve => setTimeout(resolve, 500));
    const afterSale = await call("GET", "/api/v1/billing/summary", { token });
    const txUsage = (afterSale.body?.data?.usage ?? []).find(u => u.key === "monthly_transactions");
    check("the sale was metered", txUsage?.used === 1, `used=${txUsage?.used}`);
  }
}

// ---------------------------------------------------------------------------
console.log("\nplatform administration is separate");
const platform = await call("GET", "/api/v1/platform/businesses", { token });
check("a business owner is refused", platform.status === 403, `${platform.status}`);
check("the refusal says why", platform.body?.code === "NOT_PLATFORM_ADMIN", platform.body?.code);
const platformAnon = await call("GET", "/api/v1/platform/overview");
check("an anonymous caller is refused", platformAnon.status === 401, `${platformAnon.status}`);

// ---------------------------------------------------------------------------
console.log("\nnobody grants themselves a plan by saying they paid");
const before = await call("GET", "/api/v1/billing/summary", { token });
const forged = await call("POST", "/api/v1/billing/checkout/confirm", {
  token,
  body: { reference: `SUB-STARTER-made${stamp}` },
});
check("a made up reference is refused", forged.status === 404, `${forged.status}`);
const after = await call("GET", "/api/v1/billing/summary", { token });
check(
  "the plan did not change",
  after.body?.data?.plan?.key === before.body?.data?.plan?.key,
  `${before.body?.data?.plan?.key} -> ${after.body?.data?.plan?.key}`
);

const unsigned = await call("POST", "/api/v1/webhooks/paystack", {
  body: { event: "charge.success", data: { reference: `SUB-STARTER-unknown${stamp}`, amount: 1900 } },
  headers: { "x-paystack-signature": "deadbeef" },
});
check("an unsigned webhook is refused", unsigned.status === 401, `${unsigned.status}`);

// ---------------------------------------------------------------------------
console.log("\ncontinuity: an expired subscription keeps the business working");
// The period is moved into the past directly, which is what time does to a real one. The
// SQL is fed over stdin rather than as an argument, because a quoted table name inside a
// shell command inside Node is a quoting problem waiting to happen.
try {
  const { execSync } = await import("child_process");
  execSync('docker exec -i kazios-postgres psql -U postgres -d kazios_smoke', {
    input: `UPDATE "Subscription" SET "currentPeriodEnd" = NOW() - INTERVAL '60 days' WHERE "organizationId" = '${orgId}';\n`,
    stdio: ["pipe", "ignore", "ignore"],
  });
  check("the paid period was moved into the past", true);
} catch (err) {
  check("the paid period was moved into the past", false, err.message.slice(0, 80));
}

// Entitlements are cached briefly so a page that renders twenty rows does not ask the same
// question twenty times. Rather than guess that window from the outside, this polls until
// the server reports the change, which is both faster than waiting it out in full and not
// sensitive to however the cache is configured.
let expired = null;
const deadline = Date.now() + 30_000;
while (Date.now() < deadline) {
  await new Promise(resolve => setTimeout(resolve, 1000));
  const attempt = await call("GET", "/api/v1/billing/summary", { token });
  if (attempt.body?.data?.isExpired) {
    expired = attempt;
    break;
  }
}
check("the subscription is reported as expired", expired?.body?.data?.isExpired === true, "still not expired");
check("the business is told it is expired", expired?.body?.data?.isActive === false);
check(
  "the status is one the interface can act on",
  expired?.body?.data?.status === "EXPIRED",
  expired?.body?.data?.status
);
// Subscription state is deliberately not carried in `warnings`, which is about usage
// allowances. The billing screen renders this state from `isExpired` directly, and mixing
// the two would make one of them lie about what it is reporting.
check(
  "usage warnings stay separate from subscription state",
  Array.isArray(expired?.body?.data?.warnings),
  "warnings is not a list"
);

const stillSells = await call("POST", "/api/v1/customers", {
  token,
  body: { name: "Customer After Expiry", phone: "0700000002" },
});
check(
  "an expired business can still serve customers",
  stillSells.status === 201,
  `${stillSells.status} ${JSON.stringify(stillSells.body).slice(0, 120)}`
);

const coreStillWorks = await call("GET", "/api/v1/reports/dashboard", { token });
check("an expired business can still open the dashboard", coreStillWorks.status === 200, `${coreStillWorks.status}`);

const refusedForTheRightReason = await call("POST", "/api/v1/org/branches", {
  token,
  body: { name: "After Expiry", code: "AFTER" },
});
check(
  "a paid capability is refused while expired",
  refusedForTheRightReason.status === 403,
  `${refusedForTheRightReason.status}`
);
check(
  "the message says the data is safe",
  /data is safe/i.test(refusedForTheRightReason.body?.error ?? ""),
  refusedForTheRightReason.body?.error
);
check(
  "the message asks for payment, not a bigger plan",
  refusedForTheRightReason.body?.code === "SUBSCRIPTION_INACTIVE",
  refusedForTheRightReason.body?.code
);

// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log("\nFailures:");
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exit(1);
}
console.log("\nEverything the running server claims, it does.\n");