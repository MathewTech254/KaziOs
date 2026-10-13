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
