import { prisma } from "../lib/prisma";
import { AppError } from "../middleware/errorHandler";
import {
  FEATURE_CATEGORIES,
  LIMIT_KEYS,
  LIMIT_SOURCES,
  SUBSCRIPTION_STATUS,
  UNLIMITED,
  USAGE_WARNING_RATIO,
  type SubscriptionStatus,
} from "@kazios/types";
import { currentUsage } from "./usage";

/**
 * The one place that answers "what is this business allowed to do".
 *
 * Every authorization question about a plan is asked here: the routes that gate a
 * feature, the branch that refuses a second location, the billing page that draws a
 * usage bar. Nothing anywhere else is allowed to compare a plan name to a string, which
 * is what stops a limit from being enforced in eleven places with eleven slightly
 * different rules.
 *
 * The shape of the answer is a snapshot: a plan, a set of feature keys, a map of limits
 * and a status derived from the clock. It is computed once and reused for a few seconds
 * so a page that renders twenty rows does not run twenty identical queries.
 */

export interface ResolvedLimit {
  key: string;
  /** The allowance, or UNLIMITED (-1). */
  value: number;
  source: string;
  unit: string;
  period: string;
  /** Where the number came from, so a surprising allowance can be explained. */
  origin: "PLAN" | "OVERRIDE" | "NONE";
}

export interface EntitlementSnapshot {
  organizationId: string;
  hasSubscription: boolean;

  planKey: string;
  planName: string;
  planDescription: string;
  planIsFree: boolean;
  planTrialDays: number;

  /** The status as the clock says it is now, not merely what was last written. */
  status: SubscriptionStatus;
  /** What was last deliberately written, kept for display and for the ledger. */
  storedStatus: string;

  /** True while the business may use what its plan grants. */
  isActive: boolean;
  inGrace: boolean;
  isExpired: boolean;
  isTrialing: boolean;

  features: Set<string>;
  limits: Map<string, ResolvedLimit>;

  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  trialEndsAt: Date | null;
  graceEndsAt: Date | null;
  cancelAtPeriodEnd: boolean;
  endsAt: Date | null;
  pendingPlanKey: string | null;

  planPriceCents: number | null;
  planCurrency: string | null;
  billingInterval: string;
}

/**
 * A short-lived cache of resolved snapshots.
 *
 * Entitlements change when a payment lands, a plan changes or a period rolls over, none
 * of which happens between two requests a second apart, but a page that renders a list
 * of twenty rows would otherwise ask the same question twenty times in one paint.
 *
 * The TTL is deliberately short rather than invalidated precisely, because the worker
 * runs in a different process from the API and cannot push an invalidation into this one.
 * A short window means the worst case after a plan changes is that the old one is
 * remembered for a few seconds, and the alternative, a shared cache with invalidation,
 * adds a dependency that can be down. Set the TTL to 0 to turn it off entirely.
 */
const CACHE_TTL_MS = Number(process.env.ENTITLEMENT_CACHE_TTL_MS ?? 15_000);
const cache = new Map<string, { at: number; snapshot: EntitlementSnapshot }>();

/** Called after anything that changes what a business is entitled to. */
export function invalidateEntitlements(organizationId?: string): void {
  if (organizationId) cache.delete(organizationId);
  else cache.clear();
}

export function entitlementsCacheSize(): number {
  return cache.size;
}

// ============================================================================
// Status
// ============================================================================

/** The parts of a subscription row that decide what state it is really in. */
export interface StatusInput {
  status: string;
  trialEndsAt: Date | null;
  currentPeriodEnd: Date | null;
  graceEndsAt: Date | null;
}

/**
 * Works out what a subscription's state is right now.
 *
 * The stored status is not the answer, and treating it as one is how a business ends up
 * with an expired subscription that still believes it is active. Dates pass whether or
 * not this process is running: nobody reloads the page on the night a card fails, so the
 * sweep that would flip the row may not run for hours. Deriving the state from the clock
 * on every read means the answer is correct the instant it is asked for, and the stored
 * status stays what it should be: a record of the last transition somebody decided on.
 *
 * Grace is what stands between a declined card and a business that cannot serve
 * customers today, so it is checked before the period lapses into EXPIRED.
 */
export function resolveStatus(input: StatusInput, now: Date = new Date()): SubscriptionStatus {
  // These are decisions, not consequences of a date. A canceled subscription does not
  // become active again because its period end has not been reached yet.
  if (input.status === SUBSCRIPTION_STATUS.CANCELED) return SUBSCRIPTION_STATUS.CANCELED;
  if (input.status === SUBSCRIPTION_STATUS.PAUSED) return SUBSCRIPTION_STATUS.PAUSED;
  if (input.status === SUBSCRIPTION_STATUS.EXPIRED) return SUBSCRIPTION_STATUS.EXPIRED;

  if (input.trialEndsAt && input.trialEndsAt > now) return SUBSCRIPTION_STATUS.TRIALING;

  // No period end means nothing was ever paid for and nothing expires: Community, and
  // any plan granted by an administrator as a goodwill exception.
  if (!input.currentPeriodEnd) return SUBSCRIPTION_STATUS.ACTIVE;

  if (input.currentPeriodEnd > now) return SUBSCRIPTION_STATUS.ACTIVE;

  // The period has run out. If grace is still running the business keeps working.
  if (input.graceEndsAt && input.graceEndsAt > now) return SUBSCRIPTION_STATUS.GRACE;

  return SUBSCRIPTION_STATUS.EXPIRED;
}

/** Whether a business in this state may use what its plan grants. */
export function statusAllowsUse(status: SubscriptionStatus): boolean {
  return (
    status === SUBSCRIPTION_STATUS.ACTIVE ||
    status === SUBSCRIPTION_STATUS.TRIALING ||
    status === SUBSCRIPTION_STATUS.GRACE
  );
}

/**
 * Falls back to the default plan for a business that has no subscription row.
 *
 * This has to exist. A business created before this feature shipped, or by a script
 * that bypassed registration, would otherwise have no plan at all, and every feature
 * check would answer "no" to a customer who has a working account. Community is the
 * right answer: it is what they already had.
 */
const FALLBACK_SNAPSHOT: Omit<
  EntitlementSnapshot,
  "organizationId" | "planKey" | "planName" | "planDescription" | "planTrialDays"
> & { planKey?: string } = {
  hasSubscription: false,
  planIsFree: true,
  storedStatus: SUBSCRIPTION_STATUS.ACTIVE,
  status: SUBSCRIPTION_STATUS.ACTIVE,
  isActive: true,
  inGrace: false,
  isExpired: false,
  isTrialing: false,
  features: new Set<string>(),
  limits: new Map<string, ResolvedLimit>(),
  currentPeriodStart: null,
  currentPeriodEnd: null,
  trialEndsAt: null,
  graceEndsAt: null,
  cancelAtPeriodEnd: false,
  endsAt: null,
  pendingPlanKey: null,
  planPriceCents: null,
  planCurrency: null,
  billingInterval: "monthly",
};

export function fallbackSnapshot(organizationId: string): EntitlementSnapshot {
  return {
    ...FALLBACK_SNAPSHOT,
    organizationId,
    planKey: "community",
    planName: "Community",
    planDescription: "",
    planTrialDays: 0,
    features: new Set<string>(FALLBACK_SNAPSHOT.features),
    limits: new Map<string, ResolvedLimit>(FALLBACK_SNAPSHOT.limits),
  };
}

// ============================================================================
// Resolving a snapshot
// ============================================================================

/**
 * Resolves what a business is entitled to, from its subscription, its plan and any
 * overrides an administrator has granted it.
 */
export async function getEntitlements(
  organizationId: string,
  options: { now?: Date; skipCache?: boolean } = {}
): Promise<EntitlementSnapshot> {
  const now = options.now ?? new Date();

  if (!options.skipCache && CACHE_TTL_MS > 0) {
    const hit = cache.get(organizationId);
    if (hit && now.getTime() - hit.at < CACHE_TTL_MS) return hit.snapshot;
  }

  const subscription = await prisma.subscription.findUnique({
    where: { organizationId },
    include: {
      plan: { include: { features: true, limits: true } },
      planPrice: true,
      pendingPlan: true,
    },
  });

  const snapshot = subscription
    ? buildSnapshot(organizationId, subscription, now)
    : fallbackSnapshot(organizationId);

  // Overrides are a separate query rather than a relation on the subscription because
  // they belong to the organization, not to one subscription: a business that upgrades
  // keeps them, and a business that downgrades keeps them too.
  const overrides = await prisma.entitlementOverride.findMany({
    where: {
      organizationId,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
  });
  applyOverrides(snapshot, overrides);

  if (CACHE_TTL_MS > 0 && !options.skipCache)
    cache.set(organizationId, { at: now.getTime(), snapshot });
  return snapshot;
}

interface SubscriptionWithPlan {
  status: string;
  billingInterval: string;
  trialEndsAt: Date | null;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  graceEndsAt: Date | null;
  cancelAtPeriodEnd: boolean;
  endsAt: Date | null;
  planPriceId: string | null;
  plan: {
    key: string;
    name: string;
    description: string;
    isFree: boolean;
    trialDays: number;
    features: { featureKey: string }[];
    limits: { key: string; value: number; source: string; unit: string; period: string }[];
  };
  planPrice: { amountCents: number; currency: string } | null;
  pendingPlan: { key: string } | null;
}

function buildSnapshot(
  organizationId: string,
  sub: SubscriptionWithPlan,
  now: Date
): EntitlementSnapshot {
  const status = resolveStatus(sub, now);

  // Every CORE feature is granted to everyone, regardless of what the plan grants.
  //
  // This is the open source promise written down in one place. A paid plan that failed
  // to include a core feature would be a bug, and an expired subscription must never be
  // able to take the till away from a business that still has stock to sell.
  const features = new Set<string>(coreFeatureKeys);

  for (const grant of sub.plan.features) features.add(grant.featureKey);

  // A subscription that is not in good standing loses its commercial entitlements but
  // keeps its core ones. Nothing is deleted and nothing locks a business out of its data.
  if (!statusAllowsUse(status)) {
    for (const key of [...features]) {
      if (!coreFeatureKeys.has(key)) features.delete(key);
    }
  }

  const limits = new Map<string, ResolvedLimit>();
  for (const limit of sub.plan.limits) {
    limits.set(limit.key, { ...limit, origin: "PLAN" });
  }

  return {
    organizationId,
    hasSubscription: true,
    planKey: sub.plan.key,
    planName: sub.plan.name,
    planDescription: sub.plan.description,
    planIsFree: sub.plan.isFree,
    planTrialDays: sub.plan.trialDays,
    status,
    storedStatus: sub.status,
    isActive: statusAllowsUse(status),
    inGrace: status === SUBSCRIPTION_STATUS.GRACE,
    isExpired: status === SUBSCRIPTION_STATUS.EXPIRED,
    isTrialing: status === SUBSCRIPTION_STATUS.TRIALING,
    features,
    limits,
    currentPeriodStart: sub.currentPeriodStart,
    currentPeriodEnd: sub.currentPeriodEnd,
    trialEndsAt: sub.trialEndsAt,
    graceEndsAt: sub.graceEndsAt,
    cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
    endsAt: sub.endsAt,
    pendingPlanKey: sub.pendingPlan?.key ?? null,
    planPriceCents: sub.planPrice?.amountCents ?? null,
    planCurrency: sub.planPrice?.currency ?? null,
    billingInterval: sub.billingInterval,
  };
}

/**
 * The features every plan holds, loaded once at boot.
 *
 * A module level set rather than a query per check: the CORE category is part of this
 * codebase's contract, not a setting an administrator edits, and a feature check sits on
 * the hot path of every gated route.
 */
let coreFeatureKeys = new Set<string>();

/**
 * Loads the CORE feature keys.
 *
 * Deliberately not fatal when the catalogue is missing. A server that refuses to start
 * because a lookup table is empty turns a small database problem into a business that
 * cannot trade, so a failure here degrades to an empty set and is logged loudly instead.
 */
export async function loadCoreFeatureKeys(): Promise<Set<string>> {
  try {
    const rows = await prisma.feature.findMany({
      where: { category: FEATURE_CATEGORIES.CORE },
      select: { key: true },
    });
    coreFeatureKeys = new Set(rows.map(r => r.key));
    if (!coreFeatureKeys.size) {
      console.warn(
        "No CORE features are defined. Check the plan catalogue seed, or entitlement checks " +
          "will refuse core product features."
      );
    }
  } catch (err) {
    console.error("Could not load core feature keys:", err);
  }
  return coreFeatureKeys;
}

/** The current core set, for callers that render it without reloading. */
export function getCoreFeatureKeys(): Set<string> {
  return coreFeatureKeys;
}

function applyOverrides(
  snapshot: EntitlementSnapshot,
  overrides: { featureKey: string | null; limitKey: string | null; kind: string; value: unknown }[]
): void {
  for (const override of overrides) {
    if (override.kind === "FEATURE" && override.featureKey) {
      // An override only ever adds. Withdrawing a core feature to sell it back would be
      // taking the product away, so that is the one thing this cannot do.
      if (override.value === false || override.value === null) continue;
      snapshot.features.add(override.featureKey);
      continue;
    }

    if (override.kind === "LIMIT" && override.limitKey) {
      const value = typeof override.value === "number" ? override.value : Number(override.value);
      if (!Number.isFinite(value)) continue;
      const existing = snapshot.limits.get(override.limitKey);
      snapshot.limits.set(override.limitKey, {
        key: override.limitKey,
        value,
        source: existing?.source ?? LIMIT_SOURCES.METERED,
        unit: existing?.unit ?? "megabytes",
        period: existing?.period ?? "never",
        origin: "OVERRIDE",
      });
    }
  }
}

// ============================================================================
// Asking questions
// ============================================================================

/** Does this business have this capability? The only feature question there is. */
export function hasFeature(snapshot: EntitlementSnapshot, featureKey: string): boolean {
  return snapshot.features.has(featureKey);
}

/** The allowance for a limit, or null when the plan does not set one. */
export function getLimit(snapshot: EntitlementSnapshot, key: string): ResolvedLimit | null {
  return snapshot.limits.get(key) ?? null;
}

/**
 * Whether an allowance is spent.
 *
 * A business already over its allowance is still "over", not "now allowed again", and the
 * distinction matters after a downgrade: a business that drops from Business to
 * Community with three branches keeps all three, keeps using all three, and simply
 * cannot add a fourth. Deleting their branches to make the number fit would be
 * destroying a business's records to satisfy a price list.
 */
export function isAtLimit(limit: ResolvedLimit | null, current: number): boolean {
  if (!limit) return false;
  if (limit.value === UNLIMITED) return false;
  return current >= limit.value;
}

/**
 * Counts the things a COUNTED limit measures.
 *
 * Read straight from the tables rather than from a counter. Every one of these numbers
 * is also shown in the UI, so a stored count that had drifted would be visible to the
 * customer as a limit they had not reached blocking their work.
 */
async function countLiveUsage(organizationId: string): Promise<Map<string, number>> {
  const [users, branches, products] = await Promise.all([
    prisma.user.count({ where: { organizationId } }),
    prisma.branch.count({ where: { organizationId } }),
    prisma.product.count({ where: { organizationId } }),
  ]);
  return new Map<string, number>([
    [LIMIT_KEYS.USERS, users],
    [LIMIT_KEYS.BRANCHES, branches],
    [LIMIT_KEYS.PRODUCTS, products],
  ]);
}

export interface LimitReading {
  key: string;
  limit: number | null;
  used: number;
  remaining: number | null;
  unit: string;
  source: string;
  period: string;
  unlimited: boolean;
  /** True once the allowance is gone, including when usage passed it after a downgrade. */
  atLimit: boolean;
  /** True before the allowance is gone, so the business can be warned in advance. */
  warning: boolean;
  origin: string;
  label: string;
}

/** Human names for the limits, so an error message can explain itself. */
const LIMIT_LABELS: Record<string, string> = {
  [LIMIT_KEYS.USERS]: "team members",
  [LIMIT_KEYS.BRANCHES]: "branches",
  [LIMIT_KEYS.PRODUCTS]: "products",
  [LIMIT_KEYS.MONTHLY_TRANSACTIONS]: "sales each month",
  [LIMIT_KEYS.AI_REQUESTS]: "AI requests each month",
  [LIMIT_KEYS.API_REQUESTS]: "API requests each month",
  [LIMIT_KEYS.STORAGE_MEGABYTES]: "of storage",
};

function labelFor(key: string): string {
  return LIMIT_LABELS[key] ?? key.replace(/_/g, " ");
}

/**
 * Reads every limit this plan sets, against what has actually been used.
 *
 * COUNTED limits are measured here and now. METERED limits are read from the counter for
 * the period the limit says they reset on, so an allowance that says "per month" is
 * always compared against this month's usage and never last month's.
 */
export async function readLimits(snapshot: EntitlementSnapshot): Promise<LimitReading[]> {
  const counted = await countLiveUsage(snapshot.organizationId);
  const metered: Record<string, number> = {};

  await Promise.all(
    [...snapshot.limits.values()]
      .filter(limit => limit.source === LIMIT_SOURCES.METERED)
      .map(async limit => {
        metered[limit.key] = await currentUsage(
          snapshot.organizationId,
          limit.key,
          limit.period === "never" ? "never" : limit.period
        );
      })
  );

  return [...snapshot.limits.values()].map(limit => {
    const used =
      limit.source === LIMIT_SOURCES.COUNTED
        ? (counted.get(limit.key) ?? 0)
        : (metered[limit.key] ?? 0);
    const unlimited = limit.value === UNLIMITED;
    const remaining = unlimited ? null : Math.max(0, limit.value - used);
    const ratio = unlimited || limit.value <= 0 ? 0 : used / limit.value;
    return {
      key: limit.key,
      limit: unlimited ? null : limit.value,
      used,
      remaining,
      unit: limit.unit,
      source: limit.source,
      period: limit.period,
      unlimited,
      atLimit: isAtLimit(limit, used),
      // Warned before the work stops, not after: "you have used 80% of your monthly AI
      // allowance" is useful, a refusal at 100% with no warning is not.
      warning: !unlimited && ratio >= USAGE_WARNING_RATIO,
      origin: limit.origin,
      label: labelFor(limit.key),
    };
  });
}

/** The current usage of one limit. Throws nothing when the plan sets no such limit. */
export async function currentUsageFor(snapshot: EntitlementSnapshot, key: string): Promise<number> {
  const limit = snapshot.limits.get(key);
  if (!limit) return 0;
  if (limit.source === LIMIT_SOURCES.COUNTED) {
    const counts = await countLiveUsage(snapshot.organizationId);
    return counts.get(key) ?? 0;
  }
  return currentUsage(snapshot.organizationId, key, limit.period);
}

// ============================================================================
// Enforcement
// ============================================================================

/** The plans a business could move to, cheapest first, so an error can name a real one. */
async function suggestPlans(): Promise<{ key: string; name: string }[]> {
  const plans = await prisma.plan.findMany({
    where: { status: "ACTIVE", visibility: "PUBLIC", isFree: false },
    select: { key: true, name: true },
    orderBy: { sortOrder: "asc" },
  });
  return plans;
}

/**
 * Refuses a capability this business does not have, and says what to do about it.
 *
 * The error carries a code and the plan that would help rather than only prose, so the
 * browser can offer "Upgrade to Starter" on the page the request came from instead of
 * printing a sentence and leaving the owner to work out what to do.
 */
export async function assertFeature(
  snapshot: EntitlementSnapshot,
  featureKey: string,
  options: { featureName?: string; upgradeable?: boolean } = {}
): Promise<void> {
  if (hasFeature(snapshot, featureKey)) return;

  const plans = await suggestPlans();
  const upgrade = plans.find(plan => plan.key !== snapshot.planKey);

  // A subscription that lapsed is the most common reason for a refusal that looks wrong
  // to the customer, so it is answered explicitly rather than as "feature not included".
  const lapsed = snapshot.isExpired || snapshot.storedStatus === "PAST_DUE";
  const name = options.featureName ?? featureKey.replace(/_/g, " ");

  const message = lapsed
    ? snapshot.inGrace
      ? `Your subscription has expired and ${name} is part of your paid plan. Your data is safe. Update your payment method to carry on using it.`
      : `Your subscription has expired, so ${name} is no longer available. Your data is safe and you can start again at any time.`
    : `${name.charAt(0).toUpperCase()}${name.slice(1)} is not part of the ${snapshot.planName} plan. Upgrade to keep using it.`;

  throw new AppError(403, message, lapsed ? "SUBSCRIPTION_INACTIVE" : "FEATURE_NOT_INCLUDED", {
    feature: featureKey,
    planKey: snapshot.planKey,
    status: snapshot.status,
    // The pricing page is the destination for this, and it is public, so an owner who
    // has just been refused can reach it without signing in again.
    upgradeUrl: "/pricing",
    suggestedPlan: options.upgradeable === false ? null : (upgrade?.key ?? null),
  });
}

/**
 * Refuses work that would take a business past an allowance.
 *
 * Called before the work is written, so a refused request leaves nothing behind. The
 * message says which limit was reached and what it would take to carry on, because
 * "limit exceeded" on its own is the kind of error a business cannot act on.
 */
export async function assertWithinLimit(
  snapshot: EntitlementSnapshot,
  key: string,
  options: { adding?: number; featureKey?: string } = {}
): Promise<void> {
  const limit = snapshot.limits.get(key);
  // A plan that sets no limit for this key sets no ceiling on it.
  if (!limit || limit.value === UNLIMITED) return;

  const used = await currentUsageFor(snapshot, key);
  const adding = options.adding ?? 1;

  if (used + adding <= limit.value) return;

  const plans = await suggestPlans();
  const upgrade = plans.find(plan => plan.key !== snapshot.planKey);
  const unit = limit.unit === "megabytes" ? " MB" : "";

  throw new AppError(
    409,
    `You have reached the ${snapshot.planName} limit of ${limit.value}${unit} ${labelFor(key)}. ` +
      `You currently have ${used}. Upgrade your plan to add more.`,
    "LIMIT_REACHED",
    {
      limit: key,
      used,
      limit_value: limit.value,
      period: limit.period,
      planKey: snapshot.planKey,
      upgradeUrl: "/pricing",
      suggestedPlan: upgrade?.key ?? null,
      feature: options.featureKey ?? null,
    }
  );
}

/**
 * Warns about an allowance that is nearly gone, without stopping the work.
 *
 * A business that is told at 80% has time to upgrade before anything breaks. One that is
 * refused at 100% with no warning has a till that stopped working mid market.
 */
export async function limitWarning(
  snapshot: EntitlementSnapshot,
  key: string
): Promise<string | null> {
  const limit = snapshot.limits.get(key);
  if (!limit || limit.value === UNLIMITED) return null;

  const used = await currentUsageFor(snapshot, key);
  const ratio = limit.value > 0 ? used / limit.value : 0;
  if (ratio < USAGE_WARNING_RATIO) return null;

  const percent = Math.min(100, Math.round(ratio * 100));
  return `You have used ${percent}% of your ${snapshot.planName} ${labelFor(key)} allowance.`;
}

/** Whether a business has this feature, resolving the snapshot first. */
export async function businessHasFeature(
  organizationId: string,
  featureKey: string
): Promise<boolean> {
  const snapshot = await getEntitlements(organizationId);
  return hasFeature(snapshot, featureKey);
}
