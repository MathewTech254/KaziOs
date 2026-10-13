/**
 * cardSplit.ts — pure, deterministic money-routing maths for Paystack split payments.
 *
 * A split routes a card charge so that a pilot shop's own Paystack subaccount receives
 * the bulk of the money while the KaziOS platform keeps only an explicit, agreed fee.
 * This module decides, in integer minor units (cents), how many cents belong to the
 * platform. It performs NO I/O, reads NO settings and imports nothing, which is what
 * makes it cheap to unit-test and safe to call on every checkout.
 *
 * The I/O layer (paystack.ts) is solely responsible for converting the cents computed
 * here into the exact units the provider expects on the wire.
 */

/** Per-organisation split configuration, as stored in the Setting key-value store. */
export interface SplitConfig {
  /** The shop's Paystack subaccount code, e.g. "ACCT_xxxxxxxx". Null/empty means no split. */
  subaccountCode: string | null | undefined;
  /** Percentage of the sale the platform keeps, e.g. 2.5 for 2.5%. Used only when no flat fee applies. */
  platformFeePercent?: number | null;
  /** Flat fee, in cents, the platform keeps. Overrides the percentage when present and > 0. */
  platformFeeCents?: number | null;
}

/** The routing decision for a single charge. Every amount is an integer number of cents. */
export interface SplitCharge {
  /** True only when a usable subaccount code is present, i.e. we should actually split. */
  applySplit: boolean;
  /** How many cents the platform retains. Always within [0, totalCents]. */
  platformFeeCents: number;
  /** How many cents the subaccount receives (totalCents - platformFeeCents). Informational. */
  subaccountReceivesCents: number;
}

/**
 * Compute the split for a single charge.
 *
 * Rules (deliberately conservative so money can never be mis-routed):
 *  - No usable subaccount code  -> no split; the platform keeps everything (existing behaviour).
 *  - Flat platformFeeCents > 0   -> the platform keeps exactly that, in cents.
 *  - Otherwise a percentage      -> the platform keeps round(totalCents * percent / 100).
 *  - Otherwise                   -> the platform keeps nothing; the shop receives the full amount.
 *  - The platform fee is clamped to [0, totalCents] so it can never be negative or exceed the sale.
 */
export function computeSplitCharge(totalCents: number, config: SplitConfig): SplitCharge {
  const total =
    Number.isFinite(totalCents) && totalCents > 0 ? Math.round(totalCents) : 0;

  const code =
    typeof config.subaccountCode === "string" ? config.subaccountCode.trim() : "";
  const applySplit = code.length > 0;

  if (!applySplit) {
    // No split requested: preserve the existing single-recipient behaviour exactly, so
    // nothing about today's flow changes until a shop opts in by entering a subaccount code.
    return { applySplit: false, platformFeeCents: 0, subaccountReceivesCents: 0 };
  }

  const flat =
    typeof config.platformFeeCents === "number" && Number.isFinite(config.platformFeeCents)
      ? Math.round(config.platformFeeCents)
      : null;
  const percent =
    typeof config.platformFeePercent === "number" && Number.isFinite(config.platformFeePercent)
      ? config.platformFeePercent
      : null;

  let fee = 0;
  if (flat !== null && flat > 0) {
    // An explicit flat fee always wins over any percentage.
    fee = flat;
  } else if (percent !== null && percent > 0) {
    fee = Math.round((total * percent) / 100);
  }

  // Clamp so the platform can never keep more than the whole sale, or a negative amount.
  fee = Math.max(0, Math.min(fee, total));

  return {
    applySplit: true,
    platformFeeCents: fee,
    subaccountReceivesCents: total - fee,
  };
}
