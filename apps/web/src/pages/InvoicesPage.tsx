import { useState, useEffect } from "react";
import { api } from "../lib/api";

interface Invoice {
  id: string;
  invoiceNumber: string;
  status: string;
  issueDate: string;
  dueDate: string;
  total: number;
  currency: string;
  customer: { name: string };
}

export function InvoicesPage() {
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get("/invoices").then(res => {
      setInvoices(res.data.data);
      setLoading(false);
    });
  }, []);

  if (loading) return <div className="p-6 text-muted-foreground">Loading...</div>;

  const statusColor = (s: string) => {
    switch (s) {
      case "PAID":
        return "bg-success/15 text-success";
      case "DRAFT":
        return "bg-surface-muted text-muted-foreground";
      case "SENT":
        return "bg-info/15 text-info";
      case "PARTIALLY_PAID":
        return "bg-warning/15 text-warning";
      case "OVERDUE":
        return "bg-danger/15 text-danger";
      case "VOID":
        return "bg-surface-muted text-muted-foreground";
      default:
        return "bg-surface-muted text-muted-foreground";
    }
  };

  return (
    <div>
      <div className="mb-6">
        <h1 className="kazi-page-title">Invoices</h1>
        <p className="kazi-page-subtitle">Create and manage sales invoices</p>
      </div>

      <div className="kazi-table-wrap kazi-card">
        <table className="min-w-full divide-y divide-border">
          <thead className="bg-surface-muted">
            <tr>
              <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase">
                Invoice #
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase">
                Customer
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase">
                Date
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase">
                Due
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase">
                Total
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase">
                Status
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {invoices.map(inv => (
              <tr key={inv.id} className="hover:bg-surface-muted/50">
                <td className="px-6 py-4 text-sm font-medium text-foreground">
                  {inv.invoiceNumber}
                </td>
                <td className="px-6 py-4 text-sm text-muted-foreground">{inv.customer?.name}</td>
                <td className="px-6 py-4 text-sm text-muted-foreground">
                  {new Date(inv.issueDate).toLocaleDateString()}
                </td>
                <td className="px-6 py-4 text-sm text-muted-foreground">
                  {new Date(inv.dueDate).toLocaleDateString()}
                </td>
                <td className="px-6 py-4 text-sm text-muted-foreground">
                  {inv.currency} {inv.total.toLocaleString()}
                </td>
                <td className="px-6 py-4 text-sm">
                  <span
                    className={`rounded-full px-2 py-1 text-xs font-medium ${statusColor(inv.status)}`}
                  >
                    {inv.status}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
