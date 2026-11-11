/**
 * Client-side feature flags for the v1 liquor-store pilot.
 *
 * Values are baked into the bundle at build time from `VITE_FEATURE_*` env vars.
 * A missing var falls back to the v1 default below, so a fresh deploy is
 * pilot-ready without touching environment. The same keys exist in
 * `@kazios/config` (server side) so the two can be kept in sync by setting the
 * matching `FEATURE_*` vars on the API host.
 *
 * To hide a surface in production, set `VITE_FEATURE_<KEY>="false"` on the web
 * build host (and `FEATURE_<KEY>="false"` on the API host).
 */
const V1_DEFAULTS = {
  dashboard: true,
  pos: true,
  products: true,
  inventory: true,
  customers: true,
  credit: true,
  closing: false,
  reports: true,
  expenses: true,
  settings: true,
  users: true,
  invoices: false,
  payments: false,
  purchasing: false,
  billing: false,
  ai: false,
  notifications: false,
  platformAdmin: false,
  branches: false,
  accounting: false,
  transfers: false,
  stocktake: false,
} as const;

type FeatureKey = keyof typeof V1_DEFAULTS;

function flag(key: FeatureKey): boolean {
  const raw = import.meta.env[`VITE_FEATURE_${key.toUpperCase()}` as const as string];
  if (raw === undefined) return V1_DEFAULTS[key];
  return raw === "1" || raw === "true";
}

export const FEATURES = {
  dashboard: flag("dashboard"),
  pos: flag("pos"),
  products: flag("products"),
  inventory: flag("inventory"),
  customers: flag("customers"),
  credit: flag("credit"),
  closing: flag("closing"),
  reports: flag("reports"),
  expenses: flag("expenses"),
  settings: flag("settings"),
  users: flag("users"),
  invoices: flag("invoices"),
  payments: flag("payments"),
  purchasing: flag("purchasing"),
  billing: flag("billing"),
  ai: flag("ai"),
  notifications: flag("notifications"),
  platformAdmin: flag("platformAdmin"),
  branches: flag("branches"),
  accounting: flag("accounting"),
  transfers: flag("transfers"),
  stocktake: flag("stocktake"),
} as const;

export function isFeatureEnabled(key: FeatureKey): boolean {
  return FEATURES[key];
}
