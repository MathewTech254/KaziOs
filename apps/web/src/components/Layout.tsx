import { useEffect, useState } from "react";
import { Outlet } from "react-router-dom";
import { WifiOff } from "lucide-react";
import { AppSidebar, TopBar, QuickActionsFab } from "./AppShell";

export function Layout() {
  const [collapsed, setCollapsed] = useState(false);
  const [isOnline, setIsOnline] = useState(typeof navigator !== "undefined" ? navigator.onLine : true);

  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  return (
    <div className="kazi-workspace-shell min-h-screen bg-background text-foreground">
      {!isOnline && (
        <div className="bg-amber-900/30 border-b border-amber-500/50 px-4 py-2">
          <div className="max-w-[1328px] mx-auto flex items-center gap-2 sm:px-8 lg:px-14">
            <WifiOff className="h-4 w-4 text-amber-400" />
            <span className="text-xs font-medium text-amber-200">
              No internet connection. Sales cannot be processed until you're back online.
            </span>
          </div>
        </div>
      )}
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
