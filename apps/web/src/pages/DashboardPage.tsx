import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  AlertTriangle,
  ArrowRight,
  BarChart3,
  FileText,
  Package,
  Receipt,
  TrendingUp,
  Users,
  Wallet,
} from "lucide-react";
import { useAuth } from "../contexts/AuthContext";
import { api, getApiError } from "../lib/api";
import { formatMoney } from "../lib/currency";
import { Notice, EmptyRow } from "../components/Feedback";

/**
 * The shape the API returns. Every figure is counted in the database; nothing here is
 * derived from a static array or a hardcoded total.
 */
interface DashboardData {
  currency: string;
  today: { revenue: number; transactions: number };
  month: {
    revenue: number;
    expenses: number;
    profit: number;
    transactions: number;
    averageOrderValue: number;
  };
  receivables: { outstanding: number; overdueInvoices: number };
  stock: { lowStock: number; outOfStock: number };
  recentInvoices: {
    id: string;
    invoiceNumber: string;
    total: number;
    status: string;
    paidAmount: number;
    createdAt: string;
    customer?: { name: string } | null;
    branch?: { name: string } | null;
  }[];
  topProducts: {
    productId: string | null;
    name: string;
    sku?: string | null;
    quantity: number;
    revenue: number;
  }[];
}

export function DashboardPage() {
  const { user } = useAuth();
  const [stats, setStats] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get("/reports/dashboard");
      setStats(res.data.data);
    } catch (err) {
      // Shown rather than swallowed. A dashboard that quietly renders an empty grid after
      // a failed request is indistinguishable from a business that traded nothing.
      setError(getApiError(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Falls back to KES while loading: the browser cannot know the organization's currency
  // until the figures arrive, and rendering nothing beats rendering the wrong symbol.
  const money = (value: number) => formatMoney(value, stats?.currency ?? "KES");

  const cards = stats
    ? [
        {
          label: "Today's Takings",
          value: money(stats.today.revenue),
          hint: `${stats.today.transactions} sale${stats.today.transactions === 1 ? "" : "s"}`,
          icon: TrendingUp,
          color: "text-success",
        },
        {
          label: "Revenue This Month",
          value: money(stats.month.revenue),
          hint: `${stats.month.transactions} sale${stats.month.transactions === 1 ? "" : "s"}`,
          icon: FileText,
          color: "text-info",
        },
        {
          label: "Expenses This Month",
          value: money(stats.month.expenses),
          hint: "Recorded business spend",
          icon: Wallet,
          color: "text-warning",
        },
        {
          label: "Profit This Month",
          value: money(stats.month.profit),
          hint: "Revenue less expenses",
          icon: BarChart3,
          // A loss is shown in red. Profit is the one figure a shopkeeper cannot
          // misread at a glance, so it is the last to leave ambiguous.
          color: stats.month.profit < 0 ? "text-danger" : "text-accent",
        },
        {
          label: "Awaiting Payment",
          value: money(stats.receivables.outstanding),
          hint: `${stats.receivables.overdueInvoices} overdue`,
          icon: Receipt,
          color: stats.receivables.overdueInvoices > 0 ? "text-danger" : "text-muted-foreground",
        },
        {
          label: "Low Stock",
          value: stats.stock.lowStock + stats.stock.outOfStock,
          hint: `${stats.stock.outOfStock} out of stock`,
          icon: Package,
          color: stats.stock.outOfStock > 0 ? "text-danger" : "text-muted-foreground",
        },
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

      {error ? <Notice tone="error" title="Could not load your dashboard" message={error} /> : null}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {cards.map(stat => {
          const Icon = stat.icon;
          return (
            <div key={stat.label} className="kazi-stat-card">
              <div className="flex items-center justify-between">
                <p className="kazi-stat-label">{stat.label}</p>
                <Icon className={`h-5 w-5 ${stat.color}`} />
              </div>
              <p className={`kazi-stat-value mt-1 ${stat.color}`}>{stat.value}</p>
              {stat.hint ? <p className="text-xs text-muted-foreground">{stat.hint}</p> : null}
            </div>
          );
        })}
      </div>

      {loading ? (
        <p className="mt-4 text-sm text-muted-foreground">Loading your figures...</p>
      ) : null}

      <div className="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div>
          <div className="mb-4 flex items-center justify-between">
            <h2 className="kazi-section-title">Recent Sales</h2>
            <Link
              to="/dashboard/invoices"
              className="flex items-center gap-1 text-sm text-accent hover:underline"
            >
              All invoices <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>
          <div className="kazi-card overflow-hidden">
            {stats?.recentInvoices.length ? (
              <table className="kazi-table">
                <thead>
                  <tr>
                    <th>Invoice</th>
                    <th>Customer</th>
                    <th>Status</th>
                    <th className="text-right">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.recentInvoices.map(invoice => (
                    <tr key={invoice.id}>
                      <td className="font-mono text-xs">{invoice.invoiceNumber}</td>
                      {/* A walk-in sale has no customer row, so it is labelled as such
                          rather than left blank. */}
                      <td>{invoice.customer?.name || "Walk-in"}</td>
                      <td className="text-xs text-muted-foreground">{invoice.status}</td>
                      <td className="text-right font-medium">{money(invoice.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <EmptyRow
                message={loading ? "Loading sales..." : "No sales recorded yet."}
                colSpan={4}
              />
            )}
          </div>
        </div>

        <div>
          <div className="mb-4 flex items-center justify-between">
            <h2 className="kazi-section-title">Top Products This Month</h2>
            <Link
              to="/dashboard/reports"
              className="flex items-center gap-1 text-sm text-accent hover:underline"
            >
              Reports <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>
          <div className="kazi-card overflow-hidden">
            {stats?.topProducts.length ? (
              <table className="kazi-table">
                <thead>
                  <tr>
                    <th>Product</th>
                    <th className="text-right">Sold</th>
                    <th className="text-right">Revenue</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.topProducts.map(product => (
                    <tr key={product.productId ?? product.name}>
                      <td>
                        {product.name}
                        {product.sku ? (
                          <span className="ml-2 text-xs text-muted-foreground">{product.sku}</span>
                        ) : null}
                      </td>
                      <td className="text-right">{product.quantity}</td>
                      <td className="text-right font-medium">{money(product.revenue)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <EmptyRow
                message={loading ? "Loading products..." : "No products sold this month yet."}
                colSpan={3}
              />
            )}
          </div>
        </div>
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
            <BarChart3 className="mb-3 h-5 w-5 text-warning" />
            <span className="text-sm font-medium text-foreground">View Reports</span>
            <span className="text-xs text-muted-foreground">Sales and financial reports</span>
          </Link>
        </div>
      </div>

      {/* Replaces a static "inventory monitoring active" banner that was true of no
          business in particular. The counts above are the same thing, measured. */}
      {stats && stats.stock.lowStock + stats.stock.outOfStock > 0 ? (
        <div className="mt-8">
          <h2 className="kazi-section-title mb-4">Stock Attention Needed</h2>
          <div className="kazi-alert-card p-4">
            <div className="flex items-center gap-2 text-warning">
              <AlertTriangle className="h-5 w-5" />
              <span className="text-sm font-medium text-foreground">
                {stats.stock.outOfStock > 0
                  ? `${stats.stock.outOfStock} product${stats.stock.outOfStock === 1 ? " is" : "s are"} out of stock`
                  : `${stats.stock.lowStock} product${stats.stock.lowStock === 1 ? " is" : "s are"} below minimum level`}
              </span>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Review these lines before the next delivery, or they will stop you selling.
            </p>
          </div>
        </div>
      ) : null}
    </div>
  );
}
