# KaziOS — Pilot Runbook

Operational guide for preparing the demo, onboarding the first pilot retail
shop, running daily operations, handling failures, collecting feedback and
escalating incidents.

This runbook describes a **controlled pilot** with real Kenyan retail
businesses. It is **not** a public production launch. Every limitation flagged
in `GO_NO_GO_REPORT.md` and `ETIMS_READINESS.md` applies during the pilot.

---

## 0. Roles and responsibilities

| Role | Responsibility |
|------|----------------|
| Pilot owner | Uses KaziOS day to day; reports issues; owns their business data. |
| KaziOS engineer (you) | Prepares the environment, onboards the shop, resolves incidents. |
| KaziOS product owner | Approves scope changes, legal text, and any eTIMS/KRA step. |

The pilot owner's staff are real people. Do not create production credentials,
log into their accounts, or export their data without their knowledge.

---

## 1. Preparing the demo environment

### 1.1 Start the infrastructure

The stack needs PostgreSQL 16 and Redis 7, plus the API, worker and web
processes.

```powershell
# If using Docker for the backing services only:
docker compose up -d postgres redis

# Run all three app processes (api + worker + web) in watch mode:
npm run dev
```

Or run each independently while troubleshooting:

```powershell
npm run dev:api      # API on :4000
npm run dev:worker   # BullMQ worker (notifications, eTIMS retries)
npm run dev:web      # Next.js frontend on :3000
```

Confirm the API is healthy before anything else:

```powershell
Invoke-RestMethod http://localhost:4000/health
# Expect: {"status":"ok"}
```

### 1.2 Apply migrations

```powershell
# Development / first pilot environment
npm run db:push --workspace=@kazios/api        # or: prisma migrate deploy for a migrated DB
```

> **Never** run `db:reset` or a destructive migration against a database that
> holds real business data. `prisma migrate deploy` is the production command;
> `prisma migrate dev` is for local schema iteration only.

### 1.3 Verify the build is green (do this before onboarding a shop)

```powershell
npm run typecheck
npm run lint
npm run build
npm run test --workspace=@kazios/api
npm run test --workspace=@kazios/web
```

If any of these fail, **stop** — do not onboard a real shop onto a red build.

### 1.4 Seed the fictional demo business (optional preview)

A coherent, clearly fictional Kenyan trader (`kazios-demo-org Highlands
Provisions`) exists for training and demos:

```powershell
# Dry run first — prints the plan, changes nothing:
node apps/api/scripts/seed-demo-org.mjs

# Build it only when you intend to use the demo org:
node apps/api/scripts/seed-demo-org.mjs --apply
```

The demo org contains three branches (Ngong Road, Westlands, Mombasa Road),
21 products across 7 categories, opening stock, suppliers, customers, purchase
orders, invoices in five statuses, transfers, and 28 days of till sales, with
four staff on four different roles.

> The demo credentials (`admin@kazios.dev` / `admin123`) are for the **demo
> org only**. They grant no access to real customer data. Never reuse them for a
> pilot business.

### 1.5 Hardware barcode scanner verification (manual step)

Covers the limitation tracked in `TEST_RESULTS.md` ("No physical device") and
`GO_NO_GO_REPORT.md` ("behaviour confirmed by runbook step only"). The test has
three layers: what automation already proves, what only a human with a real
device can prove, and the data loop that makes a scan matter.

#### Layer A — already proven without a device (re-run after any POS change)

The POS treats a scanner as a keyboard-wedge: full code + Enter triggers an
immediate single-match lookup that adds the line and refocuses the scan box.
This drives the UI exactly as a scanner does (keystrokes + Enter):

```powershell
node .audit/probe-scan.mjs        # must print SCAN-E2E=PASS
```

Everything below tests only what automation cannot: the physical device and
the correctness of the records the scan ends up changing.

#### Layer B — verify the device itself (2 minutes, before touching KaziOS)

1. Open Notepad, focus it, scan any barcode.
   - Digits appear **followed by a new line** → the device transmits the CR/Enter
     suffix the POS relies on. Continue to step 3.
   - Digits appear but the cursor stays on the same line → suffix is off: scan
     the "Transmit CR/Enter" configuration barcode from the scanner manual, retest.
   - Nothing appears → pairing/USB problem; fix the device first.
2. In the POS scan box, **type** a barcode by hand and press Enter. It must
   behave identically to a scan — the app cannot tell the difference.
3. Pick something real to scan (choose one):
   - *Real shelf item:* set a product's barcode field to the EAN printed on a
     package you own, then scan the package itself.
   - *Printed labels:* print the seeded demo barcodes (6001000000101,
     6001000000117, 6001000000124, 6001000000131, 6001000000148) and scan the paper.
   - *Phone/monitor screen:* only works with an imager (CMOS) scanner; laser
     scanners cannot read screens.

#### Layer C — scan loop in the till (expected results)

| # | Step | Expected |
|---|------|----------|
| C1 | Open POS | Cursor is already in the scan box — no tap needed |
| C2 | Scan an in-stock product | Line added with no click; box clears; focus returns to the box |
| C3 | Scan the same product again immediately | Quantity increments — no duplicate line |
| C4 | Scan three different products quickly | Three lines; total updates; focus never leaves the box |
| C5 | Scan a code that matches nothing | Nothing added; the code stays visible; no error or crash |
| C6 | Scan an out-of-stock product | Not added; its card shows disabled "Out of stock" |
| C7 | Select a category filter, then scan a product outside it | Still added — scanning deliberately ignores the grid filter |
| C8 | Tap a product card instead of scanning | Added, and focus returns to the scan box |
| C9 | Give a product your own barcode in Products, then scan/type it | Resolves — the shop's own codes work, not just seeded ones |

#### Layer D — the data loop: a scan must end in correct records

Scanning only fills the cart. **Stock and sales update when the sale is
saved** — that is the "updated according to what the user needs" check.

1. Record stock before the sale:

   ```sql
   SELECT p.sku, p.name, i.quantity
   FROM "Inventory" i JOIN "Product" p ON p.id = i."productId"
   WHERE p.sku = 'OIL-002';
   ```

2. Scan that product, complete the sale with cash, keep the receipt.
3. Verify in the UI:
   - Receipt lists the scanned item and totals correctly;
   - Inventory: stock down by exactly the quantity sold; status chip agrees;
   - Dashboard/Reports: the sale appears in **today's** totals;
   - Bonus — Ask your business: *"How much did we sell today?"* must now return
     this sale's figure (this also exercises the assistant on real data).
4. Re-run the SQL: `quantity` is lower by exactly the quantity sold. One scan
   can never deduct twice — deduction runs in a single server-side transaction.

**Recording the result:** when A–D pass, update the `TEST_RESULTS.md` row
("Hardware barcode scanner") with the date, scanner model, tester and outcome.
