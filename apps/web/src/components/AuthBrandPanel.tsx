import { BarChart3, Boxes, FileText, UsersRound } from "lucide-react";
import { BrandLogo } from "./BrandLogo";
import { VideoBackdrop } from "./VideoBackdrop";

interface AuthBrandPanelProps {
  mode: "login" | "register";
}

const operatingAreas = [
  { title: "Sales", description: "Invoices, payments, revenue.", icon: FileText, accent: "text-accent", surface: "bg-accent/15" },
  { title: "Inventory", description: "Products, stock, alerts.", icon: Boxes, accent: "text-success", surface: "bg-success/15" },
  { title: "Customers", description: "Relationships, history.", icon: UsersRound, accent: "text-info", surface: "bg-info/15" },
  { title: "Reports", description: "A clearer operating view.", icon: BarChart3, accent: "text-warning", surface: "bg-warning/15" },
];

export function AuthBrandPanel({ mode }: AuthBrandPanelProps) {
  const isRegister = mode === "register";

  return (
    <aside className="kazi-auth-panel relative isolate overflow-hidden rounded-[var(--radius-hero)] border border-white/10">
      <VideoBackdrop />
      <div className="kazi-auth-panel-content relative z-10 flex h-full min-h-[42rem] flex-col justify-between p-8 xl:p-10">
        <div className="flex items-start justify-between gap-5">
          <BrandLogo variant="wordmark" className="w-[16rem]" />
          <span className="rounded-full border border-white/15 bg-[rgba(7,21,45,.58)] px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[.2em] text-[#d8e0ec]">
            {isRegister ? "Start clearly" : "Welcome back"}
          </span>
        </div>

        <div className="max-w-[28rem]">
          <p className="mb-4 text-[11px] font-semibold uppercase tracking-[.22em] text-[var(--kazi-accent)]">One operating view</p>
          <h2 className="kazi-display max-w-[26rem] text-4xl font-semibold leading-[1.02] tracking-[-.06em] text-[var(--kazi-display-text)] xl:text-5xl">
            {isRegister ? "Build the workspace your business can grow inside." : "Keep the next decision close at hand."}
          </h2>
          <p className="mt-5 max-w-[25rem] text-sm leading-7 text-[var(--kazi-body-text)]">
            {isRegister
              ? "Bring sales, stock, customers, invoices, and reports into one dependable rhythm."
              : "A calm view of the work behind every sale, stock signal, customer, and report."}
          </p>

          <div className="kazi-auth-panel-list mt-8 divide-y divide-white/10 overflow-hidden rounded-[18px] border border-white/15 bg-[rgba(7,21,45,.74)] backdrop-blur-sm">
            {operatingAreas.map(({ title, description, icon: Icon, accent, surface }) => (
              <div key={title} className="flex items-center gap-3 px-4 py-3.5">
                <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] ${surface} ${accent}`}>
                  <Icon className="h-4 w-4" aria-hidden="true" />
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-semibold text-[var(--kazi-text)]">{title}</span>
                  <span className="block text-xs leading-5 text-[var(--kazi-muted-text)]">{description}</span>
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-3 border-t border-white/15 pt-5 text-[11px] leading-5 text-[var(--kazi-muted-text)]">
          <span className="h-1.5 w-1.5 rounded-full bg-[var(--kazi-success)]" aria-hidden="true" />
          <span>Muted ambient motion · no audio · designed to stay behind the work</span>
        </div>
      </div>
    </aside>
  );
}
