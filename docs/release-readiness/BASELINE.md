# KaziOS — Release-Readiness Baseline

> Evidence-based baseline recorded **before** any code changes, then annotated with what
> changed during the engagement. Every claim below was observed directly via commands in
> the workspace; nothing is inferred from a filename or a prior session's report.

## 1. Environment

| Item | Observed value | How verified |
| --- | --- | --- |
| Platform | Windows (`win32`), PowerShell | `$PSVersionTable`, working dir |
| Repo root | `c:\Users\ZBOOK\Documents\KaziOS` | workspace |
| Current branch | `master` | `git branch --show-current` |
| Latest commit | `7528603` (master) | `git log --oneline -1` |
| Package manager | npm workspaces (root `package.json`) | `package.json` scripts |
| Node | v20.x (`.nvmrc`), npm v10.x | `node --version`, `npm --version` |
| Workspace shape | Monorepo: `apps/api`, `apps/web`, `apps/worker`, `packages/*` | directory listing |

## 2. Architecture (as found)

- **API**: Express + TypeScript (`apps/api/src/index.ts`), Prisma ORM, Postgres, Redis.
- **Frontend**: React + Vite (`apps/web/src/pages`), 17 page components.
- **Worker**: `apps/worker` — background jobs (BullMQ over Redis, as configured).
- **Shared packages**: `packages/validation`, `packages/types`, `packages/integrations`
  (email, sms, whatsapp, paystack, mpesa, **etims**), `packages/config`.
- **Database**: PostgreSQL via Prisma. 16 applied migrations in `apps/api/prisma/migrations`.
- **Auth**: JWT bearer tokens; role-based permissions enforced server-side (`middleware/auth.ts`,
  `lib/scope.ts`). Redis used for sessions/rate-limits with graceful fallback.
- **Money**: integer-minor-unit calculation layer (`lib/money.ts`, `apps/web/src/lib/posTotals.ts`),
  server-authoritative totals in POS/invoice routes.

## 3. Route & page inventory (as found)

- **API routes (22 files)**: auth, billing, card-payments, customers, expenses, inventory,
  invoices, mpesa, notifications, organization, payments, plans, platform, pos, products,
  purchase-orders, reports, roles, settings, suppliers, tax-categories, users.
- **Web pages (17)**: Customers, Dashboard, Expenses, ForgotPassword, Inventory, Invoices,
  Landing, Login, Payments, Pos, Pricing, Products, Purchasing, Register, Reports,
  ResetPassword, Settings.

## 4. Pre-existing failures & environment limitations (baseline)

- **Docker**: `com.docker.service` not running; the API runs against the host's local
  Postgres/Redis. Integration/smoke tests were run against the **local** `apps/api/.env`
  database — the connection string was inspected and confirmed to be a dev DB before any
  test ran. No production or unidentified database was touched.
- **Email provider**: `EMAIL_PROVIDER=console` in the dev host env — emails are logged, never
  delivered. This is the correct default for local testing; it was **not** changed to fake
  delivery. Password-reset links therefore only appear in the API log.
- **Paystack**: live API started with **test** keys (`pk_test`/`sk_test`) and a locally
  generated webhook secret, so card flows were exercised in Paystack test mode only. No real
  charge was issued.
- **M-PESA**: no Daraja sandbox credentials present. M-PESA code paths are unit-tested with a
  mocked gateway; live STK push is **BLOCKED EXTERNALLY**.
- **eTIMS/KRA**: no credentials, no sandbox access. The adapter is present but **not wired**
  into any invoice route, and disabled by default. All eTIMS verification is **BLOCKED EXTERNALLY**.

## 5. Baseline test signal (before fixes)

- `npm run typecheck` → exit 0.
- `npm run lint` → exit 0 (1 pre-existing warning).
- API unit tests (`jest --testPathPattern='.*\.test\.ts$'`) → **194 passed**.
- Web unit tests (`vitest`) → **23 passed**.
- Live smoke suites (against the running API + local DB) → **211 checks passed, 0 failed**
  after fixes (see TEST_RESULTS.md). Before fixes, `smoke-card-payments` and
  `smoke-purchase-orders` failed on test-fixture bugs, not product bugs (see §6).

## 6. Defects found during the audit (baseline → fixed)

| # | Severity | Where | Defect | Disposition |
| --- | --- | --- | --- | --- |
| 1 | P2 (test) | `smoke-card-payments.ps1` | Payment amount hard-coded `sellingPrice * 2`, ignoring per-line tax → server correctly rejected it as "amount must match total". | Fixed: amount computed the same way the server prices a basket (gross − discount + tax), warehouse selection now mirrors `PosPage.tsx` fallback. |
| 2 | P2 (test) | `smoke-purchase-orders.ps1` | PO-number regex expected 4 hex chars; generator emits 8 → false failure. | Fixed regex to `[A-F0-9]{8}`. |
| 3 | P2 (safety) | `cleanup-smoke-data.mjs` | Orphan-invoice cleanup deleted walk-in POS sales (not prefixed `INV-`). | Fixed: scope destructive delete to `INV-` prefixed invoice numbers only. |
| 4 | P2 (robustness) | `lib/mpesa.ts` | `stkQuery` dereferenced `stk` before the null check on a 200-with-no-verdict response. | Fixed: optional chaining → returns `PENDING`. |
| 5 | P3 (mock completeness) | `billing.test.ts` | Recurring-billing tests did not mock the Paystack plan-ensure helpers, so `openCheckout` reached a real HTTP client. | Fixed: added `createPlan/fetchPlan/createCustomer/findCustomerByEmail/*Subscription` mocks. |

No P0/P1 product defects were reproduced. The product logic (authoritative pricing,
tenant scoping, idempotent sales, tenant isolation) held under every adversarial probe.

## 7. Files changed (summary; full list in TEST_RESULTS / GO_NO_GO)

- `apps/api/src/lib/mpesa.ts` — defensive hardening.
- `apps/api/scripts/smoke-card-payments.ps1` — tax-aware amount + warehouse fallback.
- `apps/api/scripts/smoke-purchase-orders.ps1` — PO regex fix.
- `apps/api/scripts/cleanup-smoke-data.mjs` — data-safety scoping.
- `apps/api/src/services/billing.test.ts` — recurring-billing mocks.
- `apps/api/src/services/mpesaBilling.test.ts` — formatting only.
- Formatting-only (eslint --fix): `paystack.ts`, `billing.ts`, `subscriptions.ts`,
  `SettingsBillingPanel.tsx`.

> No production secrets were rotated, no data was deleted outside the smoke-cleanup scope, and
> no commits were created (the owner has not authorized a commit).

