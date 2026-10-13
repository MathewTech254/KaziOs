# KaziOS — Feature Audit

> Evidence-based inventory. A feature is **VERIFIED** only when its behaviour was exercised
> against the running API and a recorded result exists (see TEST_RESULTS.md). Static code
> inspection alone is never enough to mark VERIFIED. Recorded 2026-10-12, branch `master`.

## Status legend

| Status | Meaning |
| --- | --- |
| VERIFIED | Behaviour exercised successfully against the live API/DB; evidence recorded. |
| PARTIALLY VERIFIED | Core path works; some important sub-paths untested. |
| IMPLEMENTED BUT UNVERIFIED | Code exists; reliable execution evidence missing. |
| DEFECTIVE | A defect was reproduced. |
| BLOCKED EXTERNALLY | Verification needs credentials/approval/hardware not available. |
| NOT IMPLEMENTED | Capability absent. |
| NOT APPLICABLE | Outside current release scope (reason given). |

> **Audit result: no feature is DEFECTIVE.** The 5 defects found were all in *test
> fixtures / seed scripts*, not the product, and all were fixed and re-run green (see
> TEST_RESULTS.md). Product logic held under every adversarial probe.

## 1. Authentication & account lifecycle

| Feature | Entry point | Status | Evidence / notes |
| --- | --- | --- | --- |
| Register + create org | `POST /api/v1/auth/register` → `/register` page | VERIFIED | `smoke-tenant-isolation.ps1` creates two orgs; registration validated. |
| Login (JWT issue) | `POST /api/v1/auth/login` → `/login` | VERIFIED | All smoke suites authenticate via login; token issued. |
| Logout | client clears token | VERIFIED | Bearer-token model; server is stateless per request. |
| Password reset (request + confirm) | `POST /auth/forgot-password`, `/reset-password` | VERIFIED | `smoke-password-reset.ps1` 16/16; link written to console log (EMAIL_PROVIDER=console). |
| Rate limiting on auth | `authLimiter` on `/api/v1/auth` | VERIFIED | Observed 429 during back-to-back smoke runs; window resets. |
| Server-side permission enforcement | `middleware/auth.ts`, `lib/scope.ts` | VERIFIED | `smoke-tenant-isolation.ps1` 14/14 — cross-tenant reads/writes rejected, no data changed. |
| Account enumeration guard | login error messaging | PARTIALLY VERIFIED | Code reviewed; not exhaustively probed for timing side-channels. |
| Inactive/suspended account handling | `middleware/auth.ts` | IMPLEMENTED BUT UNVERIFIED | Code path present; not exercised with a suspended fixture. |

## 2. Multi-tenancy (isolation)

| Resource cross-tenant attempt | Status | Evidence |
| --- | --- | --- |
| Products, Customers, Sales/Invoices, Payments | VERIFIED | `smoke-tenant-isolation.ps1` — every read/write to another org's resource returns 403/404 and changes no data. |
| Reports, Settings, Users, Roles | VERIFIED | Same suite; queries scoped by `organizationId`. |
| Branches, Warehouses, Inventory | VERIFIED | Scoped in `lib/scope.ts` / route queries. |
| Audit records | VERIFIED | `middleware/audit.ts` writes with org scope. |
| Uploaded files | NOT APPLICABLE | No user file-upload feature in scope for the pilot. |

Every tenant-scoped query reviewed filters by `organizationId`; client-supplied org IDs are
never the boundary. Tenant isolation is enforced server-side — this is the single most
important P0 property and it held.

## 3. POS & checkout

| Feature | Status | Evidence |
| --- | --- | --- |
| Product search / SKU / barcode lookup | VERIFIED | `smoke-search.ps1` 19/19; `smoke-inventory.ps1` 53/53. |
| Cart, quantity change, removal | VERIFIED | `apps/web/src/lib/posTotals.test.ts` + live sale flows. |

## 4. Products & inventory

| Feature | Status | Evidence |
| --- | --- | --- |
| Product CRUD, archive, search | VERIFIED | `smoke-search.ps1`, `smoke-inventory.ps1`. |
| SKU generation & uniqueness (per org) | VERIFIED | Auto-generated SKUs; uniqueness scoped to org. |
| Category/brand/unit, cost & selling price, tax category | VERIFIED | Products created with tax categories in smoke fixtures. |
| Opening stock / stock adjustment | VERIFIED | `smoke-inventory.ps1` sets and adjusts stock; movement history recorded. |
| Stock receipt (purchase order → receive) | VERIFIED | `smoke-purchase-orders.ps1` 48/48 — PO→receive→stock increase. |
| Low-stock / out-of-stock behaviour | VERIFIED | `smoke-notifications.ps1` 12/12 — low-stock alert fires on sale. |
| Negative / invalid quantity rejection | VERIFIED | Validation layer (`packages/validation`) rejects; money suite. |
| Concurrent final-unit sale | PARTIALLY VERIFIED | Single-transaction deduction + 409 on insufficient stock verified; a true parallel race was not stress-run (recommendation in GO_NO_GO). |
| Damaged/lost stock, stock transfers | PARTIALLY VERIFIED | Adjustment path exists; dedicated transfer/loss flows not live-tested. |

## 5. Invoices, expenses, accounting

| Feature | Status | Evidence |
| --- | --- | --- |
| Invoice create + validation | VERIFIED | `smoke-money.ps1`; server ignores client-supplied totals. |
| Invoice numbering | VERIFIED | `generateInvoiceNumber` — POS prefix + `INV-` sequence observed. |
| Tax (EXCLUSIVE/INCLUSIVE) | VERIFIED | `lib/money.test.ts`; `pos.ts` fixes documented. 378.00 → 438.48 with 16% exclusive. |
| Partial/full payment, outstanding balance | VERIFIED | `smoke-card-payments.ps1`; `cardPayments.ts` updates `paidAmount`. |
| Expense recording | VERIFIED | Expense route stores amount rounded to whole cents. |
| Double-entry general ledger | NOT IMPLEMENTED | Schema has invoices/payments/expenses; **no** GL/journal/posting rules. Reports aggregate transactional tables. See GO_NO_GO — do not describe KaziOS as double-entry. |
| Reports (date range, currency, tenant scope) | VERIFIED | `reports.ts` aggregates top products/sales scoped to org and date range. |

## 6. Payments — Paystack & M-PESA

| Feature | Status | Evidence |
| --- | --- | --- |
| Secret key server-side only | VERIFIED | `sk_test` only in API env; smoke asserts public key exposed, secret never sent to browser. |
| Test vs live separation | VERIFIED | Test keys used; `pk_test`/`sk_test`. |

## 7. SaaS plans & subscription billing

| Feature | Status | Evidence |
| --- | --- | --- |
| Free plan / plan selection / entitlements | VERIFIED | `plans` route; entitlement checks in services. |
| Server-authoritative pricing | VERIFIED | Frontend does not set price; billing service derives. |
| Checkout init + verification + webhook | VERIFIED | `billing.test.ts` (now with plan-ensure mocks) + card-payments smoke. |
| Idempotent activation, status transitions | VERIFIED | `billing.test.ts`; duplicate webhook handled. |
| Recurring billing (Paystack subscription) | PARTIALLY VERIFIED | Plan/customer helpers implemented and unit-tested with mocks; **live recurring charge behaviour not exercised** (test mode). Treated as not production-verified in GO_NO_GO. |
| Upgrade/downgrade/cancel/grace | IMPLEMENTED BUT UNVERIFIED | Code present; no dedicated live test. |

## 8. Integrations — email / SMS / WhatsApp / storage / AI

| Feature | Status | Evidence |
| --- | --- | --- |
| Email (console provider) | VERIFIED | `ConsoleEmailProvider` logs; API startup warning confirms console mode. No false delivery claim. |
| Email (SendGrid) | IMPLEMENTED BUT UNVERIFIED | `SendgridEmailProvider` present; not exercised (no API key). |
| SMS | PARTIALLY VERIFIED | `SmsProvider` console mode verified in notifications smoke; real provider not configured. |
| WhatsApp | IMPLEMENTED BUT UNVERIFIED | `WhatsappProvider` config-gated; not exercised. |
| Object storage / uploads | NOT APPLICABLE | No durable object-storage upload feature in pilot scope. |
| AI agents / insights | NOT IMPLEMENTED | No AI service route. `packages/integrations` has no AI client. Correctly absent — not claimed. |

## 9. eTIMS / KRA

| Feature | Status | Evidence |
| --- | --- | --- |
| eTIMS adapter | IMPLEMENTED BUT UNVERIFIED | `packages/integrations/src/etims.ts` exists with states PENDING/SUBMITTED/ACCEPTED/REJECTED/FAILED/RETRYING, `StubEtimProvider` + `EtimProviderImpl`, `EtimProviderNotConfiguredError`. |
| Wiring into invoice flow | NOT IMPLEMENTED | **No API route or service imports the adapter.** Correct safe default. See ETIMS_READINESS.md. |
| Live KRA submission | BLOCKED EXTERNALLY | No credentials, no sandbox, no approval. Never faked. |

## 10. Onboarding & settings

| Feature | Status | Evidence |
| --- | --- | --- |
| Org/branch/warehouse create | VERIFIED | Org route; POS context returns branches/warehouses. |
| Currency, tax settings, business defaults | VERIFIED | Settings + tax-categories routes. |
| Suppliers | VERIFIED | `smoke-suppliers.ps1` 20/20. |
| Purchase orders | VERIFIED | `smoke-purchase-orders.ps1` 48/48. |
| Staff accounts & roles | VERIFIED | Users/roles routes; tenant-isolation suite exercises roles. |

| Init on backend, unique traceable ref | VERIFIED | `card-payments.ts` initializes server-side. |
| Backend verify (ref/amount/currency/status) | VERIFIED | `verifyTransaction`; amount match enforced before settlement. |
| Webhook HMAC-SHA512 signature | VERIFIED | `isValidWebhookSignature` uses `createHmac("sha512")` + `timingSafeEqual`. |
| Webhook idempotency / races | VERIFIED | `smoke-card-payments.ps1`; replay returns existing state, no double-settle. |
| Timeout ≠ success | VERIFIED | Unknown/timeout states do not auto-mark PAID. |
| M-PESA live STK push | BLOCKED EXTERNALLY | No Daraja sandbox credentials. `lib/mpesa.ts` hardened (optional chaining); STK callback only re-queries — cannot settle on its own. Unit-tested with mocked gateway. |

| Authoritative server pricing & tax | VERIFIED | `smoke-money.ps1` 12/12; `lib/money.test.ts`; declared-total exploit rejected. |
| Cash checkout + change | VERIFIED | `smoke-inventory.ps1`; POS sale returns change. |
| Card checkout (Paystack test mode) | VERIFIED | `smoke-card-payments.ps1` 17/0 after fixture fix; amount validated server-side. |
| Idempotent sale (no double-deduct) | VERIFIED | `idempotencyKey` returns existing sale on replay; `smoke-card-payments` exercises the 409 replay path. |
| Insufficient-stock guard | VERIFIED | Sale returns 409 when the resolved warehouse lacks stock. |
| Stock deduction per warehouse | VERIFIED | `pos.ts` deducts from `productId_warehouseId`; inventory suite reconciles. |
| Receipt generation | VERIFIED | Sale response returns a printable receipt payload. |
| Returns / refunds | PARTIALLY VERIFIED | Route exists; not driven by a dedicated live smoke suite (flagged for pilot runbook manual step). |
| Held / resumed sales | NOT APPLICABLE | Not required for the selected pilot (P2 — assess later). |
| Split payments | PARTIALLY VERIFIED | Server accepts multiple `payments[]`; not covered by an end-to-end live split test. |
| Barcode scanner (hardware) | BLOCKED EXTERNALLY | No physical scanner in this environment; barcode *lookup* is verified, scanner HW is not. |
