import { useEffect } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowUpRight, Boxes, FileText, UsersRound } from "lucide-react";
import { useAuth } from "../contexts/AuthContext";
import { BrandLogo } from "../components/BrandLogo";
import { VideoBackdrop } from "../components/VideoBackdrop";

const capabilityItems = [
  { title: "Sales", description: "Invoices, payments, revenue.", accent: "text-accent" },
  { title: "Inventory", description: "Products, stock, alerts.", accent: "text-success" },
  { title: "Customers", description: "Relationships, history.", accent: "text-info" },
  { title: "Reports", description: "A clearer operating view.", accent: "text-warning" },
];

const detailItems = [
  {
    number: "01",
    title: "Make the sale visible",
    description: "Keep invoices and payments connected to the work behind them.",
    accent: "text-accent",
  },
  {
    number: "02",
    title: "Protect the stock position",
    description: "Know what is available before the next order or promise.",
    accent: "text-success",
  },
  {
    number: "03",
    title: "Keep the relationship close",
    description: "Give every customer, invoice, and report a dependable place.",
    accent: "text-info",
  },
];

const operationalItems = [
  {
    title: "Sales",
    description: "Track revenue",
    icon: ArrowUpRight,
    accent: "text-accent",
    surface: "bg-accent/15",
  },
  {
    title: "Inventory",
    description: "Stay in stock",
    icon: Boxes,
    accent: "text-success",
    surface: "bg-success/15",
  },
  {
    title: "Customers",
    description: "Know your base",
    icon: UsersRound,
    accent: "text-info",
    surface: "bg-info/15",
  },
  {
    title: "Invoices",
    description: "Keep paid work moving",
    icon: FileText,
    accent: "text-warning",
    surface: "bg-warning/15",
  },
];

export function LandingPage() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (!loading && user) {
      navigate("/dashboard");
    }
  }, [user, loading, navigate]);

  if (loading) return null;

  return (
    <div className="min-h-screen overflow-hidden bg-[var(--kazi-ink)] text-[var(--kazi-text)] selection:bg-[var(--kazi-accent)] selection:text-[var(--kazi-ink)]">
      <header className="relative z-10 border-b border-white/10 bg-[rgba(7,21,45,0.96)]">
        <div className="mx-auto flex min-h-[5.75rem] max-w-[1328px] items-center justify-between px-5 sm:px-8 lg:px-14">
          <Link to="/" aria-label="KaziOS home" className="flex items-center gap-3 sm:gap-4">
            <BrandLogo variant="mark" className="h-11 w-11 sm:h-12 sm:w-12" />
            <div className="hidden sm:block">
              <div className="kazi-display text-[22px] font-semibold tracking-[-.03em] text-[var(--kazi-text)]">
                KaziOS
              </div>
              <div className="mt-0.5 text-[10px] font-semibold uppercase tracking-[.24em] text-[var(--kazi-muted-text)]">
                Business operating system
              </div>
            </div>
          </Link>

          <nav className="flex items-center gap-4 text-sm sm:gap-8" aria-label="Public navigation">
            <span className="hidden text-[var(--kazi-muted-text)] lg:inline">
              Built for the way African businesses operate
            </span>
            <Link
              to="/pricing"
              className="rounded-md px-2 py-2 font-medium text-[var(--kazi-text)] transition-colors hover:text-[var(--kazi-accent-hover)]"
            >
              Pricing
            </Link>
            <Link
              to="/login"
              className="rounded-md px-2 py-2 font-medium text-[var(--kazi-text)] transition-colors hover:text-[var(--kazi-accent-hover)]"
            >
              Sign in
            </Link>
            <Link to="/register" className="kazi-button-primary px-4 text-sm sm:px-5">
              Create account
              <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
            </Link>
          </nav>
        </div>
      </header>

      <main id="top">
        <section className="relative overflow-hidden border-b border-white/10 bg-[var(--kazi-ink)]">
          <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(rgba(255,255,255,.035)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,.035)_1px,transparent_1px)] bg-[length:52px_52px]" />
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_14%_15%,rgba(246,163,19,.12),transparent_25%),radial-gradient(circle_at_85%_78%,rgba(35,145,143,.12),transparent_30%)]" />

          <div className="relative mx-auto grid max-w-[1328px] gap-6 px-5 py-8 sm:px-8 lg:grid-cols-12 lg:gap-10 lg:px-14 lg:py-14">
            <div className="flex min-h-[36rem] flex-col justify-between rounded-[var(--radius-hero)] border border-white/10 bg-[var(--kazi-surface)] px-6 py-8 shadow-[var(--shadow-panel)] sm:px-10 sm:py-10 lg:col-span-7 lg:px-14 lg:py-14">
              <div>
                <div className="mb-9 flex items-center gap-3 text-[11px] font-semibold uppercase tracking-[.22em] text-[var(--kazi-accent)] sm:mb-12">
                  <span className="h-px w-8 bg-[var(--kazi-accent)]" aria-hidden="true" />
                  One workspace. Every moving part.
                </div>
                <BrandLogo
                  variant="wordmark"
                  className="mb-9 w-[17rem] sm:mb-12 sm:w-[20.625rem]"
                />
                <h1 className="kazi-display max-w-[640px] text-[clamp(2.875rem,5.3vw,5.125rem)] font-semibold leading-[.98] tracking-[-.065em] text-[var(--kazi-display-text)]">
                  Run the business.
                  <br />
                  <span className="text-[var(--kazi-accent)]">See what matters.</span>
                </h1>
                <p className="mt-7 max-w-[575px] text-base leading-7 text-[var(--kazi-body-text)] sm:mt-8 sm:text-[19px] sm:leading-8">
                  KaziOS brings sales, stock, customers, invoices, and reporting into one dependable
                  operating view—so the next decision is always close at hand.
                </p>
              </div>

              <div className="mt-10 flex flex-wrap items-center gap-5 sm:mt-12">
                <Link to="/register" className="kazi-button-primary px-5 text-sm sm:px-6">
                  Create your workspace
                  <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
                </Link>
                <Link
                  to="/login"
                  className="text-sm font-semibold text-[var(--kazi-text)] underline decoration-white/20 underline-offset-4 transition-colors hover:text-[var(--kazi-accent-hover)]"
                >
                  Sign in to an existing account
                </Link>
              </div>
            </div>

            <div className="kazi-video-panel relative isolate min-h-[30rem] overflow-hidden rounded-[var(--radius-hero)] border border-white/10 bg-[var(--kazi-video-surface)] lg:col-span-5 lg:min-h-[36rem]">
              <VideoBackdrop />
              <div className="relative flex h-full min-h-[30rem] flex-col justify-between p-6 sm:p-8 lg:min-h-[36rem] lg:p-10">
                <div className="flex items-center justify-between">
                  <span className="rounded-full border border-white/15 bg-[rgba(7,21,45,.55)] px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[.22em] text-[#d8e0ec]">
                    Operational view
                  </span>
                  <BrandLogo variant="mark" className="h-11 w-11 rounded-[13px]" />
                </div>

                <div>
                  <p className="max-w-[250px] text-[13px] font-medium leading-6 text-[#c3cfdf]">
                    A focused view of the work that keeps the business moving.
                  </p>
                  <div className="mt-6 divide-y divide-white/10 overflow-hidden rounded-[18px] border border-white/15 bg-[rgba(7,21,45,.78)] backdrop-blur-sm">
                    {operationalItems.map(({ title, description, icon: Icon, accent, surface }) => (
                      <div
                        key={title}
                        className="flex items-center justify-between gap-4 px-4 py-4 sm:px-5"
                      >
                        <div className="flex min-w-0 items-center gap-3">
                          <span
                            className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] ${surface} ${accent}`}
                          >
                            <Icon className="h-4 w-4" aria-hidden="true" />
                          </span>
                          <span className="truncate text-sm font-semibold text-[var(--kazi-text)]">
                            {title}
                          </span>
                        </div>
                        <span className="shrink-0 text-right text-xs text-[var(--kazi-muted-text)]">
                          {description}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="border-t border-white/15 pt-5 text-[11px] leading-5 text-[var(--kazi-muted-text)]">
                  Muted ambient motion · no audio · designed to stay behind the work
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="border-b border-white/10 bg-[var(--kazi-surface-raised)]">
          <div className="mx-auto max-w-[1328px] px-5 py-8 sm:px-8 lg:px-14 lg:py-9">
            <div className="flex flex-col gap-7 lg:flex-row lg:items-center lg:justify-between">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[.22em] text-[var(--kazi-accent)]">
                  Built around real work
                </p>
                <h2 className="kazi-display mt-2 text-2xl font-semibold tracking-[-.04em] text-[var(--kazi-display-text)]">
                  Everything important, without the noise.
                </h2>
              </div>
              <div className="grid flex-1 gap-5 sm:grid-cols-2 lg:ml-20 lg:grid-cols-4 lg:gap-3">
                {capabilityItems.map(item => (
                  <div key={item.title} className="border-l border-white/15 pl-4">
                    <p className={`text-sm font-semibold ${item.accent}`}>{item.title}</p>
                    <p className="mt-1 text-xs leading-5 text-[var(--kazi-muted-text)]">
                      {item.description}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        <section className="mx-auto max-w-[1328px] px-5 py-14 sm:px-8 lg:px-14 lg:py-16">
          <div className="grid gap-10 lg:grid-cols-[1.15fr_.85fr] lg:items-end">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[.22em] text-[var(--kazi-accent)]">
                A steadier way to operate
              </p>
              <h2 className="kazi-display mt-3 max-w-[610px] text-4xl font-semibold leading-[1.05] tracking-[-.055em] text-[var(--kazi-display-text)] sm:text-5xl">
                The detail is still there.
                <br />
                The clutter is not.
              </h2>
            </div>
            <p className="max-w-[430px] text-sm leading-7 text-[var(--kazi-body-text)]">
              From first invoice to end-of-month reporting, KaziOS keeps the operational record
              close, legible, and ready for the next action.
            </p>
          </div>

          <div className="mt-10 grid gap-4 md:grid-cols-3 lg:mt-12">
            {detailItems.map(item => (
              <div
                key={item.number}
                className="rounded-[var(--radius-card)] border border-white/10 bg-[var(--kazi-surface)] p-6"
              >
                <span
                  className={`text-[11px] font-semibold uppercase tracking-[.18em] ${item.accent}`}
                >
                  {item.number}
                </span>
                <h3 className="mt-8 text-lg font-semibold text-[var(--kazi-display-text)]">
                  {item.title}
                </h3>
                <p className="mt-3 text-sm leading-6 text-[var(--kazi-muted-text)]">
                  {item.description}
                </p>
              </div>
            ))}
          </div>
        </section>

        <section className="border-t border-white/10 bg-[var(--kazi-cream)] text-[var(--kazi-ink)]">
          <div className="mx-auto grid max-w-[1328px] gap-8 px-5 py-12 sm:px-8 lg:grid-cols-[1fr_auto] lg:items-center lg:px-14 lg:py-14">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[.22em] text-[#b66d00]">
                Start with a clearer view
              </p>
              <h2 className="kazi-display mt-3 text-3xl font-semibold tracking-[-.05em] text-[var(--kazi-ink)] sm:text-4xl">
                Set up the workspace your business can grow inside.
              </h2>
              <p className="mt-3 max-w-[650px] text-sm leading-6 text-[#53627a]">
                Create your account and bring the day-to-day operation into one place.
              </p>
            </div>
            <Link to="/register" className="kazi-button-primary w-full px-6 sm:w-auto">
              Create free account
              <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
            </Link>
          </div>
        </section>
      </main>

      <footer className="border-t border-white/10 bg-[var(--kazi-ink)]">
        <div className="mx-auto flex max-w-[1328px] flex-col gap-3 px-5 py-6 text-xs text-[var(--kazi-muted-text)] sm:flex-row sm:items-center sm:justify-between sm:px-8 lg:px-14">
          <span>© {new Date().getFullYear()} KaziOS · Built for African businesses.</span>
          <span>Sales · inventory · customers · invoices · reports</span>
        </div>
      </footer>
    </div>
  );
}
