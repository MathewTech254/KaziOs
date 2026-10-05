# Subscriptions and entitlements

KaziOS ships with a free Community plan and the architecture to monetise above it without a
rewrite. This document explains the shape, the rules it holds to, and how to change it.

## The model

```
Business (Organization)
    └─ Subscription            one per business, the authority on what it paid for
         └─ Plan               the sellable unit: name, prices, features, limits
              ├─ PlanPrice     one price per billing interval
              ├─ PlanFeature   which capabilities it turns on
              └─ PlanLimit     which allowances it sets
Feature                        the closed catalogue of capabilities
UsageRecord                    metered consumption, per period
EntitlementOverride            an attributable exception above a plan
SubscriptionEvent              append only history
SubscriptionPayment            invoices and payment records
```

Plans are **rows, not constants**. An administrator can re-price a plan, retire one, or add
a third billing interval as a data change. No component hardcodes a plan name, a price or a
feature string.

## One authority, not scattered checks

Every question about what a business may do is answered in
`apps/api/src/services/entitlements.ts`. Routes ask it; nothing else decides.

```ts
const entitlements = await getEntitlements(organizationId);

await assertFeature(entitlements, FEATURE_KEYS.MULTI_BRANCH);
await assertWithinLimit(entitlements, LIMIT_KEYS.BRANCHES);
```

The frontend reads the same answer from `GET /billing/entitlements` to decide what to draw.
**That is a display aid and never the enforcement.** Hiding a button stops an honest user;
editing the JavaScript, calling the API with curl or replaying a request does not. Every
route the interface hides anything behind checks again on the server.

## Two kinds of limit

`PlanLimit.source` decides how an allowance is measured, and getting this right is the
difference between a limit that is true and one that is merely stored.

| Source | How it is measured | Limits |
|---|---|---|
| `COUNTED` | Live rows, read at the moment of the check | `users`, `branches`, `products` |
| `METERED` | Accumulated counters in `UsageRecord` | `monthly_transactions`, `ai_requests`, `api_requests`, `storage_megabytes` |

A counted limit is read from the tables because that is the same number the customer is shown
in billing. A stored counter that had drifted would refuse a customer who is within their
allowance. A metered limit is an event that leaves no row behind, so it is counted as it
happens, with an atomic increment so two tills selling at the same moment cannot lose a count
between them.

`-1` means unlimited, deliberately not a very large number.

## Status is derived, never trusted

`resolveStatus()` computes what a subscription's state **is right now** from the dates, on
every read:

```
stored CANCELED / PAUSED / EXPIRED  -> taken at face value (decisions, not dates)
trialEndsAt in the future           -> TRIALING
no currentPeriodEnd                -> ACTIVE forever (Community; nothing was paid)
currentPeriodEnd in the future     -> ACTIVE
period ended, graceEndsAt ahead    -> GRACE   (the business keeps working)
otherwise                          -> EXPIRED
```

The stored `status` column is the last transition the system deliberately made. It is *not*
what the product acts on, because dates pass whether or not the process is running: nobody
reloads the page on the night a card fails. The worker's sweep writes those transitions down
so the admin area and the ledger agree with the checks — it is a report that catches up, not a
thing the product depends on.

## Money

Subscription billing reuses the existing Paystack layer (`lib/paystack.ts`) and the existing
webhook route rather than introducing a second gateway client. The rules:

1. **Nothing activates from a browser.** `openCheckout` only opens. `confirmCheckout` asks
   Paystack what happened, and only then activates.
2. **The amount comes from the plan.** Never from the request. A price a browser sends is a
   price the customer chooses.
3. **The confirmed amount is checked.** A mismatch raises rather than being recorded, so a
   real charge for the wrong number can never grant a plan.
4. **Activation is idempotent.** A replayed webhook does nothing. `activateSubscription` takes
   a `paymentId` and returns early if it is already `SUCCESS`.
5. **An unknown reference is a 404, not an acknowledgement.** Handing back a success that was
   never applied is how a provider stops retrying a payment that will not work.
6. **Only a brand and four digits are stored.** The full number and the token belong to the
   provider.

## Continuity

| Event | What happens to the business | What happens to its data |
|---|---|---|
| Payment fails | `PAST_DUE`, then `GRACE` for 7 days | Nothing |
| Grace runs out | `EXPIRED`, paid capabilities withdrawn | Nothing |
| Payment succeeds | `ACTIVE`, new period, grace cleared | Nothing |
| Cancellation | Ends at the close of the paid period | Nothing |
| Downgrade | Applied at the end of the paid period | Nothing |
| Reaches a limit | The one thing needing more room is refused | Nothing |

Two rules make this survivable:

- **Core features are never withdrawn.** Every `CORE` capability is granted to every plan,
  always. An expired subscription loses paid capabilities; it never loses the till, the stock
  or the customers. `getEntitlements` strips non-core features for an inactive subscription
  and nothing else.
- **A business already over a limit keeps everything.** Downgrading from Business to Community
  while holding three branches leaves all three in place and simply refuses a fourth. Deleting
  their branches to make the number fit would destroy a business's records to satisfy a price
  list. `isAtLimit` is deliberately "still over" rather than "allowed again".

## Upgrade, downgrade, cancel

`planChangeOutcome()` decides the direction in one place, so the pricing page and the checkout
that follows it cannot disagree:

- **Upgrade** takes effect the moment payment is confirmed.
- **Downgrade** is scheduled for the end of the paid period, and can be withdrawn until then.
- **Cancellation** is at the end of the paid period unless `immediate` is asked for, and the
  ledger records which happened.

## Open core

`Feature.category = CORE` is the open source product: POS, products, customers, inventory,
purchasing, reports, roles, accounting and self hosting. It is on every plan including
Community, and it is never gated. A self hosted KaziOS has to remain a complete business.

Everything above that is the commercial layer, and each of those features has a server side
check. `Feature.available` is the honesty guard for the pricing page: a capability can exist
in the catalogue and be granted by a plan before it has a screen anyone can reach, and the
public catalogue only lists available ones. Promoting one is a deliberate one line change
once its enforcement exists.

Today that means the advertised differences are **scale and locations**, which the code
enforces today:

| Plan | Users | Branches | Products | Sales / month |
|---|---|---|---|---|
| Community | 3 | 1 | 200 | 1,000 |
| Starter | 5 | 3 | 1,000 | 10,000 |
| Business | 25 | 15 | 20,000 | 100,000 |
| Enterprise | unlimited | unlimited | unlimited | unlimited |

Enterprise is quoted, so it has **no `PlanPrice` row at all**. A price of 0 would read as
"free" to anything that sums prices, which is exactly the mistake the table exists to prevent.
It is `PRIVATE`, so the pricing page does not offer it and only sales can grant it.

## Selling an exception

`EntitlementOverride` is the supported way to go above a plan, rather than inventing a plan per
customer:

```bash
POST /api/v1/platform/overrides
{ "organizationId": "...", "featureKey": "multi_branch", "value": true,
  "reason": "Contract: East Africa rollout" }
```

Every override carries a reason and an optional expiry, and an override only ever **adds** — it
cannot withdraw a core feature.

Note that a feature and a limit are separate. Granting `multi_branch` opens the gate; it does
not raise `branches`. Both are asserted separately in the integration suite, because a
business granted a capability for a negotiated reason may still be held to the plan's own
numbers.

## Platform administration

`PlatformAdmin` is a separate table from `Role`, on purpose. A business Owner holds `*` inside
their own organization and that must mean nothing at all on the platform. Platform authority is
granted deliberately, by scope (`platform.read`, `platform.billing`, `platform.plans`,
`platform.support`), and is revocable without touching a business's roles.

`GET /api/v1/platform/overview` reports businesses, subscriptions by status, revenue from
payments that actually settled this month, trials, failed payments and recent events. Every
figure is a live aggregate: a denormalised counter on that page would eventually disagree with
the subscriptions it claims to summarise.

## Adding things

**A new feature.** Add the key to `FEATURE_KEYS` in `packages/types`. Add a `Feature` row with
the right category. Add `PlanFeature` rows for the plans that grant it. Call `assertFeature` on
the routes that own it. Set `available = true` when it has a screen a customer can reach.

**A new limit.** Add the key to `LIMIT_KEYS`. Add `PlanLimit` rows with the right `source`,
`unit` and `period`. Call `assertWithinLimit` before the write. Add a counter function in
`services/usage.ts` if it is metered.

**A new plan.** Insert `Plan` and `PlanPrice` rows. Nothing in the code needs to change; the
pricing page, the billing tab and the platform overview all read from the database.

## Checking it

```bash
npm run test:unit          # status resolution, feature and limit enforcement, billing
npm run test:integration   # enforcement over real HTTP against a real database
npx ts-node src/utils/checkPlans.ts   # prints the catalogue and a new business's entitlements
```

`checkPlans.ts` exists because the failures that matter here are only visible against a real
database: a column the client expects but the migration did not add, a catalogue that was
never seeded, a business with no subscription. Each reports as a generic 500 from a route.

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `ENTITLEMENT_CACHE_TTL_MS` | `15000` | How long a resolved snapshot is reused. `0` disables the cache. |
| `SUBSCRIPTION_SWEEP_MS` | `3600000` | How often the worker reconciles subscriptions. |

The plan catalogue is seeded by the migration
`20261010090000_subscriptions_and_entitlements`. It is safe to apply: no business data is read,
written or deleted, and every existing organization and subscription is backfilled onto
Community, which is what it already had in practice.