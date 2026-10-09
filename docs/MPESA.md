# M-PESA subscription payments (Safaricom Daraja)

KaziOS charges subscriptions over two independent rails. Paystack (card) is untouched by
this feature; M-PESA gets its own routes, its own rows (`SubscriptionPayment.provider =
"MPESA"`), and its own webhook. References can never cross between them.

## How the rail works (the rules the code enforces)

1. **Opening only opens.** `POST /api/v1/billing/checkout/mpesa` writes a `PENDING` row
   priced from the plan's **KES price row** (never from the request, never converted at a
   made-up exchange rate) and sends an STK Push to the customer's phone.
2. **The re-query is the verification.** Daraja callbacks carry **no signature** — there
   is no HMAC equivalent — so `POST /api/v1/webhooks/mpesa` never believes its payload.
   It may only cause `stkQuery`, asked with our own credentials keyed on the
   `CheckoutRequestID` stored at push time. The browser's "I'm back" button goes through
   the same question (`POST /billing/checkout/mpesa/confirm`).
3. **Whole shillings only.** M-PESA has no subunit: the charge is `amountCents / 100`
   from the plan row. A KES price that is not whole shillings is refused by name rather
   than rounded.
4. **No card token, no auto-renewal.** M-PESA payments never touch
   `syncRecurringBilling`; renewal falls back to the manual path (grace period, reminders,
   another checkout), which is the documented fallback for any payment without a token.

---

## 1. Get sandbox credentials from the Daraja portal

1. Go to <https://developer.safaricom.co.ke> and sign up / log in (an OTP is sent to a
   Safaricom number).
2. Open **My Apps → Create App** (call it `KaziOS sandbox`). The app page shows your
   **Consumer Key** and **Consumer Secret** — copy both.
3. On the same app, add/subscribe to the **M-PESA Express** product (also called
   *M-PESA Express (STK Push)* or *Lipa na M-PESA Online*). This is what permits STK Push.
4. Get the sandbox **Shortcode** and **Passkey**: in the portal's sandbox / STK Push
   section (some versions show a **Get SandBox Credentials** button), Safaricom publishes
   a test PayBill shortcode — commonly `174379` — together with its passkey. Copy both
   exactly; the passkey is long and case-sensitive.
5. Test phone numbers: Safaricom publishes sandbox MSISDNs (commonly `254708374149` and
   `254711082532`). Your own Safaricom-registered number usually receives the prompt in
   sandbox as well. **Sandbox prompts do not debit real money.**

## 2. Put them in `apps/api/.env`

The API reads `apps/api/.env` first. Add:

```env
MPESA_CONSUMER_KEY="<consumer key from the app page>"
MPESA_CONSUMER_SECRET="<consumer secret from the app page>"
MPESA_SHORTCODE="174379"
MPESA_PASSKEY="<sandbox passkey>"
MPESA_ENVIRONMENT="sandbox"
```

Restart the API (`npm run dev:api`). The M-PESA option appears in **Settings → Billing**
only when all four of `CONSUMER_KEY`, `CONSUMER_SECRET`, `SHORTCODE` and `PASSKEY` are
set — with any of them empty, the Billing tab is byte-for-byte the card-only interface.

## 3. The callback URL must be HTTPS (Daraja's rule)

`stkPush` sends `CallBackURL` with every push, and **Safaricom rejects the push outright
if it is not HTTPS**. The URL used is:

1. `MPESA_CALLBACK_URL` if set, otherwise
2. `${API_URL}/api/v1/webhooks/mpesa`.

**Production (e.g. Render):** set `API_URL` to your public API origin
(`https://kazios.onrender.com`) and the default is already correct. Nothing else to do.

**Local development:** `http://localhost` will be refused by Safaricom, so a tunnel is
required:

```powershell
# in a second terminal, from anywhere:
ngrok http 4000
# copy the https URL it prints, then in apps/api/.env:
# MPESA_CALLBACK_URL="https://abcd-123-456.ngrok-free.app/api/v1/webhooks/mpesa"
```

Restart the API after setting it. (Cloudflared quick tunnels work the same way. The free
ngrok interstitial page affects browsers only, not Safaricom's server-to-server POST.)

Without a reachable callback nothing is *mis-settled* — the callback can only ever trigger
a query — but without an **HTTPS** URL the push itself is refused (error code
`MPESA_CALLBACK_UNSAFE` is KaziOS's own fail-fast version of that rule).

---

## 4. Run a test purchase end to end

1. `npm run dev` (web :3000, api :4000), sign in as an owner.
2. **Settings → Billing.** Under *Change plan* / *Upgrade*, the method selector now
   shows **Card | M-PESA** — pick **M-PESA**.
3. Enter a phone number (`0712 345 678` style; it is normalised to `254…` server-side)
   and press **Send M-PESA prompt**.
4. The prompt appears on the phone; enter the M-PESA PIN. The page asks Safaricom every
   three seconds and flips to *Payment received* the moment the query says success. The
   Daraja callback (if reachable) usually settles it first — either way both go through
   the same re-query.
5. **Payment history** shows the attempt with `provider = MPESA`, `SUCCESS`, and the
   M-PESA receipt stored as the payment's provider reference.

A cancelled prompt (result code 1032) or an expired one (1037) is reported in plain
language and the plan is untouched; nothing is granted until the query says success.

## 5. Going live with production credentials

1. In the portal, complete the **Go Live** process for your app to obtain a **production
   shortcode** (your own PayBill) and its **live passkey**, plus live consumer
   key/secret.
2. In `apps/api/.env` (or the Render environment): set `MPESA_ENVIRONMENT=production`
   and swap all four values. Keep `API_URL` pointing at the public HTTPS origin so the
   callback default resolves correctly.
3. Redeploy and do one real low-value purchase (the catalogue's cheapest plan) before
   announcing it.

## Troubleshooting

| Symptom | What it means |
| --- | --- |
| No M-PESA option in Billing | One of the four credential vars is empty. `mpesaEnabled` is false; the selector is hidden on purpose. |
| `MPESA_CALLBACK_UNSAFE` | The callback URL is not HTTPS. Set `MPESA_CALLBACK_URL` to a tunnel locally, or `API_URL` to the public origin in production. |
| `MPESA_NOT_CONFIGURED` | Same four vars, but the request reached a server that cannot see them — restart the API after editing `.env`. |
| `MPESA_PRICE_UNAVAILABLE` | The plan has no **KES** price row for that interval. Add one (prices are rows, editable without a deployment). |
| `MPESA_WHOLE_SHILLINGS` | The KES price has a non-zero cents part; M-PESA can only charge whole shillings. Re-price to a whole amount. |
| Prompt never arrives | Wrong shortcode/passkey for the environment, or the phone number is not a valid Safaricom MSISDN (`2547…` / `2541…`). |
| "The prompt was cancelled / expired" | Result codes 1032 / 1037 — the customer did not answer in time. Nothing was charged; start again. |
| Webhook row stuck `RECEIVED`/`FAILED` | Safaricom could not be re-queried at that moment; the next confirm (UI) settles it. Redeliveries retry automatically. |

## Tests

`apps/api/src/services/mpesaBilling.test.ts` covers this rail without any credentials:
price-from-row, no-activation-on-open, PENDING/FAILED/SUCCESS verdicts, amount mismatch,
replay idempotency, wrong-rail refusal, unreachable provider, and the HTTPS guard. The
Paystack suite (`billing.test.ts`) is untouched by this feature.

