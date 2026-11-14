import { useCallback, useEffect, useState } from "react";
import { AlertCircle, CheckCircle, Package, RotateCcw, Search } from "lucide-react";
import { api, getApiError } from "../lib/api";
import { useAuth } from "../contexts/AuthContext";

interface ReturnLine {
  id: string;
  description: string;
  quantity: number;
  lineTotal: number;
}

interface ReturnableInvoice {
  id: string;
  invoiceNumber: string;
  status: string;
  issueDate: string;
  total: number;
  paidAmount: number;
  currency: string;
  customer: { id: string; name: string } | null;
  items: ReturnLine[];
  payments: { id: string; provider: string; amount: number; status: string }[];
}

interface Warehouse {
  id: string;
  name: string;
  branchId: string | null;
  branch?: { id: string; name: string } | null;
}

interface ReturnResult {
  invoiceNumber: string;
  warehouse: { id: string; name: string };
  restored: { description: string; quantity: number }[];
}

export function ReturnsPage() {
  const { hasPermission } = useAuth();
  const [invoices, setInvoices] = useState<ReturnableInvoice[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<ReturnableInvoice | null>(null);
  const [warehouseId, setWarehouseId] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<ReturnResult | null>(null);

  const canReturn = hasPermission("invoices.void");

  const load = useCallback((term: string) => {
    setLoading(true);
    return api
      .get("/invoices", {
        params: {
          returnable: "true",
          ...(term.trim() ? { search: term.trim() } : {}),
          limit: 50,
        },
      })
      .then(res => {
        setInvoices(res.data.data);
      })
      .catch(err => {
        setError(getApiError(err));
      })
      .finally(() => {
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    void load("");
    api
      .get("/org/warehouses")
      .then(res => {
        const list = (res.data.data || []) as Warehouse[];
        setWarehouses(list);
        if (list.length === 1) setWarehouseId(list[0].id);
      })
      .catch(() => {
        // A missing warehouse list is not fatal: the server falls back to the branch the
        // sale was rung at, which is the right shelf for a single-store shop anyway.
      });
  }, [load]);

  const openSale = (invoice: ReturnableInvoice) => {
    setSelected(invoice);
    setReason("");
    setResult(null);
    setError("");
  };

  const confirmReturn = async () => {
    if (!selected) return;
    setBusy(true);
    setError("");
    try {
      const res = await api.post<{ data: ReturnResult }>(`/pos/sales/${selected.id}/return`, {
        ...(warehouseId ? { warehouseId } : {}),
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      });
      setResult(res.data.data);
      setSelected(null);
      await load(search);
    } catch (err) {
      setError(getApiError(err));
    } finally {
      setBusy(false);
    }
  };

  if (!canReturn) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <div className="kazi-card max-w-md p-8 text-center">
          <AlertCircle className="mx-auto mb-4 h-10 w-10 text-danger" />
          <h1 className="kazi-page-title">Returns need manager access</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Returning a sale puts stock back on the shelf and reverses the money, so it is limited
            to a role holding the invoices.void permission.
          </p>
        </div>
      </div>
    );
  }

  const totalUnits = selected
    ? selected.items.reduce((sum, item) => sum + Number(item.quantity), 0)
    : 0;

  return (
    <div>
      <div className="mb-6">
        <h1 className="kazi-page-title">Returns &amp; refunds</h1>
        <p className="kazi-page-subtitle">
          Find the sale by receipt number or customer. Returning it puts the goods back on the
          shelf, reverses the accounting and marks the sale void.
        </p>
      </div>

      {error && <p className="mb-4 text-sm text-danger">{error}</p>}

      {result && (
        <div className="kazi-card mb-6 border border-success/40 p-4">
          <div className="flex items-start gap-3">
            <CheckCircle className="mt-0.5 h-5 w-5 shrink-0 text-success" />
            <div>
              <p className="text-sm font-medium text-foreground">
                {result.invoiceNumber} returned to {result.warehouse.name}
              </p>
              {result.restored.length > 0 ? (
                <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
                  {result.restored.map(line => (
                    <li key={`${line.description}-${line.quantity}`}>
                      {line.description} — {line.quantity} back on the shelf
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-1 text-xs text-muted-foreground">
                  No stock needed restoring: everything on this sale was a service or an untracked
                  item.
                </p>
              )}
            </div>
          </div>
        </div>
      )}

      <form
        className="mb-5 flex gap-2"
        onSubmit={e => {
          e.preventDefault();
          void load(search);
        }}
      >
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Receipt number or customer name"
            className="kazi-input w-full pl-9"
          />
        </div>
        <button type="submit" className="kazi-button-secondary px-4">
          Search
        </button>
      </form>

      <div className="grid gap-6 lg:grid-cols-5">
        <div className="lg:col-span-3">
          <div className="kazi-table-wrap kazi-card">
            {loading ? (
              <div className="p-6 text-muted-foreground">Loading...</div>
            ) : invoices.length === 0 ? (
              <div className="p-6 text-sm text-muted-foreground">No returnable sales found.</div>
            ) : (
              <table className="min-w-full divide-y divide-border">
                <thead className="bg-surface-muted">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase">
                      Receipt
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase">
                      Customer
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase">
                      Date
                    </th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-muted-foreground uppercase">
                      Total
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {invoices.map(inv => (
                    <tr
                      key={inv.id}
                      onClick={() => openSale(inv)}
                      className={`cursor-pointer hover:bg-surface-muted/50 ${
                        selected?.id === inv.id ? "bg-surface-muted" : ""
                      }`}
                    >
                      <td className="px-4 py-3 text-sm font-medium text-foreground">
                        {inv.invoiceNumber}
                      </td>
                      <td className="px-4 py-3 text-sm text-muted-foreground">
                        {inv.customer?.name || "Walk-in"}
                      </td>
                      <td className="px-4 py-3 text-sm text-muted-foreground">
                        {new Date(inv.issueDate).toLocaleDateString()}
                      </td>
                      <td className="px-4 py-3 text-right text-sm text-muted-foreground">
                        {inv.currency} {inv.total.toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

        <div className="lg:col-span-2">
          <div className="kazi-card p-5">
            {!selected ? (
              <p className="text-sm text-muted-foreground">
                Pick a sale on the left to see what returning it will do.
              </p>
            ) : (
              <>
                <h2 className="kazi-page-title text-base">{selected.invoiceNumber}</h2>
                <p className="kazi-page-subtitle">
                  {selected.customer?.name || "Walk-in"} ·{" "}
                  {new Date(selected.issueDate).toLocaleDateString()}
                </p>

                <div className="mt-4 space-y-1">
                  {selected.items.map(item => (
                    <div key={item.id} className="flex items-center justify-between gap-3 text-sm">
                      <span className="text-foreground">
                        {item.description} × {item.quantity}
                      </span>
                      <span className="text-muted-foreground">
                        {selected.currency} {Number(item.lineTotal).toLocaleString()}
                      </span>
                    </div>
                  ))}
                </div>

                <div className="mt-4 flex items-center justify-between border-t border-border pt-3 text-sm">
                  <span className="text-muted-foreground">{totalUnits} unit(s) to restore</span>
                  <span className="font-medium text-foreground">
                    {selected.currency} {selected.total.toLocaleString()}
                  </span>
                </div>

                {selected.paidAmount > 0 && (
                  <p className="mt-3 rounded-lg bg-warning/10 p-3 text-xs text-muted-foreground">
                    {selected.currency} {Number(selected.paidAmount).toLocaleString()} was taken on
                    this sale. Returning it marks those payments refunded — hand the money back
                    before you confirm.
                  </p>
                )}

                <label className="mt-4 mb-1 block text-xs font-medium text-muted-foreground">
                  Return to
                </label>
                <select
                  value={warehouseId}
                  onChange={e => setWarehouseId(e.target.value)}
                  className="kazi-input mb-3 w-full"
                >
                  <option value="">Branch store (where it was sold)</option>
                  {warehouses.map(warehouse => (
                    <option key={warehouse.id} value={warehouse.id}>
                      {warehouse.name}
                      {warehouse.branch ? ` · ${warehouse.branch.name}` : ""}
                    </option>
                  ))}
                </select>

                <label className="mb-1 block text-xs font-medium text-muted-foreground">
                  Reason (optional)
                </label>
                <input
                  value={reason}
                  onChange={e => setReason(e.target.value)}
                  placeholder="Customer changed their mind"
                  className="kazi-input mb-4 w-full"
                />

                <button
                  type="button"
                  onClick={() => void confirmReturn()}
                  disabled={busy}
                  className="kazi-button-primary w-full px-4 disabled:opacity-60"
                >
                  <RotateCcw className="h-4 w-4" />
                  {busy ? "Returning..." : "Confirm return"}
                </button>
                <p className="mt-2 flex items-start gap-1.5 text-xs text-muted-foreground">
                  <Package className="mt-0.5 h-3 w-3 shrink-0" />
                  This cannot be undone. The sale is marked void and the goods go back on the shelf
                  you chose.
                </p>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
