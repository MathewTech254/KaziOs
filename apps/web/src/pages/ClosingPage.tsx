import { useState, useEffect } from "react";
import { api } from "../lib/api";
import { formatMoney } from "../lib/currency";

interface ClosingReportData {
  date: string;
  status: string;
  totals: {
    totalSales: number;
    cashSales: number;
    mpesaSales: number;
    creditSales: number;
    refundsVoids: number;
    totalExpenses: number;
    net: number;
  };
  dayClosing: any;
  perAttendant: {
    attendantId: string | null;
    attendantName: string;
    totalSales: number;
    transactionCount: number;
  }[];
  itemsSold: {
    productId: string;
    productName: string;
    sku: string | null;
    quantity: number;
    lineTotal: number;
  }[];
  expenses: {
    id: string;
    vendorName: string;
    amount: number;
    notes: string | null;
    createdAt: string;
  }[];
  lowStock: number;
  stockShortages: number;
}

export function ClosingPage() {
  const [date, setDate] = useState("");
  const [report, setReport] = useState<ClosingReportData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const load = async () => {
    if (!date) return;
    setLoading(true);
    setError("");
    try {
      const res = await api.get(`/day-closings/report?date=${encodeURIComponent(date)}`);
      setReport(res.data.data);
    } catch (err: any) {
      setError(err.response?.data?.error || err.message || "Failed to load closing report");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // Default to today's date.
    const today = new Date().toISOString().split("T")[0];
    setDate(today);
    void load();
  }, []);

  const handleOpenClose = async (action: "open" | "close") => {
    if (!date) return;
    setLoading(true);
    setError("");
    try {
      if (action === "open") {
        await api.post("/day-closings/open", { date });
      } else {
        // For close, we need counted amounts. Prompt via the close form below.
        setError("Use the Close Day form below to record counted cash and M-PESA.");
        return;
      }
      void load();
    } catch (err: any) {
      setError(err.response?.data?.error || err.message || "Failed to open day");
    } finally {
      setLoading(false);
    }
  };

  const handleClose = async (countedCash: number, countedMpesa: number, notes: string) => {
    if (!date) return;
    setLoading(true);
    setError("");
    try {
      await api.post("/day-closings/close", {
        date,
        countedCash,
        countedMpesa,
        notes: notes || null,
      });
      void load();
    } catch (err: any) {
      setError(err.response?.data?.error || err.message || "Failed to close day");
    } finally {
      setLoading(false);
    }
  };

  const handleReopen = async () => {
    if (!date) return;
    setLoading(true);
    setError("");
    try {
      await api.post("/day-closings/reopen", { date });
      void load();
    } catch (err: any) {
      setError(err.response?.data?.error || err.message || "Failed to reopen day");
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center text-muted-foreground">
        Loading closing report...
      </div>
    );
  }

  const currency = "KES";
  const r = report;
  const day = r?.dayClosing;
  const isOpen = day?.status === "OPEN";
  const isClosed = day?.status === "CLOSED";
  const isNotOpened = day?.status === "NOT_OPENED" || !day;

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="kazi-page-title">Daily Closing</h1>
          <p className="kazi-page-subtitle">
            Nightly closing report for the trading day
          </p>
        </div>
        <div className="flex items-end gap-2">
          <input
            type="date"
            value={date}
            onChange={e => setDate(e.target.value)}
            className="kazi-input"
          />
          <button
            type="button"
            onClick={load}
            disabled={!date || loading}
            className="kazi-button-primary px-4"
          >
            Load
          </button>
        </div>
      </div>

      {error && (
        <div
          role="alert"
          className="mb-5 flex items-start gap-3 rounded-lg border border-danger/30 bg-danger/10 p-4 text-sm text-danger"
        >
          <span>{error}</span>
        </div>
      )}

      {!r && (
        <div className="kazi-card mb-6 p-4 text-center text-muted-foreground">
          Select a date to load the closing report.
        </div>
      )}

      {r && (
        <div className="space-y-6">
          {/* Day status and open/close actions */}
          <div className="kazi-card p-4">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="text-lg font-semibold text-foreground">
                  {date} · {r.status}
                </h2>
                <p className="text-xs text-muted-foreground">
                  {isNotOpened
                    ? "The day has not been opened yet."
                    : isOpen
                    ? "The day is open for trading."
                    : "The day is closed. Attendants cannot start new sales."}
                </p>
              </div>
              <div className="flex gap-2">
                {isNotOpened && (
                  <button
                    type="button"
                    onClick={() => handleOpenClose("open")}
                    className="kazi-button-primary px-4 py-2 text-sm"
                  >
                    Open Day
                  </button>
                )}
                {isOpen && (
                  <>
                    <button
                      type="button"
                      onClick={() => (document.getElementById("close-form")?.scrollIntoView())}
                      className="kazi-button-outline px-4 py-2 text-sm"
                    >
                      Close Day
                    </button>
                  </>
                )}
                {isClosed && (
                  <button
                    type="button"
                    onClick={handleReopen}
                    className="kazi-button-outline px-4 py-2 text-sm"
                  >
                    Reopen Day
                  </button>
                )}
              </div>
            </div>

            {/* Close day form */}
            {isOpen && (
              <div id="close-form" className="mt-6 pt-6 border-t border-border">
                <h3 className="mb-3 text-sm font-semibold text-foreground uppercase tracking-wider">
                  Close Day
                </h3>
                <p className="mb-3 text-sm text-muted-foreground">
                  Enter the physical count from the till and M-PESA. The difference is
                  computed automatically.
                </p>
                <form
                  onSubmit={e => {
                    e.preventDefault();
                    const form = e.target as HTMLFormElement;
                    const cc = Number(
                      (form.elements.namedItem("countedCash") as HTMLInputElement).value
                    );
                    const cm = Number(
                      (form.elements.namedItem("countedMpesa") as HTMLInputElement).value
                    );
                    const notes = (form.elements.namedItem("notes") as HTMLInputElement).value;
                    void handleClose(cc, cm, notes);
                  }}
                  className="grid grid-cols-1 gap-3 sm:grid-cols-3"
                >
                  <div className="col-span-1 sm:col-span-1">
                    <label className="mb-1 block text-xs font-medium text-muted-foreground">
                      Expected Cash
                    </label>
                    <p className="text-sm font-medium text-foreground">
                      {formatMoney(day?.expectedCash ?? 0, currency)}
                    </p>
                  </div>
                  <div className="col-span-1 sm:col-span-1">
                    <label className="mb-1 block text-xs font-medium text-muted-foreground">
                      Counted Cash
                    </label>
                    <input
                      name="countedCash"
                      type="number"
                      min="0"
                      step="0.01"
                      defaultValue={String(day?.countedCash || 0)}
                      className="kazi-input"
                      required
                    />
                  </div>
                  <div className="col-span-1 sm:col-span-1">
                    <label className="mb-1 block text-xs font-medium text-muted-foreground">
                      Counted M-PESA
                    </label>
                    <input
                      name="countedMpesa"
                      type="number"
                      min="0"
                      step="0.01"
                      defaultValue={String(day?.countedMpesa || 0)}
                      className="kazi-input"
                      required
                    />
                  </div>
                  <div className="col-span-3">
                    <label className="mb-1 block text-xs font-medium text-muted-foreground">
                      Notes
                    </label>
                    <input
                      name="notes"
                      type="text"
                      defaultValue={day?.notes || ""}
                      placeholder="Optional notes"
                      className="kazi-input"
                    />
                  </div>
                  <div className="col-span-3">
                    <button
                      type="submit"
                      className="kazi-button-primary px-4 py-2"
                    >
                      Close Day
                    </button>
                  </div>
                </form>
              </div>
            )}
          </div>

          {/* Totals */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="kazi-stat-card">
              <p className="kazi-stat-label">Total Sales</p>
              <p className="kazi-stat-value mt-1 text-success">
                {formatMoney(r.totals.totalSales, currency)}
              </p>
            </div>
            <div className="kazi-stat-card">
              <p className="kazi-stat-label">Cash</p>
              <p className="kazi-stat-value mt-1">{formatMoney(r.totals.cashSales, currency)}</p>
            </div>
            <div className="kazi-stat-card">
              <p className="kazi-stat-label">M-PESA</p>
              <p className="kazi-stat-value mt-1">
                {formatMoney(r.totals.mpesaSales, currency)}
              </p>
            </div>
            <div className="kazi-stat-card">
              <p className="kazi-stat-label">Credit</p>
              <p className="kazi-stat-value mt-1 text-warning">
                {formatMoney(r.totals.creditSales, currency)}
              </p>
            </div>
            <div className="kazi-stat-card">
              <p className="kazi-stat-label">Refunds / Voids</p>
              <p className="kazi-stat-value mt-1 text-danger">
                {formatMoney(r.totals.refundsVoids, currency)}
              </p>
            </div>
            <div className="kazi-stat-card">
              <p className="kazi-stat-label">Expenses</p>
              <p className="kazi-stat-value mt-1 text-danger">
                {formatMoney(r.totals.totalExpenses, currency)}
              </p>
            </div>
            <div className="kazi-stat-card">
              <p className="kazi-stat-label">Net</p>
              <p className="kazi-stat-value mt-1">
                {formatMoney(r.totals.net, currency)}
              </p>
            </div>
          </div>

          {/* Per-attendant */}
          <div className="kazi-card p-4">
            <h2 className="mb-3 text-lg font-semibold text-foreground">
              Per Attendant
            </h2>
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-border">
                <thead className="bg-surface-muted">
                  <tr>
                    <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase">
                      Attendant
                    </th>
                    <th className="px-6 py-3 text-right text-xs font-medium text-muted-foreground uppercase">
                      Sales
                    </th>
                    <th className="px-6 py-3 text-right text-xs font-medium text-muted-foreground uppercase">
                      Transactions
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {r.perAttendant.map(a => (
                    <tr key={a.attendantId} className="hover:bg-surface-muted/50">
                      <td className="px-6 py-4 text-sm font-medium text-foreground">
                        {a.attendantName}
                      </td>
                      <td className="px-6 py-4 text-right text-sm">
                        {formatMoney(a.totalSales, currency)}
                      </td>
                      <td className="px-6 py-4 text-right text-sm text-muted-foreground">
                        {a.transactionCount}
                      </td>
                    </tr>
                  ))}
                  {!r.perAttendant.length && (
                    <tr>
                      <td className="px-6 py-4 text-center text-sm text-muted-foreground" colSpan={3}>
                        No sales recorded
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Items sold */}
          <div className="kazi-card p-4">
            <h2 className="mb-3 text-lg font-semibold text-foreground">Items Sold</h2>
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-border">
                <thead className="bg-surface-muted">
                  <tr>
                    <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase">
                      Product
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase">
                      SKU
                    </th>
                    <th className="px-6 py-3 text-right text-xs font-medium text-muted-foreground uppercase">
                      Qty
                    </th>
                    <th className="px-6 py-3 text-right text-xs font-medium text-muted-foreground uppercase">
                      Total
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {r.itemsSold.map(item => (
                    <tr key={item.productId} className="hover:bg-surface-muted/50">
                      <td className="px-6 py-4 text-sm font-medium text-foreground">
                        {item.productName}
                      </td>
                      <td className="px-6 py-4 text-sm text-muted-foreground">
                        {item.sku || "-"}
                      </td>
                      <td className="px-6 py-4 text-right text-sm">
                        {item.quantity}
                      </td>
                      <td className="px-6 py-4 text-right text-sm">
                        {formatMoney(item.lineTotal, currency)}
                      </td>
                    </tr>
                  ))}
                  {!r.itemsSold.length && (
                    <tr>
                      <td className="px-6 py-4 text-center text-sm text-muted-foreground" colSpan={4}>
                        No items sold
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Expenses */}
          <div className="kazi-card p-4">
            <h2 className="mb-3 text-lg font-semibold text-foreground">Expenses</h2>
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-border">
                <thead className="bg-surface-muted">
                  <tr>
                    <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase">
                      Vendor
                    </th>
                    <th className="px-6 py-3 text-right text-xs font-medium text-muted-foreground uppercase">
                      Amount
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase">
                      Notes
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {r.expenses.map(e => (
                    <tr key={e.id} className="hover:bg-surface-muted/50">
                      <td className="px-6 py-4 text-sm font-medium text-foreground">
                        {e.vendorName}
                      </td>
                      <td className="px-6 py-4 text-right text-sm">
                        {formatMoney(e.amount, currency)}
                      </td>
                      <td className="px-6 py-4 text-sm text-muted-foreground">
                        {e.notes || "-"}
                      </td>
                    </tr>
                  ))}
                  {!r.expenses.length && (
                    <tr>
                      <td className="px-6 py-4 text-center text-sm text-muted-foreground" colSpan={3}>
                        No expenses recorded
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Stock */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="kazi-card p-4">
              <h2 className="mb-3 text-lg font-semibold text-foreground">Low Stock</h2>
              <p className="kazi-stat-value text-xl text-warning">
                {r.lowStock} items
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Items at or below reorder level
              </p>
            </div>
            <div className="kazi-card p-4">
              <h2 className="mb-3 text-lg font-semibold text-foreground">Stock Shortages</h2>
              <p className="kazi-stat-value text-xl text-danger">
                {r.stockShortages}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Adjustments recorded as damage, breakage, expired, or theft
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
