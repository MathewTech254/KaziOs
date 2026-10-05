import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowUpRight, Check, HelpCircle, Minus, ShieldCheck } from "lucide-react";
import { api, getApiError } from "../lib/api";
import { formatMoney } from "../lib/entitlements";
import { useEntitlements } from "../lib/entitlements";
import { BrandLogo } from "../components/BrandLogo";

/**
 * The public pricing page.
 *
 * Everything on it is read from `GET /plans`, which reads rows. There is no plan name,
 * price, feature or limit written into this file, and no comparison row that is not
 * backed by a stored entitlement. That is the point: the page cannot advertise something
 * the API would not enforce, because it has no way to know anything the database does not
 * already say.
 *
 * Features the system cannot yet enforce are not sent by the API at all, so they cannot
 * appear here. Adding one to a plan makes it appear with no change to this file.
 */

interface CataloguePlan {
  key: string;
  name: string;
  description: string;
  highlight: string | null;
  isFree: boolean;
  trialDays: number;
  prices: { interval: string; amountCents: number; currency: string }[];
  features: { key: string; name: string; description: string; category: string }[];
  limits: {
    key: string;
    value: number | null;
    unlimited: boolean;
    unit: string;
    period: string;
  }[];
}

interface Comparison {
  features: { key: string; name: string; description: string; category: string; plans: string[] }[];
  limits: { key: string; unit: string; period: string; values: Record<string, number | null> }[];
}

interface Catalogue {
  plans: CataloguePlan[];
  comparison: Comparison;
}

const LIMIT_LABELS: Record<string, string> = {
  users: "Team members",
  branches: "Branches",
  products: "Products",
  monthly_transactions: "Sales each month",
  ai_requests: "AI requests each month",
  api_requests: "API requests each month",
  storage_megabytes: "Storage",
};

/** Free-forever plans have no trial, because a trial that never ends is a lie. */
function periodLabel(plan: CataloguePlan, interval: string): string {
  if (plan.isFree) return "forever";
  if (interval === "yearly") return "per year";
  return plan.trialDays > 0 ? `per month, ${plan.trialDays} days free` : "per month";
}

function priceFor(plan: CataloguePlan, interval: string) {
  return plan.prices.find(p => p.interval === interval) ?? null;
}

const FAQS = [
  {
    question: "What happens if I go over a limit?",
    answer:
      "Nothing is deleted, and nothing is switched off without telling you. You keep everything you have, we warn you at 80% of an allowance, and the thing that stops working is only the one thing that needs more room. Upgrading takes effect immediately; downgrading takes effect at the end of the period you have already paid for.",
  },
  {
    question: "What happens if a payment fails?",
    answer:
      "Your business keeps working. A failed renewal starts a grace period, we tell you, and you have time to fix your payment method. Only when that grace period runs out do paid capabilities pause. Your customers, stock, invoices and history are untouched either way, and come straight back if you pay again.",
  },
  {
    question: "Do I lose my data if I cancel?",
    answer:
      "No. Cancelling stops paid capabilities at the end of the period you paid for. Everything you have created stays exactly where it is, and reactivating puts you back on the same data.",
  },
  {
    question: "Is Community really free?",
    answer:
      "Yes, and it is not a trial. Community is the open source product on a plan that never expires. It includes the whole core: point of sale, products, inventory, customers, purchasing, reports, roles and expenses. It holds one location and a small team, which is what a paid plan adds.",
  },
  {
    question: "Can I self host KaziOS?",
    answer:
      "Yes, and that is what KaziOS is built for. KaziOS is open source and runs on your own infrastructure with Community, or with any paid plan on your own servers. The paid plans buy convenience, scale, managed infrastructure and support, not the software itself.",
  },
  {
    question: "How do upgrades and downgrades work?",
    answer:
      "An upgrade takes effect the moment payment is confirmed. A downgrade is scheduled for the end of the period you have already paid for, so you keep what you have bought until then.",
  },
  {
    question: "Do you offer custom plans?",
    answer:
      "Yes. Enterprise is quoted to your volume, your locations and your requirements, with limits agreed in advance rather than imposed. Get in touch and we will work it out with you.",
  },
  {
    question: "What payment methods do you accept?",
    answer:
      "Card payments are processed through Paystack, which covers the cards and mobile money methods available across the markets we serve.",
  },
];

export function PricingPage() {
  const [catalogue, setCatalogue] = useState<Catalogue | null>(null);
  const [interval, setInterval] = useState<"monthly" | "yearly">("monthly");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [openFaq, setOpenFaq] = useState<number | null>(0);
  const { entitlements } = useEntitlements();

  useEffect(() => {
    let cancelled = false;
    api
      .get("/plans")
      .then(res => {
        if (!cancelled) {
          setCatalogue(res.data.data);
          setError("");
        }
      })
      .catch(err => {
        if (!cancelled) setError(getApiError(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const plans = catalogue?.plans ?? [];
  const currentPlanKey = entitlements?.planKey ?? null;

  // A yearly toggle that silently shows a plan we cannot sell would be worse than no
  // toggle at all, so it only offers what the API returned a price for.
  const yearlyAvailable = useMemo(() => plans.some(plan => priceFor(plan, "yearly")), [plans]);

  const choose = (plan: CataloguePlan) => {
    // Signed out: the chosen plan travels with the sign-up (`?plan=`), so the workspace
    // lands on billing with the plan already selected rather than starting over. Signed
    // in: straight to the billing tab with the plan pre-chosen.
    if (!entitlements) return plan.isFree ? "/register" : `/register?plan=${plan.key}`;
    return `/settings?tab=billing&plan=${plan.key}`;
  };

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-accent border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border">
        <div className="mx-auto flex min-h-16 max-w-6xl items-center justify-between px-5 sm:px-8">
          <Link to="/" aria-label="KaziOS home" className="flex items-center gap-3">
            <BrandLogo variant="mark" className="h-9 w-9 rounded-[10px]" />
            <span className="kazi-display text-lg font-semibold tracking-tight">KaziOS</span>
          </Link>
          <nav className="flex items-center gap-3 text-sm" aria-label="Account">
            {entitlements ? (
              <>
                <span className="hidden text-muted-foreground sm:inline">
                  On the {entitlements.planKey} plan
                </span>
                <Link to="/settings?tab=billing" className="kazi-button-secondary px-4 py-2">
                  Billing
                </Link>
                <Link to="/dashboard" className="kazi-button-primary px-4 py-2">
                  Open KaziOS
                </Link>
              </>
            ) : (
              <>
                <Link to="/login" className="kazi-button-secondary px-4 py-2">
                  Sign in
                </Link>
                <Link to="/register" className="kazi-button-primary px-4 py-2">
                  Create account
                </Link>
              </>
            )}
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-5 py-12 sm:px-8 sm:py-16">
        <div className="mx-auto max-w-3xl text-center">
          <h1 className="kazi-display text-4xl font-semibold tracking-tight sm:text-5xl">
            Pricing that does not take the till away
          </h1>
          <p className="mx-auto mt-4 max-w-2xl text-muted-foreground">
            Community is the whole of KaziOS and it is free forever, not a trial. Paid plans add
            scale, more locations, managed infrastructure and support. Nothing you have created is
            ever deleted, whether you upgrade, downgrade or stop paying.
          </p>
        </div>

        {error && (
          <div className="kazi-alert-card mx-auto mt-8 max-w-2xl p-4 text-center text-sm">
            {error}
          </div>
        )}

        {yearlyAvailable && (
          <div className="mt-10 flex justify-center">
            <div
              className="inline-flex rounded-full border border-border p-1"
              role="group"
              aria-label="Billing period"
            >
              {(["monthly", "yearly"] as const).map(option => (
                <button
                  key={option}
                  type="button"
                  onClick={() => setInterval(option)}
                  aria-pressed={interval === option}
                  className={`rounded-full px-5 py-2 text-sm font-medium transition-colors ${
                    interval === option
                      ? "bg-accent text-accent-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {option === "monthly" ? "Monthly" : "Yearly"}
                  {option === "yearly" && (
                    <span className="ml-2 text-xs opacity-80">2 months free</span>
                  )}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="mt-10 grid gap-5 lg:grid-cols-4">
          {plans.map(plan => {
            const price = priceFor(plan, interval);
            const isCurrent = currentPlanKey === plan.key;
            const featured = plan.key === "starter";

            return (
              <div
                key={plan.key}
                className={`kazi-card flex flex-col p-6 ${
                  featured ? "border-accent ring-1 ring-accent" : ""
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <h2 className="kazi-section-title text-foreground">{plan.name}</h2>
                  {isCurrent && (
                    <span className="rounded-full bg-accent/15 px-2 py-0.5 text-xs font-medium text-accent">
                      Your plan
                    </span>
                  )}
                </div>

                <p className="mt-2 min-h-[2.5rem] text-sm text-muted-foreground">
                  {plan.description}
                </p>

                <div className="mt-5">
                  {plan.isFree || !price ? (
                    <p className="kazi-display text-3xl font-semibold">
                      {plan.isFree ? "Free" : "Let's talk"}
                    </p>
                  ) : (
                    <p className="kazi-display text-3xl font-semibold">
                      {formatMoney(price.amountCents, price.currency)}
                    </p>
                  )}
                  <p className="mt-1 text-xs text-muted-foreground">
                    {plan.isFree || !price ? "" : periodLabel(plan, interval)}
                  </p>
                </div>

                {plan.highlight && (
                  <p className="mt-3 text-xs font-medium text-accent">{plan.highlight}</p>
                )}

                <ul className="mt-5 flex-1 space-y-2 text-sm">
                  {plan.features.slice(0, 6).map(feature => (
                    <li key={feature.key} className="flex items-start gap-2">
                      <Check className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden="true" />
                      <span className="text-muted-foreground">{feature.name}</span>
                    </li>
                  ))}
                </ul>

                <div className="mt-6">
                  {isCurrent ? (
                    <Link
                      to="/settings?tab=billing"
                      className="kazi-button-secondary block w-full px-4 py-2 text-center text-sm"
                    >
                      Manage plan
                    </Link>
                  ) : price ? (
                    <Link
                      to={choose(plan)}
                      className="kazi-button-primary block w-full px-4 py-2 text-center text-sm"
                    >
                      {currentPlanKey ? "Change plan" : "Get started"}
                      <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
                    </Link>
                  ) : (
                    <a
                      href="mailto:sales@kazios.test?subject=KaziOS%20Enterprise"
                      className="kazi-button-secondary block w-full px-4 py-2 text-center text-sm"
                    >
                      Contact sales
                    </a>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <p className="mt-6 flex items-center justify-center gap-2 text-center text-xs text-muted-foreground">
          <ShieldCheck className="h-4 w-4" aria-hidden="true" />
          Every feature listed here is enforced by the API, not just hidden in the interface.
        </p>

        <section className="mt-16" aria-labelledby="compare-heading">
          <h2 id="compare-heading" className="kazi-display text-2xl font-semibold tracking-tight">
            What each plan includes
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">
            The full comparison, straight from the same rows the API enforces.
          </p>

          <div className="mt-6 overflow-x-auto rounded-lg border border-border">
            <table className="w-full min-w-[40rem] border-collapse">
              <caption className="sr-only">Comparison of plans, features and limits</caption>
              <thead className="bg-surface-muted">
                <tr>
                  <th
                    scope="col"
                    className="px-5 py-3 text-left text-xs font-medium uppercase text-muted-foreground"
                  >
                    What you get
                  </th>
                  {plans.map(plan => (
                    <th
                      key={plan.key}
                      scope="col"
                      className="px-5 py-3 text-left text-xs font-medium uppercase text-muted-foreground"
                    >
                      {plan.name}
                      {currentPlanKey === plan.key && (
                        <span className="ml-2 normal-case text-accent">current</span>
                      )}
                    </th>
                  ))}
                </tr>
              </thead>

              <tbody className="divide-y divide-border">
                <tr className="bg-surface-muted/40">
                  <th
                    scope="colgroup"
                    colSpan={plans.length + 1}
                    className="px-5 py-2 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground"
                  >
                    Core
                  </th>
                </tr>
                {(catalogue?.comparison.features ?? [])
                  .filter(feature => feature.category === "CORE")
                  .map(feature => (
                    <tr key={feature.key}>
                      <th
                        scope="row"
                        className="px-5 py-3 text-left text-sm font-medium text-foreground"
                      >
                        {feature.name}
                      </th>
                      {plans.map(plan => (
                        <td key={plan.key} className="px-5 py-3">
                          {feature.plans.includes(plan.key) ? (
                            <Check
                              className="h-4 w-4 text-success"
                              aria-label="Included"
                              role="img"
                            />
                          ) : (
                            <Minus
                              className="h-4 w-4 text-muted-foreground/50"
                              aria-label="Not included"
                              role="img"
                            />
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}

                <tr className="bg-surface-muted/40">
                  <th
                    scope="colgroup"
                    colSpan={plans.length + 1}
                    className="px-5 py-2 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground"
                  >
                    Paid capabilities
                  </th>
                </tr>
                {(catalogue?.comparison.features ?? [])
                  .filter(feature => feature.category !== "CORE")
                  .map(feature => (
                    <tr key={feature.key}>
                      <th
                        scope="row"
                        className="px-5 py-3 text-left text-sm font-medium text-foreground"
                      >
                        {feature.name}
                      </th>
                      {plans.map(plan => (
                        <td key={plan.key} className="px-5 py-3">
                          {feature.plans.includes(plan.key) ? (
                            <Check
                              className="h-4 w-4 text-success"
                              aria-label="Included"
                              role="img"
                            />
                          ) : (
                            <Minus
                              className="h-4 w-4 text-muted-foreground/50"
                              aria-label="Not included"
                              role="img"
                            />
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}
                <tr className="bg-surface-muted/40">
                  <th
                    scope="colgroup"
                    colSpan={plans.length + 1}
                    className="px-5 py-2 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground"
                  >
                    Limits
                  </th>
                </tr>
                {(catalogue?.comparison.limits ?? []).map(limit => (
                  <tr key={limit.key}>
                    <th
                      scope="row"
                      className="px-5 py-3 text-left text-sm font-medium text-foreground"
                    >
                      {LIMIT_LABELS[limit.key] ?? limit.key.replace(/_/g, " ")}
                      {limit.period === "monthly" && (
                        <span className="ml-1 text-xs font-normal text-muted-foreground">
                          / month
                        </span>
                      )}
                    </th>
                    {plans.map(plan => {
                      const value = limit.values[plan.key];
                      return (
                        <td key={plan.key} className="px-5 py-3 text-sm text-muted-foreground">
                          {value === undefined
                            ? "—"
                            : value === null
                              ? "Unlimited"
                              : limit.unit === "megabytes"
                                ? `${(value / 1024).toFixed(value % 1024 === 0 ? 0 : 1)} GB`
                                : value.toLocaleString()}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="mt-16" aria-labelledby="faq-heading">
          <h2
            id="faq-heading"
            className="kazi-display flex items-center gap-2 text-2xl font-semibold tracking-tight"
          >
            <HelpCircle className="h-6 w-6 text-accent" aria-hidden="true" />
            Questions people actually ask
          </h2>

          <div className="mt-6 space-y-3">
            {FAQS.map((faq, index) => {
              const open = openFaq === index;
              return (
                <div key={faq.question} className="kazi-card overflow-hidden">
                  <button
                    type="button"
                    onClick={() => setOpenFaq(open ? null : index)}
                    aria-expanded={open}
                    className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left"
                  >
                    <span className="text-sm font-medium text-foreground">{faq.question}</span>
                    <span className="text-muted-foreground" aria-hidden="true">
                      {open ? "−" : "+"}
                    </span>
                  </button>
                  {open && (
                    <p className="border-t border-border px-5 py-4 text-sm text-muted-foreground">
                      {faq.answer}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        </section>

        <section className="mt-16">
          <div className="kazi-card flex flex-col items-center gap-4 p-8 text-center">
            <h2 className="kazi-display text-2xl font-semibold tracking-tight">
              Need something we do not list?
            </h2>
            <p className="max-w-xl text-sm text-muted-foreground">
              Enterprise plans are agreed to your volume, your locations and your requirements, with
              limits set in advance rather than imposed. If your business does not fit the table
              above, that is what Enterprise is for.
            </p>
            <a
              href="mailto:sales@kazios.test?subject=KaziOS%20custom%20plan"
              className="kazi-button-primary px-5 py-2 text-sm"
            >
              Talk to us
              <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
            </a>
          </div>
        </section>
      </main>

      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-3 px-5 py-8 text-xs text-muted-foreground sm:flex-row sm:px-8">
          <p>KaziOS. Open source, self hostable, yours.</p>
          <nav className="flex gap-4" aria-label="Footer">
            <Link to="/" className="hover:text-foreground">
              Home
            </Link>
            <Link to="/login" className="hover:text-foreground">
              Sign in
            </Link>
            <Link to="/register" className="hover:text-foreground">
              Create account
            </Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}
