# KaziOS — Go / No-Go Report (Controlled Retail Pilot)

> Author: Principal architect / release-manager review. Date: 2026-10-12. Branch: `master`.
> Every claim below is backed by an actual run recorded in `TEST_RESULTS.md`, `SECURITY_REVIEW.md`
> and `FEATURE_AUDIT.md`. Where evidence is absent, the item is marked BLOCKED or CONDITIONAL —
> it is never hidden inside a passing score.

## Executive summary

KaziOS is a working multi-tenant retail platform. The core sell-stock-report loop is real and
verified end-to-end: **211 live HTTP checks passed with 0 failures** across nine smoke suites,
plus **194 API unit tests** and **23 web tests** green, `typecheck` clean (exit 0) and `lint`
clean (exit 0). Money is computed in **integer minor units** (cents) and the server — never the
client — is authoritative for prices, tax, discounts and totals. Tenant isolation, POS checkout,
inventory deduction, purchase orders, suppliers, search, password reset and Paystack **test-mode**
card payments were all exercised against a live API and dev database.

Two defects were found and fixed during this engagement, both in the **test/ops tooling and
demo-seed safety**, not in the core sell loop: (1) the card-payments smoke fixture selected a
warehouse that had no stock for the chosen product; (2) `cleanup-smoke-data.mjs` could have
deleted legitimate walk-in POS sales during test cleanup. Both now have regression coverage.

The eTIMS/KRA adapter exists with correct state modelling but is **not wired into any invoice
route** and is disabled by default. M-PESA and real email/SMS/WhatsApp are code-complete but
**unverified** because no provider credentials exist in this environment.

## Release decision

| Scope | Decision | Basis |
| --- | --- | --- |
| **Controlled retail pilot** (2–3 shops, real ops, KRA-compliant interim invoicing, Paystack test→live only after pilot OK) | **CONDITIONAL GO** | Core workflows verified; conditions in §Approved limitations must hold. |
| **General public production launch** | **NO-GO** | Live M-PESA, real email/SMS/WhatsApp delivery, hardware scanning, parallel-sale race, backup restore and eTIMS are unverified; legal/privacy docs not signed off. |
## Findings by priority

- **P0 — Critical release blockers: 0 open.** (Two defects found were classified P2 and fixed.)
- **P1 — Essential retail workflows: 0 broken, several CONDITIONAL.** Registration→org→products→
  opening stock→purchase→sale→payment→report all verified in test mode. Conditional items: real
  M-PESA collection, real receipt email/SMS/WhatsApp delivery, live Paystack settlement — all
  depend on credentials/approval not present here (BLOCKED EXTERNALLY, not failed).
- **P2 — Operational improvements:** barcode scanning (no hardware — manual), stock transfers
  (demo data exercises the model; concurrency race untested), cashier shift reconciliation
  (implemented, partially verified), digital receipts (email path console-only).
- **P3 — Advanced capabilities:** AI agents, forecasting, loyalty, complex promotions — present as
  UI/partial code, **NOT** release-relevant and explicitly out of pilot scope.

## Features verified with evidence (VERIFIED)

Core sell loop: product CRUD & search; SKU/barcode handling; integer-cents money math
(subtotal+tax=total invariant, no float drift, discount capped to line); VAT EXCLUSIVE/INCLUSIVE
separation; POS checkout with server-authoritative totals; cash + **Paystack test-mode card**
payments; stock deduction scoped to a specific warehouse; insufficient-stock rejection (409);
idempotency key reuse protection; purchase orders (server ignores forged money fields);
suppliers; global search; password reset; low-stock notifications; **tenant isolation** (two orgs,
cross-tenant read/write attempts all denied, no data mutated on denial).

## Implemented but not fully verified

- **M-PESA STK push / C2B** — code complete, no sandbox credentials → BLOCKED EXTERNALLY.
- **Email/SMS/WhatsApp delivery** — adapters exist; `EMAIL_PROVIDER=console` and no SMS/WA keys →
  delivery path unverified (console mode confirmed by startup warning, so no false success).
## Paystack readiness

Test-mode only. Secret key used server-side, public key exposed to browser only, sale amount
validated against server-computed total (mismatch → 400), signature-verified webhook path present,
idempotency on duplicate webhooks covered by code + tests. **No real charge was made.** Live mode,
live settlement and live webhook races remain BLOCKED until live keys + owner authorization.

## eTIMS / KRA readiness

Adapter (`packages/integrations/src/etims.ts`) models NOT_SUBMITTED/PENDING/ACCEPTED/REJECTED/
FAILED/RETRYING/UNKNOWN and a clearly-marked `StubEtimProvider`, but it is **not wired into any
invoice route** and is disabled by default (empty env → `NotConfigured`). This is the correct
safe default. **Pilot shops must keep using their existing KRA-compliant eTIMS solution.** No KRA
control-unit ID, receipt number, verification code or QR is ever fabricated. See ETIMS_READINESS.md.

## Deployment & backup readiness

Deployment config documented in `DEPLOYMENT_CHECKLIST.md` (env by name, no secrets). **Backup
restore was NOT performed** — no isolated restore target exists here, so backup readiness is
recorded as UNVERIFIED, not VERIFIED. A restore rehearsal is a required pre-general-launch action.

## Approved limitations for the pilot (must hold)

1. Pilot invoicing uses the shop's existing KRA solution; KaziOS receipts are **ordinary sales
   receipts**, never labelled KRA tax invoices.
2. Paystack runs in test mode until a deliberate, authorized switch to live.
3. Physical barcode scanner is used as a keyboard-wedge; behaviour confirmed by runbook step only.
4. Email/SMS/WhatsApp may not deliver in the pilot (console/no-keys) — not treated as success.
5. A named human is on-call to reconcile the till daily and escalate incidents.

## Files changed / migrations created

No migrations were created (no schema change was required). Source changes (all committed-ready,
uncommitted per change-management rules): `apps/api/src/lib/paystack.ts`, `apps/api/src/lib/mpesa.ts`
(defensive hardening), `apps/api/src/services/billing.ts`, `subscriptions.ts`, `mpesaBilling.ts`
(+ tests), `apps/web/src/components/SettingsBillingPanel.tsx`, and test/seed tooling
(`smoke-card-payments.ps1`, `smoke-purchase-orders.ps1`, `cleanup-smoke-data.mjs`). Nine documents
created under `docs/release-readiness/`. No secrets, no destructive DB ops, no Git history rewrite.

## The five most important next actions

1. **Rehearse a database restore** into an isolated target and document the measured procedure —
   the single biggest gap between "code looks fine" and "business can recover."
2. **Obtain Paystack live keys** (owner) and run the card suite once in live mode under
   authorization; verify settlement and a duplicate-webhook race.
3. **Obtain M-PESA Daraja sandbox credentials**, run STK/C2B smoke, then a live pilot charge.
4. **Wire eTIMS deliberately** only after KRA access/approval; until then enforce the interim
   compliant-invoicing workflow and brief each pilot shop.
5. **Legal/privacy sign-off** (privacy policy, ToS, Kenyan data-protection statement) before any
   general launch.

## Pilot onboarding checklist (first retail shop)

See `PILOT_RUNBOOK.md` for the full runbook. Condensed:
1. Register → create organization → business profile → currency (KES) & VAT defaults.
2. Create a branch + warehouse (link the warehouse to the branch).
3. Add staff with least-privilege roles (owner, cashier).
4. Add or import products; set opening stock at the warehouse.
5. Configure suppliers and payment methods (cash + Paystack test card).
6. Run one purchase order → receive stock; confirm stock rises.
7. Complete a cash sale and a card (Paystack test) sale; print ordinary receipts.
8. Verify stock deduction, sales-history entry, customer history and a day's report.
9. Record one expense; confirm it appears in reports.
10. Process one return; confirm stock and totals correct.
11. Confirm subscription status is visible and correct.
12. Hand over the escalation contact and the daily till-reconciliation step.


- **Stock transfers & cashier shifts** — models + demo data present; live concurrency race untested.
- **Subscription recurring billing** — Paystack checkout verified to open; recurring lifecycle
  (upgrade/downgrade/grace/failure recovery) partially covered by unit tests, live webhook
  recurrence unverified.



A controlled pilot may proceed **only** with the limitations below acknowledged and the pilot
onboarding checklist in `PILOT_RUNBOOK.md` followed. General launch must wait until the P1/P2
external verifications and the legal review are complete.

## Critical defects

**P0 — none open.** No cross-tenant data access, auth bypass, money-corruption, duplicate
payment, inventory-corruption or duplicate-posting defect was reproduced. The two defects found
were P2 (test/seed safety) and were fixed and regression-tested.
