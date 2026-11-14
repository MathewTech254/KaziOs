import { useState } from "react";
import { Search } from "lucide-react";
import { api, getApiError } from "../lib/api";
import { formatMoney } from "../lib/currency";

interface CountLine {
  id: string;
  productId: string;
  productName: string;
  expectedQty: number;
  countedQty: number;
  diffQty: number;
  diffAmount: number;
  notes: string | null;
}

interface StockCount {
  id: string;
  status: string;
  openedBy: { id: string; name: string };
  confirmedBy: { id: string; name: string } | null;
  warehouse: { id: string; name: string; code: string } | null;
  notes: string | null;
  lines: CountLine[];
}

export function StocktakePage() {
  const [counts, setCounts] = useState<StockCount[]>([]);
  const [selectedCount, setSelectedCount] = useState<StockCount | null>(null);
  const [newLine, setNewLine] = useState<{ productId: string; countedQty: string; notes: string }>({
    productId: "",
    countedQty: "",
    notes: "",
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const loadCounts = async () => {
    try {
      const res = await api.get("/inventory/stock-counts", {
        params: { limit: 50 },
      });
      setCounts(res.data.data || []);
    } catch {
      // Non-fatal
    }
  };

  const openCount = async () => {
    setError("");
    setLoading(true);
    try {
      const res = await api.post("/inventory/stock-counts", {
        warehouseId: undefined,
        notes: "",
      });
      const newCount: StockCount = res.data.data;
      setCounts([newCount, ...counts]);
      setSelectedCount(newCount);
    } catch (err) {
      setError(getApiError(err));
    } finally {
      setLoading(false);
    }
  };

  const loadCountLines = async (id: string) => {
    try {
      const res = await api.get(`/inventory/stock-counts/${id}`);
      setSelectedCount(res.data.data);
    } catch (err) {
      setError(getApiError(err));
    }
  };

  const addLine = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedCount) return;
    setError("");
    try {
      await api.post(`/inventory/stock-counts/${selectedCount.id}/lines`, {
        productId: newLine.productId,
        countedQty: parseFloat(newLine.countedQty),
        notes: newLine.notes || undefined,
      });
      await loadCountLines(selectedCount.id);
      setNewLine({ productId: "", countedQty: "", notes: "" });
    } catch (err) {
      setError(getApiError(err));
    }
  };

  const confirmCount = async () => {
    if (!selectedCount) return;
    setError("");
    setLoading(true);
    try {
      await api.post(`/inventory/stock-counts/${selectedCount.id}/confirm`, {
        notes: "",
      });
      setSuccess("Count confirmed. Stock adjustments have been posted.");
      await loadCountLines(selectedCount.id);
      await loadCounts();
    } catch (err) {
      setError(getApiError(err));
    } finally {
      setLoading(false);
    }
  };

  const abandonCount = async () => {
    if (!selectedCount) return;
    if (!window.confirm("Abandon this count? All counted lines will be lost.")) return;
    setError("");
    setLoading(true);
    try {
      await api.delete(`/inventory/stock-counts/${selectedCount.id}`);
      setSuccess("Count abandoned");
      setSelectedCount(null);
      await loadCounts();
    } catch (err) {
      setError(getApiError(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="kazi-page-title">Stocktake</h1>
          <p className="kazi-page-subtitle">
            Count stock, compare against expected, and post adjustments to the ledger.
          </p>
        </div>
        <button
          type="button"
          onClick={openCount}
          disabled={loading}
          className="kazi-button-primary px-4 text-sm"
        >
          {loading ? "Opening..." : "Start new count"}
        </button>
      </div>

      {error && (
        <div
          role="alert"
          className="mb-4 rounded-lg border border-danger/30 bg-danger/10 p-4 text-sm text-danger"
        >
          {error}
        </div>
      )}
      {success && (
        <div
          role="status"
          className="mb-4 rounded-lg border border-success/30 bg-success/10 p-4 text-sm text-success"
        >
          {success}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Existing counts */}
        <div className="lg:col-span-1">
          <div className="kazi-card p-4">
            <h2 className="mb-3 text-lg font-semibold text-foreground">Recent counts</h2>
            <div className="space-y-2">
              {counts.map(c => (
                <button
                  key={c.id}
                  onClick={() => {
                    setSelectedCount(c);
                    void loadCountLines(c.id);
                  }}
                  className={`w-full text-left px-3 py-2 rounded-lg border ${
                    selectedCount?.id === c.id
                      ? "border-accent bg-accent/50"
                      : "border-border hover:bg-surface-muted/50"
                  }`}
                >
                  <p className="text-sm font-medium text-foreground">Count {c.id.slice(0, 8)}</p>
                  <p className="text-xs text-muted-foreground">
                    {c.status} &middot; {c.lines.length} lines
                  </p>
                </button>
              ))}
              {counts.length === 0 && (
                <p className="text-xs text-muted-foreground text-center">
                  No counts yet. Start one above.
                </p>
              )}
            </div>
          </div>
        </div>

        {/* Count detail */}
        {selectedCount && (
          <div className="lg:col-span-2">
            <div className="kazi-card p-6">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h2 className="text-lg font-semibold text-foreground">
                    Count {selectedCount.id.slice(0, 8)}
                  </h2>
                  <p className="text-xs text-muted-foreground">
                    Status: {selectedCount.status} &middot; Opened by {selectedCount.openedBy.name}{" "}
                    &middot;
                    {selectedCount.warehouse ? `Warehouse: ${selectedCount.warehouse.name}` : ""}
                  </p>
                </div>
                <div className="flex gap-2">
                  {selectedCount.status === "OPEN" && (
                    <>
                      <button
                        type="button"
                        onClick={confirmCount}
                        disabled={loading}
                        className="kazi-button-primary px-4 py-2 text-sm"
                      >
                        Confirm count
                      </button>
                      <button
                        type="button"
                        onClick={abandonCount}
                        disabled={loading}
                        className="kazi-button-outline px-4 py-2 text-sm"
                      >
                        Abandon
                      </button>
                    </>
                  )}
                  {selectedCount.status === "CONFIRMED" && (
                    <span className="text-xs font-medium text-success">
                      Confirmed by {selectedCount.confirmedBy?.name}
                    </span>
                  )}
                </div>
              </div>

              {selectedCount.status === "OPEN" && (
                <div className="mb-6">
                  <h3 className="mb-2 text-sm font-semibold text-muted-foreground uppercase">
                    Add counted line
                  </h3>
                  <form onSubmit={addLine} className="grid grid-cols-1 sm:grid-cols-4 gap-3">
                    <div className="col-span-1 sm:col-span-2">
                      <input
                        type="text"
                        value={newLine.productId}
                        onChange={e => setNewLine({ ...newLine, productId: e.target.value })}
                        placeholder="Search product"
                        className="kazi-input pl-10"
                      />
                      <Search className="absolute left-3 top-1/2 h-4 w-4 text-muted-foreground -translate-y-1/2" />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs font-medium text-muted-foreground">
                        Counted qty
                      </label>
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        value={newLine.countedQty}
                        onChange={e => setNewLine({ ...newLine, countedQty: e.target.value })}
                        className="kazi-input"
                        required
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs font-medium text-muted-foreground">
                        Notes
                      </label>
                      <input
                        type="text"
                        value={newLine.notes}
                        onChange={e => setNewLine({ ...newLine, notes: e.target.value })}
                        className="kazi-input"
                        placeholder="Optional"
                      />
                    </div>
                    <button type="submit" className="kazi-button-primary px-4 py-2">
                      Add line
                    </button>
                  </form>
                  {error && <p className="mt-2 text-xs text-danger">{error}</p>}
                </div>
              )}

              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-border">
                  <thead className="bg-surface-muted">
                    <tr>
                      <th className="px-4 py-2 text-left text-xs font-medium text-muted-foreground uppercase">
                        Product
                      </th>
                      <th className="px-4 py-2 text-right text-xs font-medium text-muted-foreground uppercase">
                        Expected
                      </th>
                      <th className="px-4 py-2 text-right text-xs font-medium text-muted-foreground uppercase">
                        Counted
                      </th>
                      <th className="px-4 py-2 text-right text-xs font-medium text-muted-foreground uppercase">
                        Diff
                      </th>
                      <th className="px-4 py-2 text-right text-xs font-medium text-muted-foreground uppercase">
                        Value (KES)
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {selectedCount.lines.map(line => (
                      <tr key={line.id} className="hover:bg-surface-muted/50">
                        <td className="px-4 py-3 text-sm font-medium text-foreground">
                          {line.productName}
                        </td>
                        <td className="px-4 py-3 text-right text-sm">{line.expectedQty}</td>
                        <td className="px-4 py-3 text-right text-sm">{line.countedQty}</td>
                        <td
                          className={`px-4 py-3 text-right text-sm ${
                            line.diffQty > 0
                              ? "text-success"
                              : line.diffQty < 0
                                ? "text-danger"
                                : "text-muted-foreground"
                          }`}
                        >
                          {line.diffQty > 0 ? "+" : ""}
                          {line.diffQty}
                        </td>
                        <td className="px-4 py-3 text-right text-sm">
                          {formatMoney(line.diffAmount / 100, "KES")}
                        </td>
                      </tr>
                    ))}
                    {selectedCount.lines.length === 0 && (
                      <tr>
                        <td
                          className="px-4 py-4 text-center text-sm text-muted-foreground"
                          colSpan={5}
                        >
                          No counted lines yet. Add products above.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              {selectedCount.status === "CONFIRMED" && (
                <div className="mt-4 p-4 rounded-lg border border-success/30 bg-success/10">
                  <p className="text-sm text-success">
                    Count confirmed. ADJUSTMENT movements have been posted to the stock ledger for
                    each line's difference.
                  </p>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
