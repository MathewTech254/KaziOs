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
| `npm run build:packages` | Build all shared packages |
| `cd apps/api && npx prisma migrate dev` | Create/update DB schema |
| `cd apps/api && npx prisma generate` | Regenerate Prisma client |
| `npm run typecheck` | Typecheck everything |
| `docker compose up --build` | Full Docker build |

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
- **Organization**: branches, warehouses, settings
- **Reports**: sales summary, profit/loss, inventory, trial balance
- **Settings**: key-value store
- **Audit log**: automatic on all mutations
- **Worker**: notifications, automations, overdue invoices, stock checks (BullMQ)

## What's next

- Seed data script (`apps/api/src/utils/seed.ts`)
- Payment gateway integration (M-Pesa, Flutterwave) via `packages/integrations`
- Invoice PDF generation (pdfkit)
- File upload/storage (multer + `packages/integrations/src/storage.ts`)
- More web pages: POS terminal, purchases, expenses, projects, support tickets
- Email/SMS notification providers
- Multi-language (Swahili/English)