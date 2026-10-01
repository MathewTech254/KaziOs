import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext";
import { api } from "../lib/api";
import { useCurrency, formatMoney } from "../lib/currency";
import { Package, Users, FileText, BarChart2, TrendingUp, AlertTriangle } from "lucide-react";

interface ReportData {
  totalInvoices: number;
  totalRevenue: number;
  totalTax: number;
  totalDiscounts: number;
  totalPayments: number;
}

export function DashboardPage() {
  const { user } = useAuth();
  const currency = useCurrency();
  const [stats, setStats] = useState<ReportData | null>(null);

  useEffect(() => {
    api
      .get("/reports/sales-summary")
      .then(res => setStats(res.data.data))
      .catch(() => undefined);
  }, []);

  const cards = stats
    ? [
        { label: "Total Invoices", value: stats.totalInvoices, icon: FileText, color: "text-info" },
        {
          label: "Revenue",
          value: formatMoney(stats.totalRevenue, currency),
          icon: TrendingUp,
          color: "text-success",
        },
        {
          label: "Tax Collected",
          value: formatMoney(stats.totalTax, currency),
          icon: BarChart2,
          color: "text-accent",
        },
        { label: "Payments", value: stats.totalPayments, icon: Package, color: "text-warning" },
      ]
    : [];

  return (
    <div>
      <div className="mb-6">
        <h1 className="kazi-page-title">Dashboard</h1>
        <p className="kazi-page-subtitle">
          Welcome back, {user?.name}. Here is your organization overview.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {cards.map(stat => {
          const Icon = stat.icon;
          return (
            <div key={stat.label} className="kazi-stat-card">
              <div className="flex items-center justify-between">
                <p className="kazi-stat-label">{stat.label}</p>
                <Icon className={`h-5 w-5 ${stat.color}`} />
              </div>
              <p className="kazi-stat-value mt-1">{stat.value}</p>
            </div>
          );
        })}
      </div>

      <div className="mt-8">
        <h2 className="kazi-section-title mb-4">Quick Actions</h2>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Link
            to="/dashboard/invoices"
            className="kazi-action-card flex flex-col items-start p-4 text-left"
          >
            <FileText className="mb-3 h-5 w-5 text-accent" />
            <span className="text-sm font-medium text-foreground">New Invoice</span>
            <span className="text-xs text-muted-foreground">Create a sales invoice</span>
          </Link>
          <Link
            to="/dashboard/products"
            className="kazi-action-card flex flex-col items-start p-4 text-left"
          >
            <Package className="mb-3 h-5 w-5 text-success" />
            <span className="text-sm font-medium text-foreground">Add Product</span>
            <span className="text-xs text-muted-foreground">Add a new product</span>
          </Link>
          <Link
            to="/dashboard/customers"
            className="kazi-action-card flex flex-col items-start p-4 text-left"
          >
            <Users className="mb-3 h-5 w-5 text-info" />
            <span className="text-sm font-medium text-foreground">Add Customer</span>
            <span className="text-xs text-muted-foreground">Register a new customer</span>
          </Link>
          <Link
            to="/dashboard/reports"
            className="kazi-action-card flex flex-col items-start p-4 text-left"
          >
            <BarChart2 className="mb-3 h-5 w-5 text-warning" />
            <span className="text-sm font-medium text-foreground">View Reports</span>
            <span className="text-xs text-muted-foreground">Sales and financial reports</span>
          </Link>
        </div>
      </div>

      <div className="mt-8">
        <h2 className="kazi-section-title mb-4">Low Stock Alerts</h2>
        <div className="kazi-alert-card p-4">
          <div className="flex items-center gap-2 text-warning">
            <AlertTriangle className="h-5 w-5" />
            <span className="text-sm font-medium text-foreground">Inventory monitoring active</span>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            You will receive notifications when products fall below minimum stock levels.
          </p>
        </div>
      </div>
    </div>
  );
}
