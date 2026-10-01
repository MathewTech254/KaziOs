import { useState } from "react";
import { Building2, Percent, ShieldCheck, SlidersHorizontal, Warehouse } from "lucide-react";
import { useAuth } from "../contexts/AuthContext";
import { SettingsOrganizationPanel } from "../components/SettingsOrganizationPanel";
import { SettingsLocationsPanel } from "../components/SettingsLocationsPanel";
import { SettingsTaxPanel } from "../components/SettingsTaxPanel";
import { SettingsPreferencesPanel } from "../components/SettingsPreferencesPanel";
import { SettingsRolesPanel } from "../components/SettingsRolesPanel";
import { SettingsUsersPanel } from "../components/SettingsUsersPanel";

const TABS = [
  { id: "organization", label: "Organization", icon: Building2 },
  { id: "locations", label: "Locations", icon: Warehouse },
  { id: "tax", label: "Tax", icon: Percent },
  { id: "preferences", label: "Preferences", icon: SlidersHorizontal },
  { id: "roles", label: "Roles & permissions", icon: ShieldCheck },
] as const;

type TabId = (typeof TABS)[number]["id"];

export function SettingsPage() {
  const { hasPermission } = useAuth();
  const [tab, setTab] = useState<TabId>("organization");

  const canManage = hasPermission("settings.manage");
  const canViewUsers = canManage || hasPermission("users.view");

  return (
    <div>
      <div className="mb-6">
        <h1 className="kazi-page-title">Settings</h1>
        <p className="kazi-page-subtitle">
          Organization profile, locations, tax, preferences and access control
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
    </div>
  );
}
