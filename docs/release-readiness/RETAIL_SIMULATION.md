# KaziOS — Retail Simulation

> Purpose: describe the coherent, repeatable fictional retail business used to exercise core
> workflows, the scenario, expected vs. actual outcomes, and unresolved differences. The seeder is
> idempotent, never touches unrelated organizations, and defaults to a dry run.

## 1. The simulation business

`scripts/seed-demo-org.mjs` builds a single self-contained organization. All data is clearly
fictional and is marked with the marker string `kazios-demo-org` so it can be identified and
removed safely.

| Aspect | Value | Source |
| --- | --- | --- |
| Organization | `kazios-demo-org Highlands Provisions` | seed-demo-org.mjs:35 |
| Business type | Retail — Supermarket and provisions (Nairobi) | :154 |
| Currency | KES | :156 |
| Default tax mode | EXCLUSIVE (VAT added on top of shelf price) | :165 |
| Tax PIN | `PVT-2017-2244` (fictional) | :153 |

### Branches & warehouses (3)
Ngong Road (NGR), Westlands (WST), Mombasa Road (MSB) — **one warehouse per branch**, with
deliberately different stock per branch (one branch kept lean) so branch-scoped stock, transfers
and role scoping are all testable.

### Catalogue (21 products, 7 categories)
Staples, Spices, Proteins, Dairy, Household, Services, Extras. Each product carries SKU, EAN-style
barcode, cost, selling price, a stock tier, and a track-stock flag.

- **Full stock** tier — plenty on hand.
- **Lean** tier (proteins) — reorders sooner, so low-stock alerts fire.
- **Out-of-stock** tier (e.g. Premium Basmati 5kg, Olive Oil 500ml) — deliberately at zero so the
  out-of-stock path is exercised.
- **Services** (Delivery) and **Extras** (Shopping Bag) — test tracked vs. untracked and
  non-PHYSICAL product types.

### Tax categories (4)
VAT Standard 16%, VAT Reduced 8%, Zero Rated 0%, Exempt 0% — all `EXCLUSIVE`, reused by name if
they already exist.

### Customers (10), Suppliers (5), Staff (4)
- 6 individual + 4 business customers (businesses carry fictional PINs). Two share the name prefix
  "Achieng" so search discrimination is testable.
- 5 suppliers (grain, wholesale, produce, homecare, dairy).
- 4 staff with genuinely different permissions:
  - **Manager** (Faith Njeri) — `["*"]`
  - **Cashier** (Joseph Kariuki) — `pos.sale`, invoices/customers/products `.view`
  - **Accountant** (Mercy Achieng) — reports + payments + invoices create/send
  - **Stock controller** (Samuel Kiptoo) — inventory + purchasing + products view

## 2. Modelled business events

The seeder drives the full lifecycle across time (`daysAgo`), not a flat snapshot:

1. **Opening stock** — recorded as inventory adjustments with reference `OPEN-<branch>-<sku>` so
   opening stock is never counted twice and remains traceable to a valid business operation.
2. **Purchase orders** — created in draft, sent, and received states (received increases stock).
3. **Invoices (14)** in every status the app can hold — DRAFT, SENT/unpaid, PARTIALLY_PAID, PAID,
   VOID — including invoices deliberately past their due date (the overdue state the worker sweep
   targets). Every amount is derived server-side; the seed sends only quantity/price inputs.
4. **Payments** — recorded against invoices (bank transfer) for paid/part-paid states.
5. **Stock transfers** — 1 completed, 1 pending, so transfer lifecycle is exercised.
6. **Till sales** — rung across the last 28 days via `/pos/sale`; out-of-stock items are skipped
   and reported, so the seeder never fabricates stock it does not have.

## 3. Safety properties (verified in code)

- **Idempotent** — branches/warehouses/products/tax categories/customers/suppliers/staff are
  looked up first and reused by SKU/code/email; re-running updates rather than duplicating.
- **Scoped** — writes go through the authenticated demo org token only; no cross-org writes.
- **Dry-run default** — prints the full plan; requires explicit `--apply` to build.
- **Server-authoritative money** — the seed never declares totals; it sends line inputs and lets
  the server compute totals, matching the declared-total-exploit protection.

## 4. How to run

```bash
# preview (no writes) — prints branches, products, customers, suppliers, staff, invoice plan
node apps/api/scripts/seed-demo-org.mjs

# build / refresh against a running local API
node apps/api/scripts/seed-demo-org.mjs --apply
```

Login as the demo owner using `KAZIOS_SMOKE_EMAIL` / `KAZIOS_SMOKE_PASSWORD` (env-overridable;
defaults are local dev values, **not** reusable for production).

## 5. Actual results & discrepancies

- Seeding executed against the local dev database during this engagement and produced the counts
  summarised above (printed by `printSummary`). The API remained healthy (`/health` → `ok`).
- **Limitation:** this simulation exercises the *data and API layer* end-to-end. A GUI walkthrough
  of the same scenario on the web frontend (and a physical barcode scanner) was **not** performed
  here and is captured as a manual step in `PILOT_RUNBOOK.md`. Treat the frontend visual/receipt
  presentation as IMPLEMENTED BUT UNVERIFIED until a human runs the pilot shop.
- No data-integrity discrepancy was observed: money math (`smoke-money.ps1` 12/12), inventory
  (`smoke-inventory.ps1` 53/53), purchase orders (48/48) and card payments (17/17) all reconcile
  server-side totals with stored values.
