import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { AlertTriangle, ArrowUpRight, Check, CreditCard, RefreshCw } from "lucide-react";
import { api, getApiError } from "../lib/api";
import { formatDate, formatMoney, useBillingSummary, type UsageReading } from "../lib/entitlements";
import { useAuth } from "../contexts/AuthContext";

/** What the server says a plan change would do. The browser never decides this. */
type PlanChangeOutcome =
  | { action: "UPGRADE_NOW"; planKey: string; trialDays: number }
  | { action: "DOWNGRADE_AT_PERIOD_END"; planKey: string; effectiveAt: string }
  | { action: "SAME"; planKey: string };

/**
 * A sellable plan from the public catalogue, read from `GET /plans` the same way the
 * pricing page reads it. Only paid plans with a live price are offered here; the free
 * tier needs no purchase and prices always come from the server, never this file.
 */
interface CataloguePlan {
  key: string;
  name: string;
  description: string;
  highlight: string | null;
  isFree: boolean;
  trialDays: number;
  prices: { interval: string; amountCents: number; currency: string }[];
  features: { key: string; name: string; description: string }[];
}

function priceFor(plan: CataloguePlan, billingInterval: string) {
  return plan.prices.find(p => p.interval === billingInterval) ?? null;
}

/**
 * The Billing tab in Settings.
 *
 * Reads one summary endpoint rather than assembling the screen from five calls, so it
 * cannot render half a billing page because one request failed.
 *
 * Every action goes to the API and is then re-read from it. Nothing in this component
 * decides that a plan changed because a button was pressed: after a payment the browser is
 * told "complete the payment", and the panel shows a new plan only once the server says
 * Paystack confirmed the money.
 */

const STATUS_TONE: Record<string, string> = {
  ACTIVE: "text-success",
  TRIALING: "text-info",
  GRACE: "text-warning",
  PAST_DUE: "text-warning",
  EXPIRED: "text-destructive",
  CANCELED: "text-muted-foreground",
  PAUSED: "text-muted-foreground",
};

function usageText(reading: UsageReading): string {
  if (reading.unlimited) return "Unlimited";
  if (reading.limit === null) return "—";
  if (reading.unit === "megabytes") {
    return `${(reading.used / 1024).toFixed(1)} of ${(reading.limit / 1024).toFixed(0)} GB`;
  }
  return `${reading.used.toLocaleString()} of ${reading.limit.toLocaleString()}`;
}

/** The bar for one allowance, coloured by how close it is to being spent. */
function LimitMeter({ reading }: { reading: UsageReading }) {
  const percent =
    reading.unlimited || !reading.limit ? 0 : Math.min(100, (reading.used / reading.limit) * 100);

  return (
    <div className="py-3">
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="text-foreground">
          {reading.label.charAt(0).toUpperCase() + reading.label.slice(1)}
        </span>
        <span className="text-muted-foreground">{usageText(reading)}</span>
      </div>
      <div
        className="mt-2 h-2 w-full overflow-hidden rounded-full bg-surface-muted"
        role="progressbar"
        aria-valuenow={Math.round(percent)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={reading.label}
      >
        <div
          className={`h-full rounded-full transition-all ${
            reading.atLimit ? "bg-destructive" : reading.warning ? "bg-warning" : "bg-accent"
          }`}
          style={{ width: `${reading.unlimited ? 100 : percent}%` }}
        />
      </div>
    </div>
  );
}

export function SettingsBillingPanel({ canManage }: { canManage: boolean }) {
  const { summary, loading, error, reload } = useBillingSummary();
  const { user } = useAuth();
  const [searchParams] = useSearchParams();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [actionError, setActionError] = useState("");
  const [interval, setInterval] = useState<"monthly" | "yearly">("monthly");

  // Which rail the next checkout uses. The selector itself only renders when the
  // server reports M-PESA configured, so a server without Daraja credentials
  // shows exactly the card-only interface it has always shown.
  const [method, setMethod] = useState<"card" | "mpesa">("card");
  const [mpesaPhone, setMpesaPhone] = useState("");
  // Set once an STK Push has been sent: Safaricom's prompt lives on the phone,
  // and this page only ever asks the server what Safaricom said about it.
  const [mpesaReference, setMpesaReference] = useState<string | null>(null);
  const mpesaPollingRef = useRef(false);

  // Landed here from "Change plan" on the pricing page. The checkout is not started
  // automatically on load: opening a payment window the moment a page renders is how
  // somebody is surprised by a charge.
  const requestedPlan = searchParams.get("plan");
  // Paystack sends the customer back with ?reference=... . Confirming it is a request to the
  // server to ask the provider what happened, not a claim that they paid.
  const returnedReference = searchParams.get("reference");

  // What the server says this change would do. An upgrade needs payment; a downgrade is
  // scheduled for free at the end of the period; asking for your own plan changes
  // nothing. Fetched rather than guessed from plan names, so the two sides can never
  // disagree about which control belongs here.
  const [outcome, setOutcome] = useState<PlanChangeOutcome | null>(null);
  const [outcomeError, setOutcomeError] = useState("");

  // The paid plans a free business can buy without leaving this page. Read from the
  // public catalogue, shown only when the current plan is free, so a customer who
  // entered for free can pay the moment they need more — no pricing-page detour.
  const [catalogue, setCatalogue] = useState<CataloguePlan[]>([]);
  const [catalogueError, setCatalogueError] = useState("");

  // Which paid plan the upgrade section is pointed at. Defaults to the plan the pricing
  // page asked for, or the first paid plan when the customer just opened Billing.
  const [selectedPlanKey, setSelectedPlanKey] = useState<string | null>(null);

  // The plan the change-plan card below works on: the pricing page's request wins, and
  // otherwise it is whatever the customer picked in the upgrade section on this page.
  const activePlanKey = requestedPlan ?? selectedPlanKey;

  useEffect(() => {
    if (!activePlanKey || !canManage) return;
    let cancelled = false;
    api
      .get(`/billing/change-plan/${encodeURIComponent(activePlanKey)}`)
      .then(res => {
        if (!cancelled) {
          setOutcome(res.data.data);
          setOutcomeError("");
        }
      })
      .catch(err => {
        if (!cancelled) setOutcomeError(getApiError(err));
      });
    return () => {
      cancelled = true;
    };
  }, [activePlanKey, canManage]);

  // The paid plans themselves, fetched only for a free business signed in with
  // billing rights. Public endpoint, sellable rows only; a failure here hides the
  // upgrade section rather than breaking the rest of the page.
  useEffect(() => {
    if (!canManage || !summary || !summary.plan.isFree) return;
    let cancelled = false;
    api
      .get("/plans")
      .then(res => {
        if (cancelled) return;
        const sellable = (res.data.data.plans as CataloguePlan[]).filter(
          plan => !plan.isFree && priceFor(plan, interval)
        );
        setCatalogue(sellable);
        setCatalogueError("");
        setSelectedPlanKey(current => {
          if (current && sellable.some(plan => plan.key === current)) return current;
          if (requestedPlan && sellable.some(plan => plan.key === requestedPlan)) {
            return requestedPlan;
          }
          return sellable[0]?.key ?? null;
        });
      })
      .catch(err => {
        if (!cancelled) setCatalogueError(getApiError(err));
      });
    return () => {
      cancelled = true;
    };
    // Re-read when the billing interval flips, because a plan sold monthly-only is not
    // the same offer as the same plan sold yearly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canManage, summary?.plan.isFree, interval]);

  // Coming back from Paystack with ?reference=... The webhook and this confirmation race
  // each other and either may land first; the server answers identically either way and
  // a duplicate finds the payment already settled. Asking automatically is what makes
  // "Confirming your payment..." the first thing a customer sees, instead of a button
  // they have to find while unsure whether their money is gone.
  const confirmingRef = useRef(false);
  useEffect(() => {
    if (!returnedReference || confirmingRef.current || loading || error) return;
    confirmingRef.current = true;
    setBusy(true);
    api
      .post("/billing/checkout/confirm", { reference: returnedReference })
      .then(res => setNotice(res.data.data.message))
      .catch(err => setActionError(getApiError(err)))
      .finally(() => {
        setBusy(false);
        void reload();
      });
    // Only ever once per page load; the button below is the retry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [returnedReference, loading, error]);

  if (loading) {
    return <div className="kazi-card p-6 text-sm text-muted-foreground">Loading your plan...</div>;
  }

  if (error || !summary) {
    return (
      <div className="kazi-alert-card p-4 text-sm text-foreground">
        {error || "Your billing details could not be loaded."}
      </div>
    );
  }

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setNotice("");
    setActionError("");
    try {
      await action();
      await reload();
    } catch (err) {
      setActionError(getApiError(err));
    } finally {
      setBusy(false);
    }
  };

  // Waits with the customer while the prompt is on their phone, asking the server
  // every few seconds what Safaricom answered. Every answer comes from the server's
  // own query to Safaricom; this loop never assumes the PIN was entered, and a
  // failure to reach the server is simply asked again rather than believed.
  const pollMpesa = async (reference: string) => {
    if (mpesaPollingRef.current) return;
    mpesaPollingRef.current = true;
    try {
      for (let attempt = 0; attempt < 20; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 3000));
        let result: { status: string; settled: boolean; message: string } | undefined;
        try {
          const res = await api.post("/billing/checkout/mpesa/confirm", { reference });
          result = res.data.data;
        } catch {
          // The server could not reach Safaricom this time. Nothing is assumed;
          // the next attempt asks again.
        }
        if (!result) continue;
        if (result.settled) {
          setNotice(result.message);
          setMpesaReference(null);
          await reload();
          return;
        }
        if (result.status === "FAILED") {
          setActionError(result.message);
          setNotice("");
          setMpesaReference(null);
          await reload();
          return;
        }
      }
      // Still undecided after a minute: the prompt has usually expired by now. The
      // manual check below asks again whenever the customer is ready.
      setNotice(
        'M-PESA has not confirmed this payment yet. If you entered your PIN, press "Check M-PESA status" below; otherwise start the checkout again.'
      );
    } finally {
      mpesaPollingRef.current = false;
    }
  };

  /** One more question to the server, which asks Safaricom. Used by the button below. */
  const checkMpesa = () =>
    run(async () => {
      if (!mpesaReference) return;
      const res = await api.post("/billing/checkout/mpesa/confirm", {
        reference: mpesaReference,
      });
      const result = res.data.data;
      if (result.settled) {
        setNotice(result.message);
        setMpesaReference(null);
      } else if (result.status === "FAILED") {
        setActionError(result.message);
        setNotice("");
        setMpesaReference(null);
      } else {
        setNotice(result.message);
      }
    });

  const startCheckout = () =>
    run(async () => {
      if (!activePlanKey) return;

      // M-PESA does not redirect anywhere: the prompt appears on the phone and this
      // page stays put. The server still prices it; the browser only says which plan
      // was clicked and which number to prompt, never an amount.
      if (method === "mpesa" && summary?.mpesaEnabled) {
        const res = await api.post("/billing/checkout/mpesa", {
          planKey: activePlanKey,
          interval,
          phone: mpesaPhone,
          idempotencyKey: `mpesa-${activePlanKey}-${interval}-${new Date().toISOString().slice(0, 10)}`,
        });
        const reference = res.data.data.reference as string;
        setMpesaReference(reference);
        setNotice(res.data.data.message);
        void pollMpesa(reference);
        return;
      }

      // The server decides what this costs and whether it is allowed; the browser only says
      // which plan was clicked.
      const res = await api.post("/billing/checkout", {
        planKey: activePlanKey,
        interval,
        email: user?.email,
        idempotencyKey: `${activePlanKey}-${interval}-${new Date().toISOString().slice(0, 10)}`,
      });
      window.location.href = res.data.data.authorizationUrl;
    });

  const confirmPayment = () =>
    run(async () => {
      if (!returnedReference) {
        setActionError("No payment reference was returned. Nothing has been charged.");
        return;
      }
      const res = await api.post("/billing/checkout/confirm", { reference: returnedReference });
      setNotice(res.data.data.message);
    });

  const cancelPlan = () =>
    run(async () => {
      const res = await api.post("/billing/cancel", {});
      setNotice(res.data.data.message);
    });

  const resumePlan = () =>
    run(async () => {
      const res = await api.post("/billing/resume", {});
      setNotice(res.data.data.message);
    });

  const scheduleDowngrade = () =>
    run(async () => {
      const res = await api.post("/billing/downgrade", { planKey: activePlanKey });
      setNotice(res.data.data.message);
    });

  const withdrawDowngrade = () =>
    run(async () => {
      const res = await api.delete("/billing/downgrade");
      setNotice(res.data.data.message);
    });

  return (
    <div className="space-y-6">
      {actionError && (
        <div className="kazi-alert-card p-3 text-sm text-foreground">{actionError}</div>
      )}
      {notice && (
        <div className="rounded-lg border border-border bg-surface-muted p-3 text-sm text-foreground">
          {notice}
        </div>
      )}

      {returnedReference && (
        <div className="kazi-card flex flex-wrap items-center justify-between gap-3 p-4">
          <p className="text-sm text-foreground" aria-live="polite">
            {busy
              ? "Confirming your payment with Paystack. Your plan changes the moment the provider confirms it..."
              : notice
                ? "Payment confirmed. Your plan is up to date."
                : actionError
                  ? "Your payment could not be confirmed yet. Nothing has changed — try again in a moment."
                  : "You have come back from the payment provider. Your plan changes once the payment is confirmed."}
          </p>
          {!busy && (
            <button
              type="button"
              onClick={confirmPayment}
              className="kazi-button-primary px-4 py-2 text-sm"
            >
              Check my payment
            </button>
          )}
        </div>
      )}

      {/* Anything the business needs to act on, said plainly, before the numbers. */}
      {summary.inGrace && (
        <div className="kazi-alert-card flex items-start gap-3 p-4">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-warning" aria-hidden="true" />
          <div className="text-sm">
            <p className="font-medium text-foreground">Your last payment did not go through.</p>
            <p className="mt-1 text-muted-foreground">
              Everything keeps working until {formatDate(summary.graceEndsAt)}. Pay again before
              then and nothing changes. Your data is not affected either way.
            </p>
            <Link
              to="/pricing"
              className="mt-2 inline-block text-sm font-medium text-accent hover:underline"
            >
              Pay now
            </Link>
          </div>
        </div>
      )}

      {summary.isExpired && (
        <div className="kazi-alert-card flex items-start gap-3 p-4">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" aria-hidden="true" />
          <div className="text-sm">
            <p className="font-medium text-foreground">Your subscription has expired.</p>
            <p className="mt-1 text-muted-foreground">
              Your business data is safe and still here. Paid capabilities are paused until you pay
              again, and everything you created is exactly where you left it.
            </p>
            <Link
              to="/pricing"
              className="mt-2 inline-block text-sm font-medium text-accent hover:underline"
            >
              Reactivate
            </Link>
          </div>
        </div>
      )}

      {summary.warnings
        .filter(warning => !warning.atLimit)
        .map(warning => (
          <div
            key={warning.key}
            className="kazi-alert-card flex items-start gap-3 p-4 text-sm text-foreground"
          >
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
            <span>{warning.message}</span>
          </div>
        ))}

      <div className="kazi-card p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="kazi-section-title text-foreground">{summary.plan.name} plan</h2>
            <p className="mt-1 text-sm text-muted-foreground">{summary.plan.description}</p>
          </div>
          <div className="text-right">
            <p className={`text-sm font-medium ${STATUS_TONE[summary.status] ?? ""}`}>
              {summary.status.replace(/_/g, " ").toLowerCase()}
            </p>
            {summary.price && (
              <p className="text-sm text-muted-foreground">
                {formatMoney(summary.price.amountCents, summary.price.currency)}{" "}
                {summary.price.interval === "yearly" ? "per year" : "per month"}
              </p>
            )}
          </div>
        </div>

        <dl className="mt-6 grid gap-4 sm:grid-cols-2">
          <div>
            <dt className="text-xs uppercase text-muted-foreground">
              {summary.cancelAtPeriodEnd ? "Ends on" : "Renews on"}
            </dt>
            <dd className="mt-1 text-sm text-foreground">
              {formatDate(summary.renewalDate) || "No renewal, this plan is free"}
            </dd>
          </div>
          {summary.trialEndsAt && (
            <div>
              <dt className="text-xs uppercase text-muted-foreground">Trial ends</dt>
              <dd className="mt-1 text-sm text-foreground">{formatDate(summary.trialEndsAt)}</dd>
            </div>
          )}
          <div>
            <dt className="text-xs uppercase text-muted-foreground">Payment method</dt>
            <dd className="mt-1 flex items-center gap-2 text-sm text-foreground">
              <CreditCard className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
              {summary.paymentMethod
                ? `${summary.paymentMethod.brand} ending ${summary.paymentMethod.last4 ?? "****"}`
                : "No card on file"}
            </dd>
          </div>
          {summary.pendingPlan && (
            <div>
              <dt className="text-xs uppercase text-muted-foreground">Scheduled change</dt>
              <dd className="mt-1 text-sm text-foreground">
                {summary.pendingPlan.name} on {formatDate(summary.pendingPlanChangeAt)}
              </dd>
            </div>
          )}
        </dl>

        {canManage && !summary.plan.isFree && (
          <div className="mt-6 flex flex-wrap gap-2 border-t border-border pt-4">
            <Link to="/pricing" className="kazi-button-secondary px-4 py-2 text-sm">
              Change plan
            </Link>
            {summary.cancelAtPeriodEnd ? (
              <button
                type="button"
                onClick={resumePlan}
                disabled={busy}
                className="kazi-button-secondary px-4 py-2 text-sm disabled:opacity-50"
              >
                Keep my plan
              </button>
            ) : (
              <button
                type="button"
                onClick={cancelPlan}
                disabled={busy}
                className="kazi-button-secondary px-4 py-2 text-sm disabled:opacity-50"
              >
                Cancel at period end
              </button>
            )}
            {summary.pendingPlan && (
              <button
                type="button"
                onClick={withdrawDowngrade}
                disabled={busy}
                className="kazi-button-secondary px-4 py-2 text-sm disabled:opacity-50"
              >
                Keep {summary.plan.name}
              </button>
            )}
          </div>
        )}
      </div>

      <div className="kazi-card p-6">
        <div className="flex items-center justify-between gap-3">
          <h2 className="kazi-section-title text-foreground">Usage</h2>
          <Link to="/pricing" className="text-sm text-muted-foreground hover:text-foreground">
            Raise your limits
          </Link>
        </div>

        <div className="mt-2 divide-y divide-border">
          {summary.usage.map(reading => (
            <LimitMeter key={reading.key} reading={reading} />
          ))}
        </div>
        {summary.usage.length === 0 && (
          <p className="mt-3 text-sm text-muted-foreground">
            This plan does not set any usage limits.
          </p>
        )}
      </div>

      {activePlanKey && canManage && activePlanKey !== summary.plan.key && (
        <div className="kazi-card p-6">
          <h2 className="kazi-section-title text-foreground">Change plan</h2>

          {outcomeError && <p className="mt-2 text-sm text-destructive">{outcomeError}</p>}

          {!outcome && !outcomeError && (
            <p className="mt-1 text-sm text-muted-foreground">
              Checking what this change would do...
            </p>
          )}

          {outcome?.action === "SAME" && (
            <p className="mt-1 text-sm text-muted-foreground">
              You are already on this plan. Pick a different one below if you want to change.
            </p>
          )}

          {outcome?.action === "DOWNGRADE_AT_PERIOD_END" && (
            <div className="mt-2">
              <p className="text-sm text-muted-foreground">
                Moving down takes effect on {formatDate(outcome.effectiveAt)}, the end of the period
                you have already paid for. Until then everything carries on as usual — you keep
                every product, customer and sale, and nothing is deleted.
              </p>
              <button
                type="button"
                onClick={scheduleDowngrade}
                disabled={busy || Boolean(summary.pendingPlan)}
                className="kazi-button-secondary mt-4 px-4 py-2 text-sm disabled:opacity-50"
              >
                {summary.pendingPlan ? "Downgrade already scheduled" : "Schedule downgrade"}
              </button>
            </div>
          )}

          {outcome?.action === "UPGRADE_NOW" && (
            <>
              <p className="mt-1 text-sm text-muted-foreground">
                You are moving to the {activePlanKey} plan. It is active the moment payment is
                confirmed
                {outcome.trialDays > 0 ? `, with ${outcome.trialDays} days free first` : ""}.
                Choose how often to be billed.
              </p>
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <div className="inline-flex rounded-full border border-border p-1">
                  {(["monthly", "yearly"] as const).map(option => (
                    <button
                      key={option}
                      type="button"
                      onClick={() => setInterval(option)}
                      aria-pressed={interval === option}
                      className={`rounded-full px-4 py-1.5 text-sm ${
                        interval === option
                          ? "bg-accent text-accent-foreground"
                          : "text-muted-foreground"
                      }`}
                    >
                      {option === "monthly" ? "Monthly" : "Yearly"}
                    </button>
                  ))}
                </div>
                {summary.mpesaEnabled && (
                  <div className="inline-flex rounded-full border border-border p-1">
                    {(["card", "mpesa"] as const).map(option => (
                      <button
                        key={option}
                        type="button"
                        onClick={() => setMethod(option)}
                        aria-pressed={method === option}
                        className={`rounded-full px-4 py-1.5 text-sm ${
                          method === option
                            ? "bg-accent text-accent-foreground"
                            : "text-muted-foreground"
                        }`}
                      >
                        {option === "card" ? "Card" : "M-PESA"}
                      </button>
                    ))}
                  </div>
                )}
                <button
                  type="button"
                  onClick={startCheckout}
                  disabled={
                    busy ||
                    (method === "mpesa" && summary.mpesaEnabled
                      ? mpesaPhone.trim().length < 9
                      : !summary.paymentsEnabled)
                  }
                  className="kazi-button-primary px-4 py-2 text-sm disabled:opacity-50"
                >
                  {method === "mpesa" && summary.mpesaEnabled
                    ? "Send M-PESA prompt"
                    : "Continue to payment"}
                  <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
                </button>
              </div>
              {summary.mpesaEnabled && method === "mpesa" && (
                <label className="mt-3 block max-w-xs">
                  <span className="mb-1 block text-sm text-muted-foreground">
                    Phone number for the M-PESA prompt
                  </span>
                  <input
                    type="tel"
                    inputMode="tel"
                    value={mpesaPhone}
                    onChange={e => setMpesaPhone(e.target.value)}
                    placeholder="0712 345 678"
                    className="kazi-input"
                  />
                </label>
              )}
              {summary.mpesaEnabled && method === "mpesa" && mpesaReference && (
                <div className="kazi-alert-card mt-4 p-4 text-sm">
                  <p className="text-foreground" aria-live="polite">
                    Check your phone for the M-PESA prompt and enter your PIN. This page asks
                    Safaricom what happened every few seconds; nothing changes until the payment
                    is confirmed.
                  </p>
                  <button
                    type="button"
                    onClick={checkMpesa}
                    disabled={busy}
                    className="kazi-button-secondary mt-3 px-4 py-2 text-sm disabled:opacity-50"
                  >
                    Check M-PESA status
                  </button>
                </div>
              )}
              {!summary.paymentsEnabled && !summary.mpesaEnabled && (
                <p className="mt-3 text-xs text-muted-foreground">
                  Card payments are not configured on this server, so plan changes are unavailable
                  here. Community remains fully usable.
                </p>
              )}
              {!summary.paymentsEnabled && summary.mpesaEnabled && method === "card" && (
                <p className="mt-3 text-xs text-muted-foreground">
                  Card payments are not configured on this server. Choose M-PESA above to pay
                  with your phone.
                </p>
              )}
            </>
          )}
        </div>
      )}

      {/* A free business buys here, without leaving Billing. Paid plans come from the
          public catalogue, the price shown is the row the server will charge, and the
          checkout opened below is the same server-priced one the pricing page uses. */}
      {canManage && summary.plan.isFree && (
        <div className="kazi-card p-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="kazi-section-title text-foreground">Upgrade your plan</h2>
              <p className="mt-1 max-w-xl text-sm text-muted-foreground">
                Need more room or more locations? Pick a plan and pay right here — it is
                active the moment{" "}
                {summary.mpesaEnabled && method === "mpesa"
                  ? "Safaricom confirms"
                  : "Paystack confirms"}
                , and nothing you have is touched.
              </p>
            </div>
            <Link to="/pricing" className="text-sm text-muted-foreground hover:text-foreground">
              Compare all plans
            </Link>
          </div>

          {catalogueError && <p className="mt-4 text-sm text-destructive">{catalogueError}</p>}

          {!catalogueError && catalogue.length === 0 && (
            <p className="mt-4 text-sm text-muted-foreground">Loading the plans you can buy...</p>
          )}

          {catalogue.length > 0 && (
            <div className="mt-5 grid gap-4 md:grid-cols-2">
              {catalogue.map(plan => {
                const price = priceFor(plan, interval);
                const selected = plan.key === selectedPlanKey;
                return (
                  <button
                    key={plan.key}
                    type="button"
                    onClick={() => setSelectedPlanKey(plan.key)}
                    aria-pressed={selected}
                    className={`rounded-xl border p-5 text-left transition-colors ${
                      selected
                        ? "border-accent ring-1 ring-accent"
                        : "border-border hover:border-accent/60"
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-base font-semibold text-foreground">{plan.name}</p>
                      {selected && (
                        <span className="rounded-full bg-accent/15 px-2 py-0.5 text-xs font-medium text-accent">
                          Selected
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-sm text-muted-foreground">{plan.description}</p>
                    {price && (
                      <p className="mt-3 text-xl font-semibold text-foreground">
                        {formatMoney(price.amountCents, price.currency)}{" "}
                        <span className="text-xs font-normal text-muted-foreground">
                          {interval === "yearly" ? "per year" : "per month"}
                          {plan.trialDays > 0 ? `, ${plan.trialDays} days free` : ""}
                        </span>
                      </p>
                    )}
                    {plan.highlight && (
                      <p className="mt-1 text-xs font-medium text-accent">{plan.highlight}</p>
                    )}
                    <ul className="mt-3 space-y-1.5 text-sm">
                      {plan.features.slice(0, 4).map(feature => (
                        <li key={feature.key} className="flex items-start gap-2">
                          <Check
                            className="mt-0.5 h-4 w-4 shrink-0 text-success"
                            aria-hidden="true"
                          />
                          <span className="text-muted-foreground">{feature.name}</span>
                        </li>
                      ))}
                    </ul>
                  </button>
                );
              })}
            </div>
          )}

          {catalogue.length > 0 && (
            <p className="mt-4 text-xs text-muted-foreground">
              {summary.mpesaEnabled && method === "mpesa"
                ? "The amount above is exactly what M-PESA charges, in shillings. Safaricom asks for your PIN on your phone; no PIN ever touches KaziOS."
                : "The amount above is exactly what the card is asked for. Paystack collects the card on its own page; no card number ever touches KaziOS."}
            </p>
          )}
        </div>
      )}


      <div className="kazi-card overflow-hidden">
        <div className="p-6">
          <h2 className="kazi-section-title text-foreground">Payment history</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Every payment attempt for this business, with its reference.
          </p>
        </div>

        {summary.recentPayments.length === 0 ? (
          <p className="border-t border-border px-6 py-4 text-sm text-muted-foreground">
            No payments yet. The Community plan does not require one.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[36rem] border-collapse">
              <thead className="bg-surface-muted">
                <tr>
                  {["Date", "Plan", "Amount", "Status", "Reference"].map(heading => (
                    <th
                      key={heading}
                      scope="col"
                      className="px-6 py-3 text-left text-xs font-medium uppercase text-muted-foreground"
                    >
                      {heading}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {summary.recentPayments.map(payment => (
                  <tr key={payment.id} className="hover:bg-surface-muted/50">
                    <td className="px-6 py-4 text-sm text-foreground">
                      {formatDate(payment.paidAt ?? payment.createdAt)}
                    </td>
                    <td className="px-6 py-4 text-sm text-muted-foreground">{payment.planName}</td>
                    <td className="px-6 py-4 text-sm text-foreground">
                      {formatMoney(payment.amountCents, payment.currency)}
                    </td>
                    <td className="px-6 py-4">
                      <span
                        className={`inline-flex items-center gap-1 text-xs font-medium ${
                          payment.status === "SUCCESS"
                            ? "text-success"
                            : payment.status === "FAILED"
                              ? "text-destructive"
                              : "text-muted-foreground"
                        }`}
                      >
                        {payment.status === "SUCCESS" ? (
                          <Check className="h-3 w-3" aria-hidden="true" />
                        ) : (
                          <RefreshCw className="h-3 w-3" aria-hidden="true" />
                        )}
                        {payment.status.toLowerCase()}
                      </span>
                      {payment.failureReason && (
                        <p className="mt-1 text-xs text-muted-foreground">
                          {payment.failureReason}
                        </p>
                      )}
                    </td>
                    <td className="px-6 py-4 font-mono text-xs text-muted-foreground">
                      {payment.reference}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
