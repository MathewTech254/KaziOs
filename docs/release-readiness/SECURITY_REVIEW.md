# KaziOS — Security Review

> Reviewed 2026-10-12 on branch `master`. **No secret values are reproduced anywhere in this
> document** — only variable names and locations. No credentials were rotated and no Git
> history was rewritten (owner authorization required for both).

## 1. Positive findings (verified in code / by test)

| Control | Status | Where |
| --- | --- | --- |
| Tenant isolation enforced server-side | VERIFIED | `lib/scope.ts`, route queries all filter `organizationId`; `smoke-tenant-isolation.ps1` 14/14 — cross-tenant reads/writes rejected, no data changed. |
| Password hashing | VERIFIED | `lib/auth.ts` (bcrypt). |
| Paystack webhook signature | VERIFIED | `isValidWebhookSignature` — HMAC-SHA512 via `createHmac("sha512")` + `timingSafeEqual`. Secret never logged. |
| Paystack secret key server-side only | VERIFIED | Only API reads `PAYSTACK_SECRET_KEY`; smoke asserts it is never returned to the browser. |
| Server-authoritative money | VERIFIED | POS/invoice totals recomputed server-side; declared-total exploit rejected (`smoke-money.ps1`). |
| Security headers | VERIFIED | `helmet()` applied globally (`index.ts`). |
| CORS allow-list | VERIFIED | `getCorsOrigins()` from `CORS_ORIGIN`; no wildcard by default. |
| Rate limiting | VERIFIED | `authLimiter` on `/api/v1/auth`, `apiLimiter` on `/api/v1`; health & webhooks sit above the limiters and are trusted by signature, not session. |
| Production env guard | VERIFIED | `lib/productionEnv.ts` — `assertProductionEnv` blocks unsafe prod defaults. |
| Secrets not printed in logs | VERIFIED | Money/paystack code paths log identifiers, never keys. |

## 2. Findings & residual risks

| # | Severity | Finding | Remediation | Residual risk |
| --- | --- | --- | --- | --- |
| S1 | P3 | `.env` files exist locally with live-looking keys; not in Git (confirmed `.gitignore`), but local exposure persists. | Rotate any key that has ever left the machine. Ensure `.env*` stay ignored. | Local-only. |
| S2 | P3 | `EMAIL_PROVIDER=console` in dev → reset links visible in logs. Correct for local; must be `resend` in production. | Deployment checklist enforces provider + key in prod. | Prod misconfig only if checklist skipped. |
| S3 | P3 | No dependency-vulnerability scan was run (`npm audit` not executed this session). | Run `npm audit --production` in CI; enable Dependabot. | Unknown until scanned. |
| S4 | P2 | M-PESA webhook cannot be signature-verified (Daraja does not sign). It is deliberately built to only re-query, never settle on its own. | Keep the re-query-only design; document that the callback is untrusted. | Acceptable by design; monitor. |
| S5 | P3 | Concurrent final-unit sale race not stress-tested. | Single-transaction deduction + 409 guard present; add a parallel stress test before scaling. | Low for single-till pilot. |

No P0/P1 security defect was reproduced. Cross-tenant access — the highest-value attack for a
multi-tenant retail platform — was tested adversarially and held on every resource.

## 3. GitHub repository security settings

Recommend enabling (requires owner authorization — not changed here): **Dependabot** alerts &
updates, **secret scanning** + **push protection**, and **code scanning** (CodeQL) on PRs. The
repo already has CI workflows (`.github/workflows/ci.yml`, `main.yml`, `migrate-production.yml`);
fold the above into the PR checks.

## 4. Vulnerability reporting

See `SECURITY.md` (created in this engagement) for the disclosure process. Report privately to
the maintainer; do not open a public issue for an unpatched vulnerability.
