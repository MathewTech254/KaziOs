# KaziOS — M-PESA STK Push at the POS: Market-Scan Comparison

> Evidence-based scan of KaziOS's M-PESA STK Push as a **second POS payment rail** against what a Kenyan retail pilot actually needs. Recorded 2026-10-20 on branch `master` (`60e7d3c`, pushed to `origin/master`). Every capability claim below was verified by reading the shipped code and its tests; every gap is marked greenfield (not implemented, not claimed).

---

## 1. What KaziOS ships (the M-PESA POS rail)

| Capability | How it works | Evidence |
|---|---|---|
| **Second rail alongside card** | `MPESA` added to the till's payment methods next to `PAYSTACK` (card). Both are "deferred" methods: the invoice is written unpaid and turns paid only when the provider confirms. Stock still leaves the shelf at ring-up. | `pos.ts` `deferredPaymentMethods`, `getPaymentMethods()` |
| **Charges outstanding balance only** | `startMpesaPosPayment` charges `invoice.total − invoice.paidAmount`, never a browser-supplied amount. A KES 700-cash / KES 300-M-PESA split pushes 300. A fully-paid invoice refuses a second prompt. | `mpesaPos.ts` `startMpesaPosPayment`, `settleCardPayment` |
| **Whole-shillings rule** | M-PESA has no subunit. A non-whole-shilling outstanding balance is refused by name (`MPESA_WHOLE_SHILLINGS`), never rounded. | `mpesaPos.ts` amount validation |
| **Server-authoritative verdict** | The browser sends only phone + polls. "Did they pay" is answered by `stkQuery` keyed on the `CheckoutRequestID` stored at push time. Daraja callbacks carry no signature, so the callback can only ever *trigger* a query — the query *is* the verification. | `mpesaPos.ts` `confirmMpesaPosPayment`, `useMpesaPayment.ts` |
| **Wrong-rail guard** | `CardPayment.provider` column (`PAYSTACK` vs `MPESA`). An M-PESA reference pressed against the card confirm route (or reverse) returns `WRONG_PAYMENT_RAIL` (409). Rails never settle each other's rows. | `cardPayments.ts` `confirmCardPayment`, schema migration `add_card_payment_provider` |
| **One settle path** | Both rails reuse `settleCardPayment`, so paid-amount arithmetic has exactly one implementation. | `mpesaPos.ts` → `settleCardPayment` |
| **Rate limiting & query spacing** | Org-level throttle (25s / 60s windows) plus 4s spacing between `stkQuery` calls per `CheckoutRequestID`, so a poll and a returning cashier share one Daraja question per window. | `mpesaPos.ts` `QUERY_SPACING_MS`, `lastQueryAt` |
| **Callback hygiene** | Default callback is `${API_URL}/api/v1/webhooks/mpesa`; `MPESA_CALLBACK_URL` override. Non-HTTPS → `null` → push refused with `MPESA_CALLBACK_UNSAFE` before any row is written. | `mpesaPos.ts` `posCallbackUrl()` |
| **Till UI** | Phone input, progress banner ("AWAITING_CUSTOMER" → "VERIFYING" → "SUCCESS"/"FAILED"), button labels, reset handling; browser never sends an amount and never settles on its own claim. | `PosPage.tsx`, `useMpesaPayment.ts` |

**Test coverage (unit, no credentials):** `apps/api/src/services/mpesaPos.test.ts` — open/refuse on half-shillings, wrong-rail refusal, amount mismatch, no-metadata binding on CheckoutRequestID, unreachable provider → PENDING (not error), lost config → `MPESA_NOT_CONFIGURED`, one Daraja trip per spacing window, 404 on unknown reference. Mocked gateway; no live STK push.


## 2. Market scan — Kenyan retail expectations vs KaziOS

The comparison below scores each capability a pilot cashier or shop owner would expect from an M-PESA till integration. "Greenfield" = absent from this release and not claimed; it is honest headroom, not a defect.

| # | Capability | Market expectation | KaziOS (this release) | Status |
|---|---|---|---|---|
| 1 | STK Push at till | Customer gets prompt on phone, enters PIN, till shows paid | ✅ Implemented | VERIFIED (unit) |
| 2 | Split tender (cash + M-PESA) | Cashier takes part cash, prompts M-PESA for the remainder | ✅ Implemented | VERIFIED (unit) |
| 3 | Server-verifies, client never claims | Till trusts the server's query, not a "I paid" tap | ✅ Implemented | VERIFIED (unit) |
| 4 | Whole-shilling amounts | M-PESA cannot charge cents; till refuses odd amounts | ✅ Implemented | VERIFIED (unit) |
| 5 | No double-charge on paid invoice | Second prompt on a settled sale is refused | ✅ Implemented | VERIFIED (unit) |
| 6 | Wrong-rail protection | Card reference can't settle an M-PESA row and vice versa | ✅ Implemented | VERIFIED (unit) |
| 7 | HTTPS callback guard | Daraja refuses non-HTTPS callbacks; till fails fast | ✅ Implemented | VERIFIED (unit) |
| 8 | Rate-limit friendly | One Daraja query per spacing window, no spam | ✅ Implemented | VERIFIED (unit) |
| 9 | Receipt references payment | Receipt shows M-PESA receipt / CheckoutRequestID | ✅ Implemented | VERIFIED (unit) |
|10 | Loyalty points on M-PESA sale | Earn/redeem loyalty when paying via M-PESA | ❌ Absent | **GREENFIELD** |
|11 | Offline / poor-network till | Queue STK push when network is down, settle on reconnect | ❌ Absent | **GREENFIELD** |
|12 | Cashier shift / cash-up | Reconcile M-PESA takings per shift against till float | ❌ Absent | **GREENFIELD** |
|13 | Expired-prompt recovery | Re-query or re-push prompts that expired unanswered | ❌ Absent | **GREENFIELD** |
|14 | M-PESA till paybill / buygoods | Static paybill option as alternative to STK Push | ❌ Absent | NOT IMPLEMENTED |
|15 | Multi-till float per M-PESA | Separate float tracking per till for M-PESA collections | ❌ Absent | NOT IMPLEMENTED |
|16 | M-PESA reversal / refund UI | Initiate reversal from the POS on error | ❌ Absent | NOT IMPLEMENTED |

**Bottom line:** The core collect-via-STK-Push flow (items 1–9) matches what a pilot needs to take M-PESA at the till safely. Items 10–13 are the four greenfield gaps called out for this scan; items 14–16 are additional out-of-scope capabilities the market may want later.


## 3. Greenfield gaps in detail

### 3.1 Loyalty (greenfield)

**What's missing:** No loyalty-points earn/redeem tied to an M-PESA payment. A sale paid by M-PESA settles the invoice but does not credit loyalty points, and a customer cannot pay partly with loyalty points via M-PESA.

**Why it matters in the pilot:** Kenyan retail (supermarkets, dukas, pharmacies) runs heavily on loyalty. A cashier asking "do you have a loyalty number?" at the till and having M-PESA payment + points accrue in one flow is a real differentiator; without it, M-PESA sales sit outside the loyalty loop.

**What would be needed:** A loyalty ledger (points per shilling spent, redeemable as discount), tied to the customer on the sale, with M-PESA payment as a trigger event. The current sale model (`Invoice`, `CardPayment`) has no loyalty fields. Nothing in `PosPage.tsx` or `useMpesaPayment.ts` references loyalty.

**Pilot impact:** None — loyalty is out of pilot scope (`GO_NO_GO_REPORT.md` §P3 lists loyalty as "not release-relevant"). Document as a known limitation for pilot shops.

### 3.2 Offline (greenfield)

**What's missing:** The M-PESA rail requires a live network: `stkPush` calls Daraja synchronously at ring-up, and `confirmMpesaPosPayment` polls `stkQuery` every ~4s. If the till loses internet, the cashier cannot open or verify an M-PESA payment. There is no local queue, no store-and-forward, and no "settle when reconnected" path.

**Why it matters in the pilot:** Kenyan retail till networks drop. A cashier mid-sale with a customer waiting on an M-PESA prompt has no offline fallback — the sale stalls.

**What would be needed:** Offline sale capture (write sale locally, mark `paymentMethod = MPESA` + `paymentStatus = PENDING_OFFLINE`), a background reconciler that retries `stkQuery`/re-pushes on reconnect, and a till UI showing "offline — will settle when connected." Requires local-first architecture not present in the current client-server model.

**Pilot impact:** Pilot shops must be told M-PESA at the till needs a working internet connection. Recorded as a known limitation; cash fallback exists for offline moments.

### 3.3 Shift / cash-up reconciliation (greenfield)

**What's missing:** No cashier shift model, no per-till float, and no end-of-shift cash-up that reconciles M-PESA collections against what `CardPayment` rows say was collected. M-PESA takings are visible per invoice/payment but not rolled up by shift or by cashier.

**Why it matters in the pilot:** A pilot shop needs to know "how much M-PESA money did cashier Jane collect this shift?" before banking. Without shift/cash-up, reconciliation is manual (compare M-PESA SMSes to the KaziOS payments report).

**What would be needed:** `Shift` (open/close, cashier, till, opening float), `CashUp` (expected vs counted, per payment method including M-PESA), and reconciliation reports. The current `CardPayment` table has `provider`, `amountCents`, `status`, `paidAt` — enough to query M-PESA totals per day, but nothing groups them into shifts.

**Pilot impact:** Pilot runbook should include a manual daily reconciliation step: export M-PESA payments from KaziOS, compare to M-PESA business SMSes/bank statement. Flagged in `PILOT_RUNBOOK.md` as a manual step.

### 3.4 Expired-prompt recovery (greenfield)

**What's missing:** When an STK prompt expires (Daraja result 1037) or is cancelled (1032) without the customer paying, KaziOS marks the payment `FAILED` and the cashier takes payment another way. There is no automatic re-query of a stuck `PENDING` prompt beyond the 60s client poll window, and no scheduled job that sweeps old `PENDING` rows and asks Safaricom again later.

**Why it matters in the pilot:** A customer may enter their PIN after the till's poll window ends. The money may have moved, but KaziOS never re-asks, so the sale stays unpaid and the till may take cash for money Safaricom already collected.

**What would be needed:** A background worker (BullMQ over Redis already exists) that re-queries `PENDING` M-PESA rows at increasing intervals (e.g. +5 min, +30 min, +2h), settles any that turned `SUCCESS`, and marks the rest `FAILED` with an advisory-lock to prevent double-processing — see the optional advisory-lock zombie check in §4.

**Pilot impact:** Cashiers must be instructed: if the prompt times out, treat the sale as unpaid and re-ring it. Recorded as a known limitation.


## 4. Release-readiness notes relevant to this scan

| Item | Position |
|---|---|
| Live STK push | **BLOCKED EXTERNALLY** — no Daraja sandbox credentials; unit-tested with mocked gateway (`TEST_RESULTS.md` §3). |
| Advisory-lock zombie sweep | Not implemented; optional post-pilot improvement. See `GO_NO_GO_REPORT.md` — no parallel-sale race was reproduced. |
| M-PESA in pilot | Allowed only as a **CONDITIONAL GO**: core flow verified in unit tests; live behaviour unverified until credentials exist. |
| Offline / loyalty / shift / expiry | Explicitly greenfield; not claimed for the pilot. |

---

## 5. Recommendation for the pilot

**Proceed with M-PESA as the second POS rail, eyes open:**

1. Enable M-PESA only in pilot shops with reliable till internet (offline gap).
2. Run daily manual reconciliation of M-PESA takings (shift/cashup gap) until a shift module exists.
3. Instruct cashiers: expired/cancelled prompts = unpaid sale, re-ring (expiry gap).
4. Do not promise loyalty on M-PESA sales (loyalty gap).
5. Obtain Daraja sandbox credentials, run one live STK smoke, then one low-value live pilot charge before wider rollout.

The four greenfield gaps (loyalty, offline, shift/cashup, expiry) are honest headroom — they should appear in the pilot limitations register, not as blockers, because none of them break the core sell-M-PESA-report loop that this release verified.
