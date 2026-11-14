import { useState, useEffect, useCallback } from "react";
import { api, getApiError } from "../lib/api";

interface ReportData {
  totalInvoices: number;
  totalRevenue: number;
  totalTax: number;
  totalDiscounts: number;
  totalPayments: number;
}

import { useCurrency, formatMoney } from "../lib/currency";
import { useAuth } from "../contexts/AuthContext";
import { AccessDenied, Notice } from "../components/Feedback";

export function ReportsPage() {
  const { hasPermission } = useAuth();
  const canView = hasPermission("reports.view");
  const currency = useCurrency();
  const [report, setReport] = useState<ReportData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");

  const load = useCallback(async () => {
    // Sales figures are reports.view. The page is not in the sidebar for a role without
    // it, but a typed URL still reached it and threw an unhandled 403.
    if (!canView) return;
    const params = new URLSearchParams();
    if (startDate) params.set("startDate", startDate);
    if (endDate) params.set("endDate", endDate);
    try {
      const res = await api.get(`/reports/sales-summary?${params.toString()}`);
      setReport(res.data.data);
      setError(null);
    } catch (err) {
      setError(getApiError(err));
    }
  }, [canView, startDate, endDate]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!canView) {
    return (
      <AccessDenied
        title="Reports access required"
        permission="reports.view"
        hint="Sales and financial figures are limited to roles with report access."
      />
    );
  }

  return (
    <div>
      <div className="mb-6">
        <h1 className="kazi-page-title">Reports</h1>
        <p className="kazi-page-subtitle">Sales and financial analytics</p>
      </div>

      {error && <Notice tone="error" title="Could not load the report" message={error} />}

      <div className="kazi-card mb-6 p-4">
        <div className="flex flex-wrap items-end gap-4">
          <div>
            <label className="mb-1 block text-sm text-muted-foreground">Start Date</label>
            <input
              type="date"
              value={startDate}
              onChange={e => setStartDate(e.target.value)}
              className="kazi-input"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm text-muted-foreground">End Date</label>
            <input
              type="date"
              value={endDate}
              onChange={e => setEndDate(e.target.value)}
              className="kazi-input"
            />
          </div>
        </div>
      </div>

      {report && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <div className="kazi-stat-card">
            <p className="kazi-stat-label">Total Invoices</p>
            <p className="kazi-stat-value mt-1">{report.totalInvoices}</p>
          </div>
          <div className="kazi-stat-card">
            <p className="kazi-stat-label">Revenue</p>
            <p className="kazi-stat-value mt-1 text-success">
              {formatMoney(report.totalRevenue, currency)}
            </p>
          </div>
          <div className="kazi-stat-card">
            <p className="kazi-stat-label">Tax Collected</p>
            <p className="kazi-stat-value mt-1 text-info">
              {formatMoney(report.totalTax, currency)}
            </p>
          </div>
          <div className="kazi-stat-card">
            <p className="kazi-stat-label">Payments</p>
            <p className="kazi-stat-value mt-1">{report.totalPayments}</p>
          </div>
        </div>
      )}
    </div>
  );
}
