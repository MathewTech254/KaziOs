import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  Building2,
  CreditCard,
  Percent,
  ShieldCheck,
  SlidersHorizontal,
  Warehouse,
} from "lucide-react";
import { useAuth } from "../contexts/AuthContext";
import { SettingsOrganizationPanel } from "../components/SettingsOrganizationPanel";
import { SettingsLocationsPanel } from "../components/SettingsLocationsPanel";
import { SettingsTaxPanel } from "../components/SettingsTaxPanel";
import { SettingsPreferencesPanel } from "../components/SettingsPreferencesPanel";
import { SettingsRolesPanel } from "../components/SettingsRolesPanel";
import { SettingsUsersPanel } from "../components/SettingsUsersPanel";
import { SettingsBillingPanel } from "../components/SettingsBillingPanel";

const TABS = [
  { id: "organization", label: "Organization", icon: Building2 },
  { id: "locations", label: "Locations", icon: Warehouse },
  { id: "tax", label: "Tax", icon: Percent },
  { id: "preferences", label: "Preferences", icon: SlidersHorizontal },
  { id: "roles", label: "Roles & permissions", icon: ShieldCheck },
  { id: "billing", label: "Billing", icon: CreditCard },
] as const;

type TabId = (typeof TABS)[number]["id"];

function isTabId(value: string | null): value is TabId {
  return TABS.some(tab => tab.id === value);
}

export function SettingsPage() {
  const { hasPermission } = useAuth();
  // The tab is in the URL because the pricing page links straight here: "Change plan" and
  // "Reactivate" both land on Billing rather than making the owner hunt for the tab.
  const [searchParams, setSearchParams] = useSearchParams();
  const requested = searchParams.get("tab");
  const [tab, setTab] = useState<TabId>(isTabId(requested) ? requested : "organization");

  const canManage = hasPermission("settings.manage");
  const canViewUsers = canManage || hasPermission("users.view");

  // Keeps the URL in step so a reload, or a browser back, returns to the tab that was open.
  useEffect(() => {
    if (requested === tab) return;
    const next = new URLSearchParams(searchParams);
    next.set("tab", tab);
    setSearchParams(next, { replace: true });
  }, [tab, requested, searchParams, setSearchParams]);

  return (
    <div>
      <div className="mb-6">
        <h1 className="kazi-page-title">Settings</h1>
        <p className="kazi-page-subtitle">
          Organization profile, locations, tax, preferences, access control and billing
        </p>
      </div>

      {!canManage && (
        <div className="kazi-alert-card mb-6 p-4 text-sm text-foreground">
          You have read-only access. An owner can grant the{" "}
          <span className="font-medium">settings.manage</span> permission to let you change these
          settings.
        </div>
      )}

      <div className="mb-6 flex flex-wrap gap-2">
        {TABS.map(item => {
          const Icon = item.icon;
          const active = tab === item.id;
          const disabled = item.id === "roles" && !canViewUsers;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => setTab(item.id)}
              disabled={disabled}
              data-active={active}
              aria-current={active ? "page" : undefined}
              className="kazi-sidebar-link flex items-center gap-2 rounded-lg px-3 py-2 text-sm disabled:opacity-40"
            >
              <Icon className="h-4 w-4" aria-hidden="true" />
              {item.label}
            </button>
          );
        })}
      </div>

      {tab === "organization" && <SettingsOrganizationPanel canManage={canManage} />}
      {tab === "locations" && <SettingsLocationsPanel canManage={canManage} />}
      {tab === "tax" && <SettingsTaxPanel canManage={canManage} />}
      {tab === "preferences" && <SettingsPreferencesPanel canManage={canManage} />}
      {tab === "roles" && canViewUsers && (
        <div className="space-y-6">
          <SettingsRolesPanel canManage={canManage} />
          <SettingsUsersPanel canManage={canManage} />
        </div>
      )}
      {tab === "billing" && <SettingsBillingPanel canManage={canManage} />}
    </div>
  );
}
