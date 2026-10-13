# KaziOS Deployment Checklist

Manual actions the owner must perform to deploy and operate KaziOS. **Never includes
secret values — only variable names and actions.** Generated during the release-readiness
audit.

## 1. Required external services

- **PostgreSQL** — primary database (Prisma). Must be a managed, backed-up instance for
  production.
- **Redis** — sessions and rate-limit/cache state. Verify it is secured (auth + no public
  exposure).
- **Node.js** — match `.nvmrc` (API + worker + web build).

## 2. Environment variables (by name — set real values in the host, not in Git)

Core:
- `NODE_ENV=production`
- `DATABASE_URL`, `REDIS_URL`
- `SESSION_SECRET`, `JWT_SECRET`, `ENCRYPTION_KEY` — long random secrets, never committed
- `JWT_EXPIRES_IN`, `BCRYPT_ROUNDS`
- `APP_URL`, `API_URL`, `APP_PORT`, `API_PORT`, `PORT`
- `CORS_ORIGIN` — exact allowed origins (pages URL + custom domain). Comma-separated list.
- `LOG_LEVEL` — production-appropriate (do not run at debug)
- `RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_MAX`

Feature / registration controls:
- `ENABLE_REGISTRATION` — set to `false` for a controlled pilot to prevent open sign-ups.
- `ENABLE_DEMO_SEED` — set to `false` in production.

Payments (test vs. live kept separate):
- `PAYSTACK_SECRET_KEY`, `PAYSTACK_PUBLIC_KEY`, `PAYSTACK_WEBHOOK_SECRET`
- M-Pesa (optional): `MPESA_CONSUMER_KEY`, `MPESA_CONSUMER_SECRET`, `MPESA_SHORTCODE`,
  `MPESA_PASSKEY`, `MPESA_ENVIRONMENT`

eTIMS / KRA — **leave all empty for the pilot** (integration disabled / throwing stub):
- `ETIMS_API_URL`, `ETIMS_CLIENT_ID`, `ETIMS_CLIENT_SECRET`, `ETIMS_CERTIFICATE`,
  `ETIMS_TIN`, `ETIMS_PHYSICAL_ADDRESS`, `ETIMS_MANUFACTURER_NAME`, `ETIMS_MAIN_ACTIVITY`,
  `ETIMS_SUBCATEGORY`

Notifications & storage:
- `EMAIL_PROVIDER` (set `resend` + `EMAIL_API_KEY` + `EMAIL_FROM` + `EMAIL_FROM_NAME` for
  real email; otherwise stays in **console mode** and password-reset links are NOT
  delivered), `SMS_*`, `WHATSAPP_*`
- `OBJECT_STORAGE_*` — configure durable object storage for any uploads; local disk is not
  production storage.

AI (optional): `AI_PROVIDER`, `AI_API_KEY`, `AI_MODEL`, `AI_MAX_TOKENS`, `AI_TEMPERATURE`.

Subscription/entitlement tuning: `ENTITLEMENT_CACHE_TTL_MS`, `SUBSCRIPTION_SWEEP_MS`.

## 3. Migrations

Run migrations as an explicit deploy step (do not rely on `db push` in production):

```
cd apps/api
npx prisma migrate deploy
```

Current migration set (16, all additive — none destructive in this audit):
`init` ×2, `activate_owner_accounts`, `pos_vertical_slice`,
`organization_scoped_settings`, `stock_transfer_tenant_scope`,
`purchase_order_hardening`, `purchase_order_tax_rate`, `purchase_order_item_cascade`,
`password_reset_tokens`, `card_payments`, `notification_realtime`,
`expenses_vertical_slice`, `subscriptions_and_entitlements`,
`paystack_recurring_billing`, `pricing_in_kes`.

> Do not run `prisma migrate reset` or any destructive migration against production. If a
> future migration could remove or reinterpret data, stop and get approval.

## 4. Startup & processes

- API: `npm run start --workspace=@kazios/api` (built) — do not run `ts-node-dev` in prod.
- Worker: `npm run start --workspace=@kazios/worker` — background jobs and the subscription
  sweep must be running.
- Web: build `@kazios/web` and serve static assets.

## 5. Pre-deploy verification

- `npm run typecheck` — must be clean.
- `npm run lint` — clean (no new errors).
- API unit tests (`npx jest --testPathPattern='.*\.test\.ts$'` in `apps/api`) — green.
- Web tests (`npm run test --workspace=@kazios/web`) — green.
- Health endpoint returns `{ "status": "ok" }`.
- Security middleware confirmed active: `helmet()`, CORS allow-list, `express-rate-limit`
  (auth limiter + api limiter), `app.set("trust proxy", 1)` for correct client IPs behind
  the proxy, and secure cookies when `NODE_ENV=production`.

## 6. Production-config guards

The app exports `assertProductionEnv`, `corsOriginWarning` and `productionEnvProblems`
(from `apps/api/src/lib/productionEnv.ts`) and logs a CORS warning on startup. Ensure the
deploy fails fast or is alerted when required secrets are missing in production.

## 7. Backups & recovery

- Enable automated daily PostgreSQL backups on the managed instance, plus point-in-time
  recovery where available.
- **Restore test:** perform at least one restore into a scratch environment and verify the
  app connects and reports consistent sales/inventory totals. A scheduled backup command
  alone does not count as verified.
- Document retention and how the owner requests a restore.

## 8. Rollback

- Deploy immutable builds; keep the previous build/image tag to roll back.
- Migrations here are additive; if a rollback is needed after a migration, coordinate a
  forward-fix rather than a destructive down-migration.
- Paystack webhook/config changes: revert keys to prior values and re-deploy the previous
  build.

## 9. Manual owner actions (must be done by the owner)

- Provision Postgres + Redis; set all env vars above in the host's secret store.
- Set Paystack live keys + webhook secret + configure the webhook URL in the Paystack
  dashboard (test keys remain separate).
- Configure DNS + HTTPS for `APP_URL` / `API_URL`.
- Set `ENABLE_REGISTRATION=false` and `ENABLE_DEMO_SEED=false` for the pilot.
- Configure real email (`EMAIL_PROVIDER=resend`) if password reset must actually deliver.
- Confirm the eTIMS interim workflow with each pilot business (see ETIMS_READINESS.md).
- Perform and evidence one backup restore test before go-live.

## 10. Card money routing — split payments (subaccounts)

**Decision required before any real shop card payment.** The question is *whose bank
account receives the money* when a customer pays a shop by card.

- **Option A — one central Paystack account:** every pilot shop's card money settles to a
  single settlement account, which the platform owner then re-settles by hand. Fastest, but
  the KYC on that account must match whoever legally receives funds, and re-settlement needs
  an explicit written agreement with each shop. **Not the intended end state.**
- **Option B — split payments (implemented):** the platform Paystack account is the
  "platform"; each shop is created as a **Paystack subaccount** with the shop's own bank
  account. A card charge is split so the shop's subaccount is paid directly and the platform
  keeps its fee. Chosen for the pilot because each shop is paid cleanly and KYC is per shop.

How the implemented (Option B) flow works:

1. In the **Paystack dashboard**, create a **subaccount** for each pilot shop (verified
   business bank account). Record the subaccount code (e.g. `ACCT_xxxx`).
2. In KaziOS **Settings → Payments**, set that shop's:
   - `subaccountCode` — the Paystack subaccount code for this organisation.
   - `platformFeePercent` — the platform's cut (0–100%); converted to cents at charge time.
   - `platformFeeCents` — optional flat fee that overrides the percent when non-zero.
3. Per-org values are stored in the `Setting` table (no migration). **With no subaccount
   code set, the split is disabled** and the charge settles to the platform account exactly
   as before — so the pilot is unaffected until a shop opts in.
4. Money routing is decided **server-side only** (`cardSplit.ts` / `cardPayments.ts`). The
   browser can never choose the subaccount or fee. `bearer_type: "account"` means the
   platform absorbs Paystack's processing fee, so the shop receives exactly its share.

Before go-live, confirm the platform account's own KYC is a verified KaziOS business account
and run one **live test-mode split** end-to-end for a single shop before enabling others.


