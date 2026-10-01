import {
  BarChart3,
  Building2,
  ChevronLeft,
  Command,
  FileText,
  LayoutDashboard,
  Moon,
  Package,
  Plus,
  Receipt,
  Settings,
  ShoppingBag,
  Sun,
  User,
  Users,
  Warehouse,
} from "lucide-react";
import { Link, useLocation } from "react-router-dom";
import { useEffect, useState } from "react";
import { useAuth } from "../contexts/AuthContext";
import { useTheme } from "../hooks/useTheme";
import { BrandLogo } from "./BrandLogo";
import { CommandPalette } from "./CommandPalette";
import { NotificationBell } from "./NotificationBell";

interface NavGroup {
  label: string;
  items: { to: string; label: string; icon: React.ElementType }[];
}

const NAV_GROUPS: NavGroup[] = [
  {
    label: "Overview",
    items: [{ to: "/dashboard", label: "Dashboard", icon: LayoutDashboard }],
  },
  {
    label: "Sell",
    items: [
      { to: "/pos", label: "POS", icon: ShoppingBag },
      { to: "/dashboard/invoices", label: "Invoices", icon: FileText },
      { to: "/dashboard/payments", label: "Payments", icon: Receipt },
      { to: "/dashboard/customers", label: "Customers", icon: Users },
    ],
  },
  {
    label: "Operate",
    items: [
      { to: "/dashboard/products", label: "Products", icon: Package },
      { to: "/inventory", label: "Inventory", icon: Warehouse },
      { to: "/purchases", label: "Purchasing", icon: Building2 },
    ],
  },
  {
    label: "Finance",
    items: [{ to: "/dashboard/reports", label: "Reports", icon: BarChart3 }],
  },
  {
    label: "Organization",
    items: [{ to: "/settings", label: "Settings", icon: Settings }],
  },
];

interface AppShellProps {
  collapsed: boolean;
  onToggle: () => void;
}

export function AppSidebar({ collapsed, onToggle }: AppShellProps) {
  const location = useLocation();

  return (
    <aside
      className={`kazi-sidebar fixed left-0 top-0 z-30 flex h-screen flex-col border-r transition-all duration-300 ${collapsed ? "w-16" : "w-64"}`}
    >
      <div className="flex h-16 items-center gap-3 border-b border-border px-3 sm:px-4">
        <Link
          to="/dashboard"
          aria-label="KaziOS dashboard"
          className="flex min-w-0 items-center gap-3"
        >
          <BrandLogo variant="mark" className="h-9 w-9 rounded-[10px]" />
          {!collapsed && (
            <span className="kazi-display truncate text-base font-semibold tracking-[-.03em] text-foreground">
              KaziOS
            </span>
          )}
        </Link>
      </div>

      <nav className="flex-1 overflow-y-auto py-4" aria-label="Workspace navigation">
        {NAV_GROUPS.map(group => (
          <div key={group.label} className="mb-5 px-2 sm:px-3">
            {!collapsed && <p className="kazi-section-title mb-2 px-2">{group.label}</p>}
            {group.items.map(item => {
              const Icon = item.icon;
              const active = location.pathname === item.to;
              return (
                <Link
                  key={item.to}
                  to={item.to}
                  title={collapsed ? item.label : undefined}
                  aria-current={active ? "page" : undefined}
                  data-active={active}
                  className="kazi-sidebar-link flex items-center gap-3 rounded-lg px-2 py-2 text-sm"
                >
                  <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                  {!collapsed && <span className="truncate">{item.label}</span>}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      <div className="border-t border-border p-2">
        <button
          onClick={onToggle}
          className="kazi-sidebar-link flex w-full items-center justify-center gap-2 rounded-lg px-2 py-2 text-sm"
          aria-label={collapsed ? "Expand navigation" : "Collapse navigation"}
        >
          <ChevronLeft
            className={`h-4 w-4 transition-transform ${collapsed ? "rotate-180" : ""}`}
            aria-hidden="true"
          />
          {!collapsed && <span>Collapse</span>}
        </button>
      </div>
    </aside>
  );
}

export function TopBar({ collapsed }: { collapsed: boolean }) {
  const { theme, toggleTheme } = useTheme();
  const { user, logout } = useAuth();
  const [paletteOpen, setPaletteOpen] = useState(false);

  // Cmd/Ctrl+K is the shortcut the button advertises, so make it real.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setPaletteOpen(open => !open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Layer order, decided once and in one place so it cannot drift:
  //   sidebar  z-30   the workspace's fixed furniture
  //   top bar  z-40   spans the sidebar, and hosts menus that must sit above it
  //   overlay  z-50   command palette and any full screen surface
  // The notification menu is absolutely positioned inside the top bar, so it can only
  // ever be as high as the top bar itself. Raising the bar above the sidebar is what
  // stops a menu from being painted underneath it.
  //
  // This comment belongs here, above the return. Inside the returned JSX a `//` line
  // is not a comment at all: it compiles to a text node and the words appear on screen.
  return (
    <>
      <header
        className="kazi-topbar fixed top-0 z-40 flex h-16 items-center justify-between border-b px-4 sm:px-6"
        style={{ left: collapsed ? "4rem" : "16rem" }}
      >
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            className="kazi-search-button flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm"
            aria-label="Search workspace"
          >
            <Command className="h-4 w-4" aria-hidden="true" />
            <span>Search</span>
            <kbd className="ml-2 rounded border px-1.5 py-0.5 text-[10px]">⌘K</kbd>
          </button>
        </div>
        <div className="flex items-center gap-1 sm:gap-2">
          <button
            onClick={toggleTheme}
            className="kazi-shell-icon-button flex h-10 w-10 items-center justify-center rounded-lg"
            title="Toggle theme"
            aria-label="Toggle theme"
          >
            {theme === "dark" ? (
              <Sun className="h-4 w-4" aria-hidden="true" />
            ) : (
              <Moon className="h-4 w-4" aria-hidden="true" />
            )}
          </button>
          <NotificationBell />
          <button
            onClick={logout}
            className="kazi-account-button flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm"
            aria-label="Sign out"
          >
            <User className="h-4 w-4" aria-hidden="true" />
            <span className="hidden max-w-[9rem] truncate md:inline">
              {user?.name || "Account"}
            </span>
          </button>
        </div>
      </header>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </>
  );
}

export function QuickActionsFab() {
  return (
    <button
      className="kazi-fab fixed bottom-5 right-5 z-20 flex h-12 w-12 items-center justify-center rounded-full"
      aria-label="Quick action"
      title="Quick action"
    >
      <Plus className="h-5 w-5" aria-hidden="true" />
    </button>
  );
}
