import { useEffect, useState } from "react";
import { api } from "./api";

/**
 * The organization's own currency, resolved once per signed in user.
 *
 * Money used to be rendered with a hardcoded "KES" prefix on the dashboard and the
 * reports screen. That is wrong for every business outside Kenya, and it contradicts
 * the currency chosen at sign up, which the till and the payments screen already read
 * correctly. One source means a business sees its own money everywhere.
 *
 * KES is only a fallback while the request is in flight or if it fails, so a screen
 * never renders an empty symbol.
 */
let cachedCurrency: string | null = null;
let inFlight: Promise<string> | null = null;

export function useCurrency(): string {
  const [currency, setCurrency] = useState<string>(cachedCurrency || "KES");

  useEffect(() => {
    if (cachedCurrency) return;
    let active = true;

    if (!inFlight) {
      inFlight = api
        .get("/org")
        .then(res => {
          const value = res.data?.data?.currency;
          if (typeof value === "string" && value) cachedCurrency = value;
          return cachedCurrency || "KES";
        })
        .catch(() => cachedCurrency || "KES")
        .finally(() => {
          inFlight = null;
        });
    }

    void inFlight.then(value => {
      if (active) setCurrency(value);
    });

    return () => {
      active = false;
    };
  }, []);

  return currency;
}

/** Formats an amount in the organization's currency. */
export function formatMoney(amount: number, currency: string): string {
  const safe = Number.isFinite(amount) ? amount : 0;
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
    }).format(safe);
  } catch {
    // An unrecognised code must not blank the screen; the number is still useful.
    return `${currency} ${safe.toFixed(2)}`;
  }
}
