# KaziOS — Test Results

> Exact commands, results and environment assumptions. Every number below was produced by an
> actual run in this workspace on 2026-10-12 (branch `master`). Nothing is estimated.
> The API was run locally (`ts-node-dev`) against the host's **development** Postgres/Redis.

## Environment assumptions

- Node v20.x, npm workspaces. API started with `npm run dev --workspace=@kazios/api` on `:4000`.
- Database: local dev Postgres (connection string from `apps/api/.env` was inspected and
  confirmed to be a dev DB before any test ran). Redis: local.
- Paystack: **test** keys (`pk_test`/`sk_test`) + locally generated webhook secret → Paystack
  **test mode only**. No real charge.
- Email: `EMAIL_PROVIDER=console` → messages written to log, never delivered.
- M-PESA & eTIMS: no credentials → live paths not run (recorded as BLOCKED).

## 1. Static quality gates

| Command | Result |
| --- | --- |
| `npm run typecheck` | **exit 0** (no TS errors) |
| `npm run lint` | **exit 0** (1 pre-existing warning, unrelated to changes) |
| `cd apps/api && npx jest --testPathPattern='.*\.test\.ts$'` | **194 passed / 0 failed** |
| `npm run test --workspace=@kazios/web` (vitest) | **23 passed / 0 failed** |
| `npm run test --workspace=@kazios/worker` | **no test files** (suite empty — nothing to run) |

`test:integration` (`apps/api/scripts/run-integration.mjs`) requires a dedicated test DB and a
fresh migration; it was **not** run because it needs a separate database the workspace does not
provision here. The live smoke suites below exercise the same routes end-to-end instead.

## 2. Live smoke suites (against running API + dev DB)

Each suite authenticates as the seeded demo org, drives real HTTP, then cleans up its own
fixtures via `scripts/cleanup-smoke-data.mjs` (now scoped to `INV-`-prefixed invoices so
walk-in POS sales are never destroyed).

| Suite | Command | Result |
| --- | --- | --- |
| Money math | `smoke-money.ps1` | **12 passed / 0 failed** |
| Inventory | `smoke-inventory.ps1` | **53 passed / 0 failed** |
| Tenant isolation | `smoke-tenant-isolation.ps1` | **14 passed / 0 failed** |
| Purchase orders | `smoke-purchase-orders.ps1` | **48 passed / 0 failed** |
| Suppliers | `smoke-suppliers.ps1` | **20 passed / 0 failed** |
| Search | `smoke-search.ps1` | **19 passed / 0 failed** |
| Password reset | `smoke-password-reset.ps1` | **16 passed / 0 failed** |
| Card payments (Paystack test) | `smoke-card-payments.ps1` | **17 passed / 0 failed** (after fixture fix) |
| Notifications (low-stock) | `smoke-notifications.ps1` | **12 passed / 0 failed** |

**Total live checks: 211 passed, 0 failed.**

## 3. Tests that could NOT run (and why)

| Check | Reason | Next action |
| --- | --- | --- |
| `test:integration` (Prisma migration + isolated DB) | Needs a dedicated empty test database not provisioned in this environment. | Provision a throwaway DB and run `npm run test:integration --workspace=@kazios/api`. |
| M-PESA live STK push | No Daraja sandbox credentials. | Owner provides sandbox consumer key/secret + shortcode; run `smoke` with live creds. |
| eTIMS/KRA submission | No credentials, no sandbox, no KRA approval. | See ETIMS_READINESS.md — BLOCKED EXTERNALLY. |
| SendGrid / real SMS / WhatsApp | No provider API keys. | Configure keys; smoke-notifications will then deliver. |
| Hardware barcode scanner | No physical device. | Manual pilot runbook step — `PILOT_RUNBOOK.md` §1.5 (Layers A–D). |
| Worker tests | No worker test files exist. | Optional — add tests if worker logic grows. |

## 4. What these results do and do not prove

A green suite proves the **code checks** pass and the listed **workflows were exercised** in
test mode against a dev database. It does **not** prove: live-provider behaviour (M-PESA, eTIMS),
hardware behaviour, real-money settlement, or a parallel-sale race. Those are explicitly listed
above as unverified and are reflected in GO_NO_GO_REPORT.md.
