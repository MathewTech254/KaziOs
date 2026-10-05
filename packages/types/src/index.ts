export const QUEUE_NAMES = {
  NOTIFICATIONS: "kazios_notifications",
  AUTOMATIONS: "kazios_automations",
  REPORTS: "kazios_reports",
  INVOICE_OVERDUE: "kazios_invoice_overdue",
  STOCK_CHECK: "kazios_stock_check",
  /**
   * Reconciles every subscription on the platform: trials ending, periods rolling over,
   * failed renewals entering grace, grace running out, and the warnings a business is
   * owed before a limit stops their work. It is one sweep over all tenants rather than a
   * job per business, for the same reason the stock sweep is.
   */
  SUBSCRIPTIONS: "kazios_subscriptions",
} as const;

/** Storage object categories used by the file/integration layer. */
export enum FileType {
  IMAGE = "IMAGE",
  PDF = "PDF",
  SPREADSHEET = "SPREADSHEET",
  PRESENTATION = "PRESENTATION",
  DOCUMENT = "DOCUMENT",
  ARCHIVE = "ARCHIVE",
  OTHER = "OTHER",
}

// ============================================================================
// Subscriptions and entitlements
//
// This is the vocabulary the whole system speaks. The API enforces against these
// keys and the pricing page renders them, so a plan can be re-priced or a feature
// renamed without a single component learning a new string literal.
//
// The feature list is deliberately a closed set of names rather than free text. A
// feature nobody can look up cannot be granted, cannot be tested against, and cannot
// be shown as an honest comparison row on a pricing page.
// ============================================================================

/**
 * How a feature is grouped on the pricing page. CORE entries are the open source
 * product itself: they are held by every plan, Community included, and are never
 * gated. A self hosted KaziOS has to remain a complete business, not a demo.
 */
export const FEATURE_CATEGORIES = {
  CORE: "CORE",
  OPERATIONS: "OPERATIONS",
  INTELLIGENCE: "INTELLIGENCE",
  PLATFORM: "PLATFORM",
  SUPPORT: "SUPPORT",
} as const;
export type FeatureCategory = (typeof FEATURE_CATEGORIES)[keyof typeof FEATURE_CATEGORIES];

export const FEATURE_KEYS = {
  // Core, open source product. Present on every plan, Community included.
  CORE_POS: "core_pos",
  CORE_PRODUCTS: "core_products",
  CORE_CUSTOMERS: "core_customers",
  CORE_INVENTORY: "core_inventory",
  CORE_PURCHASING: "core_purchasing",
  CORE_REPORTS: "core_reports",
  CORE_ROLES: "core_roles",
  CORE_SELF_HOSTING: "core_self_hosting",

  // Operations beyond the community core.
  MULTI_BRANCH: "multi_branch",
  ADVANCED_INVENTORY: "advanced_inventory",
  ACCOUNTING: "accounting",
  ADVANCED_REPORTS: "advanced_reports",
  AUTOMATION: "automation",
  API_ACCESS: "api_access",
  AI_ASSISTANT: "ai_assistant",
  WHATSAPP: "whatsapp",

  // Managed cloud and enterprise.
  MANAGED_BACKUPS: "managed_backups",
  MANAGED_WHATSAPP: "managed_whatsapp",
  SSO: "sso",
  AUDIT_EXPORT: "audit_export",
  PRIORITY_SUPPORT: "priority_support",
  DEDICATED_SUPPORT: "dedicated_support",
  CUSTOM_LIMITS: "custom_limits",
} as const;
export type FeatureKey = (typeof FEATURE_KEYS)[keyof typeof FEATURE_KEYS];

/** A sentinel rather than a large number, so "unlimited" is never mistaken for a quota. */
export const UNLIMITED = -1;

/** Above this fraction of an allowance a business is warned before it stops their work. */
export const USAGE_WARNING_RATIO = 0.8;

/**
 * Countable allowances.
 *
 * `COUNTED` limits are measured from live rows (users, branches, products) so the
 * number a business is shown can never drift from the data. `METERED` limits are
 * accumulated events (AI requests, API calls, storage) and need a counter incremented
 * as the work happens.
 */
export const LIMIT_KEYS = {
  USERS: "users",
  BRANCHES: "branches",
  PRODUCTS: "products",
  MONTHLY_TRANSACTIONS: "monthly_transactions",
  AI_REQUESTS: "ai_requests",
  API_REQUESTS: "api_requests",
  /**
   * Megabytes, not bytes. A Postgres INTEGER tops out near 2 GB, and a 100 GB Enterprise
   * allowance does not fit in that. Storing megabytes keeps every limit a plain integer
   * that can cross an HTTP boundary and be compared in ordinary arithmetic, instead of
   * a BigInt that serialises to nothing useful in a JSON response.
   */
  STORAGE_MEGABYTES: "storage_megabytes",
} as const;
export type LimitKey = (typeof LIMIT_KEYS)[keyof typeof LIMIT_KEYS];

export const LIMIT_SOURCES = {
  COUNTED: "COUNTED",
  METERED: "METERED",
} as const;
export type LimitSource = (typeof LIMIT_SOURCES)[keyof typeof LIMIT_SOURCES];

export const LIMIT_UNITS = {
  COUNT: "count",
  PER_MONTH: "per_month",
  MEGABYTES: "megabytes",
} as const;
export type LimitUnit = (typeof LIMIT_UNITS)[keyof typeof LIMIT_UNITS];

export const BILLING_INTERVALS = {
  MONTHLY: "monthly",
  YEARLY: "yearly",
  ONE_TIME: "one_time",
  CUSTOM: "custom",
} as const;
export type BillingInterval = (typeof BILLING_INTERVALS)[keyof typeof BILLING_INTERVALS];

/**
 * The states a subscription can be in.
 *
 * The important property is that EXPIRED and PAST_DUE describe billing, not the
 * product. They narrow what a business can reach without touching a single row of
 * their data, because a business whose card failed is still a business with
 * invoices, stock and customers.
 */
export const SUBSCRIPTION_STATUS = {
  TRIALING: "TRIALING",
  ACTIVE: "ACTIVE",
  PAST_DUE: "PAST_DUE",
  GRACE: "GRACE",
  CANCELED: "CANCELED",
  EXPIRED: "EXPIRED",
  PAUSED: "PAUSED",
} as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUS)[keyof typeof SUBSCRIPTION_STATUS];

export const PLAN_STATUS = {
  DRAFT: "DRAFT",
  ACTIVE: "ACTIVE",
  ARCHIVED: "ARCHIVED",
} as const;
export type PlanStatus = (typeof PLAN_STATUS)[keyof typeof PLAN_STATUS];

/** Private plans exist for negotiated enterprise deals and are never listed publicly. */
export const PLAN_VISIBILITY = {
  PUBLIC: "PUBLIC",
  PRIVATE: "PRIVATE",
} as const;
export type PlanVisibility = (typeof PLAN_VISIBILITY)[keyof typeof PLAN_VISIBILITY];

export const SUBSCRIPTION_PAYMENT_STATUS = {
  PENDING: "PENDING",
  SUCCESS: "SUCCESS",
  FAILED: "FAILED",
  REFUNDED: "REFUNDED",
} as const;
export type SubscriptionPaymentStatus =
  (typeof SUBSCRIPTION_PAYMENT_STATUS)[keyof typeof SUBSCRIPTION_PAYMENT_STATUS];

export const SUBSCRIPTION_PAYMENT_KIND = {
  INITIAL: "INITIAL",
  RENEWAL: "RENEWAL",
  UPGRADE: "UPGRADE",
  DOWNGRADE: "DOWNGRADE",
  PRORATED: "PRORATED",
} as const;
export type SubscriptionPaymentKind =
  (typeof SUBSCRIPTION_PAYMENT_KIND)[keyof typeof SUBSCRIPTION_PAYMENT_KIND];

/**
 * The subscription ledger, as append only history.
 *
 * A business asking "why did my plan change" is answered from this table rather than
 * from the current row, which by definition only knows the present.
 */
export const SUBSCRIPTION_EVENT = {
  CREATED: "CREATED",
  TRIAL_STARTED: "TRIAL_STARTED",
  ACTIVATED: "ACTIVATED",
  RENEWED: "RENEWED",
  UPGRADED: "UPGRADED",
  DOWNGRADED: "DOWNGRADED",
  PLAN_CHANGE_SCHEDULED: "PLAN_CHANGE_SCHEDULED",
  PAYMENT_FAILED: "PAYMENT_FAILED",
  GRACE_STARTED: "GRACE_STARTED",
  PAST_DUE: "PAST_DUE",
  EXPIRED: "EXPIRED",
  CANCELED: "CANCELED",
  RESUMED: "RESUMED",
  REFUNDED: "REFUNDED",
  REACTIVATED: "REACTIVATED",
  LIMIT_REACHED: "LIMIT_REACHED",
  ENTITLEMENT_OVERRIDDEN: "ENTITLEMENT_OVERRIDDEN",
} as const;
export type SubscriptionEventType = (typeof SUBSCRIPTION_EVENT)[keyof typeof SUBSCRIPTION_EVENT];

/** The plan a brand new KaziOS business lands on. Defined in the database, named here. */
export const DEFAULT_PLAN_KEY = "community";

/** Scopes a platform administrator can hold. Business roles never grant these. */
export const PLATFORM_ADMIN_SCOPES = {
  READ: "platform.read",
  BILLING: "platform.billing",
  PLANS: "platform.plans",
  SUPPORT: "platform.support",
} as const;
export type PlatformAdminScope = (typeof PLATFORM_ADMIN_SCOPES)[keyof typeof PLATFORM_ADMIN_SCOPES];
