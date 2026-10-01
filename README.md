# KaziOS

An ERP/POS platform for East Africa — built with a monorepo (npm workspaces), Prisma + PostgreSQL, BullMQ worker, and a React + Vite + Tailwind frontend.
 
## Status: Running locally

All three services start via `npm run dev`:
- **API**: http://localhost:4000
- **Web**: http://localhost:3000
- **Worker**: BullMQ queues (background)

## Quick start

```powershell
# 1. Start database + Redis (Docker — no local install needed)
cd C:\Users\ZBOOK\Documents\KaziOS
docker compose up -d postgres redis
# 2. Create database schema
cd apps\api
npx prisma migrate dev --name init
npx prisma generate

# 3. Run everything
cd C:\Users\ZBOOK\Documents\KaziOS
npm run dev
```

Open http://localhost:3000, register an organization, sign in.

## Architecture

```
packages/
  types/        — Shared constants (QUEUE_NAMES)
  validation/   — Zod schemas for all entities
  config/       — Config loader
  integrations/ — Payment/email/whatsapp/SMS stubs
  ai/           — OpenAI client wrapper
  ui/           — Shared UI tokens + button variant

apps/
  api/          — Express server (auth, CRUD, reports, settings)
  worker/       — BullMQ job processor
  web/          — Vite + React 18 + Tailwind frontend
```

## Key commands

| Command | Purpose |
|---|---|
| `npm run dev` | Start API + worker + web together |
| `npm run typecheck` | Typecheck every workspace, tests included |
| `npm test` | Run every workspace's tests |
| `npm run build` | Build all packages and apps |
| `npm run verify` | Typecheck + build in one command |
| `npm run lint` | Lint every workspace |
| `docker compose up --build` | Full Docker build |

### Testing

Every workspace has its own Jest config, and the suite runs in layers:

| Suite | Command | What it covers |
|---|---|---|
| Unit | `npm run test:unit` | Money arithmetic, validation schemas, stock rules |
| Integration | `npm run test:integration` | The `*.integration.ts` suites |
| UI | `npm test --workspace=@kazios/web` | React components under jsdom |

Tests are **typechecked but not compiled into the build** (`tsconfig.build.json`), so a
test can never drift from the signature it asserts against, and no test code is ever
shipped inside the deployed package.

Two browser-level checks cover the things a typecheck cannot see:

```powershell
node apps/web/scripts/check-overlay.mjs                            # layering, clipping, leaked source comments
powershell -File apps/api/scripts/smoke-notifications.ps1          # live SSE, end to end
```

`check-overlay.mjs` drives a real Chrome. It fails if the notification menu is painted
underneath the sidebar, or if a `//` comment inside JSX leaks into the page as text.

## Environment

- `apps/api/.env` — API config (DATABASE_URL, JWT_SECRET, etc.)
- `apps/web/` — Vite reads `VITE_API_URL` from env
- Root `.env` — shared vars

## What's implemented

- **Auth**: register (creates org + owner role + default accounts + VAT + branch + warehouse), login, logout, session management (JWT + Redis sessions)
- **Products**: CRUD with SKU, barcode, cost/sell price, min stock, tax category, brand, unit
- **Customers**: CRUD with type (individual/business)
- **Invoices**: create with line items, send, void, status tracking
- **Payments**: create, auto-update invoice status (PAID/PARTIALLY_PAID)
- **Organization**: profile, branches and warehouses (full CRUD, one main branch, in-use guards)
- **Reports**: sales summary (gated by `reports.view`)
- **Settings**: typed per-org key/value store (`invoicing`, `pos`, `notifications`, `accounting`) with validation, defaults and reset-to-defaults
- **Taxes**: tax category CRUD (`/tax-categories`) with rate/mode and in-use protection
- **Users & roles**: member list/invite, role CRUD with a shared permission catalogue (`GET /roles/permissions`), role assignment per branch/warehouse, last-owner protection
- **Web settings page**: `/settings` — organization profile, locations, tax, preferences and roles & permissions
- **Audit log**: automatic on all mutations
- **Worker**: notifications, automations, overdue invoices, stock checks (BullMQ)

## Demo organization

A complete, realistic Kenyan trading business so every screen has something true to
show and every flow can be exercised without inventing data by hand.

```powershell
node apps/api/scripts/seed-demo-org.mjs            # dry run, prints the plan
node apps/api/scripts/seed-demo-org.mjs --apply    # build it
```

It talks to the running API as a normal signed in user, so it can never write something
the application would refuse, and it matches on stable keys so running it twice is safe.

What it builds — **kazios-demo-org Highlands Provisions**:

- **3 branches** (Ngong Road, Westlands, Mombasa Road), each with its own warehouse.
  Stock differs per branch on purpose, so branch scoped stock and transfers are real.
- **21 products** across staples, proteins, dairy, household, services and extras,
  with SKU, barcode, VAT categories and reorder levels. Mombasa Road is deliberately
  lean so it has genuine low stock, and two products sit at zero for the out of stock path.
- **10 customers** (6 individual, 4 business with tax numbers) and **5 suppliers**.
- **4 staff on 4 roles** with genuinely different permissions, so the cashier really
  cannot see reports and the accountant really cannot touch stock.
- **Invoices in every status** — draft, sent, part paid, paid, void — including ones
  past their due date for the overdue sweep to find.
- **Purchase orders** as draft, sent and received, plus a completed and a pending transfer.
- **Till sales** spread over four weeks, rung through the POS endpoint so stock moves
  exactly as it does at a real till.

Any seeded staff member signs in with the password `KaziOS!Demo2026`.

## Real time notifications

Alerts are pushed to the browser over an open connection rather than polled, so the
badge reflects what has actually happened at the moment it happens.

```
POST /pos/sale        ─┐
POST /payments        ─┤
POST /inventory/...   ─┼─> notify() ─> Postgres row ─> Redis pub/sub ─> SSE ─> browser
worker sweeps         ─┘                (the record)   (across replicas)  (the push)
```

- `GET /api/v1/notifications/stream` — the live feed. Server Sent Events, so it works
  through the proxies and CDNs an API is deployed behind, and the browser reconnects
  on its own. The stream is authenticated like every other route.
- `apps/api/src/services/notifications.ts` — the single write path. Storing the alert and
  announcing it are one operation, so an alert cannot be stored but not delivered.
- Deduped by `dedupeKey`, so a condition that is detected repeatedly (a stock sweep runs
  every fifteen minutes) raises one alert, not one per sweep.
- Raised when: a sale completes, a payment settles an invoice, stock falls to its reorder
  level, an invoice goes overdue.
- Addressed to people who hold the relevant permission, and never to the person who just
  did the thing — the cashier already knows about their own sale.

Run the end to end check with the dev API listening:

```powershell
powershell -File apps/api/scripts/smoke-notifications.ps1
```

It opens a real stream, rings real sales through the public API, and asserts the alerts
arrive over that open socket.

## What's next

- Seed data script (`apps/api/src/utils/seed.ts`)
- Payment gateway integration (M-Pesa, Flutterwave) via `packages/integrations`
- Invoice PDF generation (pdfkit)
- File upload/storage (multer + `packages/integrations/src/storage.ts`)
- More web pages: POS terminal, purchases, expenses, projects, support tickets
- Email/SMS notification providers
- Multi-language (Swahili/English)