# Free-tier pilot deployment (no Redis, no worker)

This document describes how to run KaziOS for the v1 liquor-store pilot on free
or cheap hosting, with no Redis and no BullMQ worker. The API boots and serves
sales, stock, customers, expenses and reports without them.

## What changes when Redis is absent

| Surface | With Redis | Without Redis |
|---|---|---|
| Sessions | `connect-redis` store | Express `MemoryStore` (in-process) |
| Realtime notifications | Redis pub/sub across replicas | In-process `EventEmitter` (single instance) |
| BullMQ worker | Runs jobs (low-stock sweeps, etc.) | Not started; stock computed on demand |
| Rate limiting | Redis store (if configured) | In-memory store |

The API logs a startup line stating which mode is active:

```
Redis: enabled
```
or
```
Redis: disabled, using in-memory fallback
```

## Required environment variables

### API host (Node)

Set these on the API host. `REDIS_URL` is intentionally left **unset**.

```bash
DATABASE_URL="postgresql://user:pass@host:5432/kazios?sslmode=require"
SESSION_SECRET="<32+ char random>"
JWT_SECRET="<32+ char random>"
JWT_EXPIRES_IN="7d"
BCRYPT_ROUNDS="12"
API_PORT="4000"
CORS_ORIGIN="https://your-web.pages.dev"
NODE_ENV="production"
LOG_LEVEL="info"
ENABLE_REGISTRATION="true"
ENABLE_DEMO_SEED="false"
```

- `DATABASE_URL` — Neon or Supabase Postgres. Required.
- `SESSION_SECRET` / `JWT_SECRET` — generate 32+ random characters. Required.
- `CORS_ORIGIN` — the exact origin of your web app (no trailing slash, never `"*"`). Required in production.
- `ENABLE_DEMO_SEED` — set `"false"` for the pilot; seed the first shop through onboarding instead.

### Web host (Cloudflare Pages)

Vite variables are baked into the bundle at build time. Set these on the Pages build:

```bash
VITE_API_URL="https://your-api.onrender.com/api/v1"
VITE_API_TIMEOUT_MS="90000"
```

## Deployment steps

1. **Database** — Provision a Postgres on Neon (free tier) or Supabase (free tier). Record the `DATABASE_URL`.
2. **Run migrations** — On the API host, run `npx prisma migrate deploy` against the production `DATABASE_URL`.
3. **Deploy the API** — Deploy `apps/api` to a Node host (Render, Railway, Fly, Koyeb, etc.) with the env vars above. Do **not** set `REDIS_URL`. Do **not** start the `apps/worker` process.
4. **Deploy the web** — Deploy `apps/web` to Cloudflare Pages with the `VITE_*` env vars above. Use `npm run build` as the build command and `dist` as the output directory.
5. **Seed the first shop** — Open the landing page, register the owner, then use onboarding to add products, set opening stock, and add attendants.

## What works without Redis

- Register, login, logout, session revocation (sessions live in Postgres + in-process store)
- POS sales with CASH, MPESA_MANUAL, and CREDIT payments (one transaction)
- Stock ledger: receive, adjust, stocktake (computed on demand)
- Customers with credit balances and "Record payment"
- Daily closing report (computed on demand from the database)
- Expenses, reports (sales summary, stock, credit owed)
- Products, inventory levels, low-stock list
- Tenant isolation, server-side authorization, Zod validation, audit logging

## What is intentionally absent without the worker

- Invoice overdue sweeps (invoices UI is hidden in v1 anyway)
- Subscription reconciliation (billing UI is hidden in v1 anyway)
- Cross-replica realtime (single-instance SSE still works; low-stock badge reads from the database)

## What to add later

When you are ready for Redis, set `REDIS_URL` on the API host and restart. The API will use `connect-redis` for sessions, Redis pub/sub for realtime, and you can start the BullMQ worker (`apps/worker`) for background sweeps. No code changes are required — Redis is additive.
