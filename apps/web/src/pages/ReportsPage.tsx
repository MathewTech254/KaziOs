import { useState, useEffect } from "react";
import { api } from "../lib/api";

interface ReportData {
  totalInvoices: number;
  totalRevenue: number;
  totalTax: number;
  totalDiscounts: number;
  totalPayments: number;
}

export function ReportsPage() {
  const [report, setReport] = useState<ReportData | null>(null);
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");

  const load = async () => {
    const params = new URLSearchParams();
    if (startDate) params.set("startDate", startDate);
    if (endDate) params.set("endDate", endDate);
    const res = await api.get(`/reports/sales-summary?${params}`);
    setReport(res.data.data);
  };

  useEffect(() => { load(); }, [startDate, endDate]);

  return (
    <div>
      <div className="mb-6">
        <h1 className="kazi-page-title">Reports</h1>
        <p className="kazi-page-subtitle">Sales and financial analytics</p>
      </div>

      <div className="kazi-card mb-6 p-4">
        <div className="flex flex-wrap items-end gap-4">
          <div>
            <label className="mb-1 block text-sm text-muted-foreground">Start Date</label>
            <input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="kazi-input"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm text-muted-foreground">End Date</label>
            <input
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
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
            <p className="kazi-stat-value mt-1 text-success">KES {report.totalRevenue.toLocaleString()}</p>
          </div>
          <div className="kazi-stat-card">
            <p className="kazi-stat-label">Tax Collected</p>
            <p className="kazi-stat-value mt-1 text-info">KES {report.totalTax.toLocaleString()}</p>
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