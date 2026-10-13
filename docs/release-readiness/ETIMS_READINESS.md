# eTIMS / KRA Integration Readiness

Status of the Kenya Revenue Authority eTIMS (electronic Tax Invoice Management System)
integration in KaziOS as assessed during the release-readiness audit.

## 1. Bottom line

The eTIMS integration is **NOT wired into the application and must not be used to issue
KRA tax invoices during the pilot.** An adapter *interface* exists in
`packages/integrations/src/etims.ts`, but:

1. **No API route or service imports or calls it.** A recursive search of `apps/api/src`
   for `etims`, `Etim`, `ETIMS`, `createEtimProvider` returns **zero** matches. The
   adapter is dead code relative to the running application.
2. **There is no `EtimSubmission` persistence model** in `apps/api/prisma/schema.prisma`.
   There is no table to store external references, timestamps, correlation IDs, error
   information, retry counts or submission status.
3. **The `EtimStatus` enum is missing two states the release standard requires** —
   `NOT_SUBMITTED` (an ordinary KaziOS invoice that has never been offered to eTIMS) and
   `UNKNOWN` (a submission whose result is uncertain after a timeout). The current enum is
   only: `PENDING | SUBMITTED | ACCEPTED | REJECTED | FAILED | RETRYING`.
4. **The `EtimProviderImpl` HTTP endpoints are invented, not verified against the official
   KRA specification.** It calls `POST {apiUrl}/auth/token`, `/invoices`, `/credit-notes`,
   `/receipts`, and `GET {apiUrl}/submissions/{providerRef}`. These paths and the
   `client_credentials` auth shape have **not** been confirmed against KRA's published
   system-to-system API. They must not be relied on.

Overall eTIMS readiness classification: **BLOCKED EXTERNALLY** (adapter architecture
partially drafted, but unverified, unwired and not certifiable without KRA access).

## 2. What exists today (verified by inspection)

File: `packages/integrations/src/etims.ts`

- `EtimProvider` interface with `healthCheck`, `submitInvoice`, `submitCreditNote`,
  `submitReceipt`, `queryStatus`.
- `EtimStatus` type: `PENDING | SUBMITTED | ACCEPTED | REJECTED | FAILED | RETRYING`.
- Payload interfaces (`EtimInvoicePayload`, `EtimCreditNotePayload`, `EtimReceiptPayload`)
  that separate invoice, credit-note and receipt lifecycles.
- `StubEtimProvider` — the safe default. Its `submitInvoice` / `submitCreditNote` /
  `submitReceipt` **throw `EtimProviderNotConfiguredError`** and its `healthCheck` reports
  `unhealthy`. It **never fabricates an ACCEPTED result.** This is the correct, safe
  behaviour.
- `EtimProviderImpl` — a real HTTP client that authenticates, then posts to the invented
  endpoints listed above. It is only constructed when `ETIMS_API_URL`, `ETIMS_CLIENT_ID`
  and `ETIMS_CLIENT_SECRET` are all set.
- `createEtimProvider(config)` factory returns a `StubEtimProvider` unless all three of
  `apiUrl` / `clientId` / `clientSecret` are present.

Disabled by default: `.env.example` ships every `ETIMS_*` variable empty, and the factory
falls back to the throwing stub. This is the correct production-safe default.

## 3. Gaps against the required architecture

| Requirement | Status | Evidence / note |
|---|---|---|
| Adapter exists | PARTIAL | `etims.ts` present, but unwired and unverified |
| Separate internal vs. external invoice lifecycle | PARTIAL | Payload interfaces exist; no persistence or workflow to enforce separation |
| Provider handling outside core sales logic | PARTIAL | Isolated in package, but never invoked from sales routes |
| Explicit NOT_SUBMITTED / PENDING / ACCEPTED / REJECTED / RETRYABLE_FAILURE / UNKNOWN states | GAP | `NOT_SUBMITTED` and `UNKNOWN` are absent from the enum |
| Store external refs, timestamps, sanitized errors, correlation IDs | GAP | No `EtimSubmission` model in the schema |
| Idempotency and safe retries | GAP | No persistence layer to key idempotency against |
| Avoid duplicate submissions on uncertain timeout | GAP | No `UNKNOWN` state, no submission ledger |
| Preserve original invoice + audit trail | PARTIAL | Invoices exist and are immutable; eTIMS layer adds nothing |
| Credit-note / correction workflow per verified requirements | GAP | Payload type only; no verified KRA correction rules |
| Protect taxpayer info and credentials | PARTIAL | Secrets via env; no integration-specific handling |
| Validate invoice data before submission | GAP | No pre-submission validation hook exists |
| Handle unavailable service without marking accepted | PASS | Stub throws; never fakes success |
| Status visible to authorized users | GAP | No route, no UI, no status field |
| Documented reconciliation / support procedure | GAP | Not yet written |
| Production config disabled until access/approval | PASS | Empty env defaults to throwing stub |

## 5. Interim invoicing workflow for the pilot (MANDATORY)

Because the KaziOS eTIMS integration is not certifiable and the owner has no confirmed KRA
access, **every pilot business that is legally required to issue electronic tax invoices
must continue using an existing, KRA-compliant eTIMS solution or a KRA-verified
integrator.** KaziOS will produce an ordinary internal sales invoice / receipt only.

The pilot must clearly distinguish these five states in operations (not in software, since
the software does not submit to eTIMS):

1. **Ordinary KaziOS sales invoice / receipt** — generated by KaziOS. This is **not** a
   KRA tax invoice and must never be presented as one.
2. **Tax invoice actually submitted to eTIMS** — produced by the business's existing
   compliant eTIMS device/portal/integrator, not by KaziOS.
3. **Invoice confirmed accepted by eTIMS** — evidenced by the external system, not KaziOS.
4. **Invoice awaiting confirmation** — tracked by the business's external tool.
5. **Invoice processed through another compliant eTIMS solution** — the normal pilot path.

Operating rules for the interim arrangement:

- KaziOS receipts must carry a plain label such as "Sales receipt — not an eTIMS tax
  invoice" until eTIMS is wired and certified. (UI wording change: see PILOT_RUNBOOK.md.)
- The business must **not** issue two documents for the same sale (one from KaziOS, one from
  the eTIMS tool) in a way that could be read as duplicate tax invoicing. Recommend: the
  eTIMS tool of record produces the tax invoice; the KaziOS receipt is marked as an internal
  acknowledgement / non-tax receipt, OR the customer-facing tax invoice is produced only by
  the eTIMS tool.
- Confirm in writing that the pilot business understands it remains responsible for its own
  eTIMS/KRA compliance during the pilot.

KaziOS will **never** fabricate a control-unit identifier, receipt number, verification
code, QR code, signature or acceptance response. No `ETIMS_*` variable will be set in the
pilot environment, so the throwing `StubEtimProvider` remains active.

## 6. Outstanding KRA access / testing / approval steps (BLOCKED EXTERNALLY)

These cannot be completed by engineering and require the owner to obtain access:

1. Obtain a KRA eTIMS system-to-system integration agreement / onboarding for KaziOS as a
   software integrator.
2. Obtain sandbox credentials and the official technical specification (endpoints, payload
   schema, authentication, signing/certificate handling, QC/UAT process).
3. Verify or replace the invented endpoints in `EtimProviderImpl` against the official spec.
4. Obtain a taxpayer (TIN) test environment and complete KRA's QC / UAT / certification.
5. Add the `EtimSubmission` persistence model, `NOT_SUBMITTED`/`UNKNOWN` states, idempotency
   and a deterministic mock adapter; wire submit/status routes and UI.
6. Only then set the `ETIMS_*` variables in production and run a controlled rollout.

Official starting points (do not scrape, bypass auth, or hardcode credentials):

- https://www.kra.go.ke/business/etims-electronic-tax-invoice-management-system/learn-about-etims/etims-system-to-system-integration
- https://etims.kra.go.ke/

**A present adapter or a passing mock does not establish production eTIMS readiness or
certification.**


## 4. Testing without credentials

There is **no deterministic mock adapter** that simulates the required scenarios
(accepted, rejected, validation error, timeout, network failure, duplicate request,
duplicate response, unknown result, retryable / non-retryable error). The only "mock" is
`StubEtimProvider`, which throws for every submission. That satisfies "never masquerade as
KRA" but does not exercise the retry, idempotency or reconciliation logic the release
standard calls for.

Recommended next step (requires owner sign-off before implementation): add a
`MockEtimProvider` (clearly named `MOCK`, gated behind a non-production env flag) and an
`EtimSubmission` table, then wire a submit/status route with idempotency keys. **None of
this may touch live KRA systems.**
