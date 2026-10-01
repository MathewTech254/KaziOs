import { useState } from "react";
import { Outlet } from "react-router-dom";
import { AppSidebar, TopBar, QuickActionsFab } from "./AppShell";

export function Layout() {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className="kazi-workspace-shell min-h-screen bg-background text-foreground">
      <AppSidebar collapsed={collapsed} onToggle={() => setCollapsed(!collapsed)} />
      <div style={{ marginLeft: collapsed ? "4rem" : "16rem" }}>
        <TopBar collapsed={collapsed} />
        <main className="mt-16 p-4 sm:p-6">
          <Outlet />
        </main>
      </div>
      <QuickActionsFab />
    </div>
  );
}
