import { useCallback, useEffect, useState } from "react";
import { api, getApiError } from "./api";
import { useAuth } from "../contexts/AuthContext";

/**
 * Reading what this business is entitled to, for the interface to render.
 *
 * This is a display aid and never the enforcement. Hiding a button because this says so
 * stops an honest user from clicking it; it does nothing to somebody who edits the
 * JavaScript or calls the API directly, and every route those buttons lead to checks
 * again on the server.
 *
 * The distinction matters when reading this code: nothing here may be the only place a
 * capability is decided. If it is, the check is missing from the API.
 */

export type EntitlementLimits = Record<
  string,
  {
    value: number;
    unlimited: boolean;
    unit: string;
    period: string;
  }
>;

export interface Entitlements {
  planKey: string;
  status: string;
  isActive: boolean;
  features: string[];
  limits: EntitlementLimits;
}

export interface BillingSummary {
  plan: { key: string; name: string; description: string; isFree: boolean; trialDays: number };
  status: string;
  statusIsDerived: boolean;
  isActive: boolean;
  isTrialing: boolean;
  inGrace: boolean;
  isExpired: boolean;
  renewalDate: string | null;
  trialEndsAt: string | null;
  graceEndsAt: string | null;
  cancelAtPeriodEnd: boolean;
  paymentMethod: { brand: string; last4: string | null; expiry: string | null } | null;
  pendingPlan: { key: string; name: string } | null;
  pendingPlanChangeAt: string | null;
  price: { amountCents: number; currency: string; interval: string } | null;
  usage: UsageReading[];
  warnings: { key: string; label: string; message: string; atLimit: boolean }[];
  paymentsEnabled: boolean;
  /** Daraja credentials are set, so the M-PESA option may be offered at checkout. */
  mpesaEnabled: boolean;
  recentPayments: PaymentRecord[];
}

export interface UsageReading {
  key: string;
  limit: number | null;
  used: number;
  remaining: number | null;
  unit: string;
  unlimited: boolean;
  atLimit: boolean;
  warning: boolean;
  label: string;
}

export interface PaymentRecord {
  id: string;
  reference: string;
  planName: string;
  amountCents: number;
  currency: string;
  kind: string;
  status: string;
  paidAt: string | null;
  createdAt: string;
  failureReason?: string | null;
}

/**
 * The signed-in business's entitlements.
 *
 * `loading` is true until the answer arrives so a component can avoid flashing a paid
 * feature at somebody who does not have it. Nothing is assumed in the meantime: until this
 * resolves, `hasFeature` answers false, which hides rather than wrongly shows.
 */
export function useEntitlements() {
  const { user } = useAuth();
  const [entitlements, setEntitlements] = useState<Entitlements | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    if (!user) {
      setEntitlements(null);
      setLoading(false);
      return;
    }
    try {
      const res = await api.get("/billing/entitlements");
      setEntitlements(res.data.data);
      setError("");
    } catch (err) {
      setError(getApiError(err));
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    load();
  }, [load]);

  const hasFeature = useCallback(
    (featureKey: string) => entitlements?.features.includes(featureKey) ?? false,
    [entitlements]
  );

  return { entitlements, loading, error, reload: load, hasFeature };
}

/** Everything the Billing tab draws, fetched in one request. */
export function useBillingSummary() {
  const { user } = useAuth();
  const [summary, setSummary] = useState<BillingSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    if (!user) {
      setLoading(false);
      return;
    }
    try {
      const res = await api.get("/billing/summary");
      setSummary(res.data.data);
      setError("");
    } catch (err) {
      setError(getApiError(err));
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    load();
  }, [load]);

  return { summary, loading, error, reload: load };
}

/** Formats minor units as money, without ever going through a float. */
export function formatMoney(amountCents: number, currency = "USD"): string {
  const value = amountCents / 100;
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      // Cents matter on an invoice. Rounding them away on a price page makes a plan look
      // cheaper than the amount the card is actually asked for.
      minimumFractionDigits: value % 1 === 0 ? 0 : 2,
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    return `${currency} ${value.toFixed(2)}`;
  }
}

/** A date in the business's own words, rather than an ISO string on screen. */
export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return "";
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(date);
}
