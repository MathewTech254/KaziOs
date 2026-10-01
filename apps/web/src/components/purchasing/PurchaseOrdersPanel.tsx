import { useCallback, useEffect, useMemo, useState } from "react";
import { Ban, Eye, FileText, Plus, Search, Send, Trash2, X } from "lucide-react";
import { api, getApiError } from "../../lib/api";
import { EmptyRow, LoadingBlock, Notice } from "../Feedback";

interface SupplierOption {
  id: string;
  name: string;
}

interface ProductOption {
  id: string;
  name: string;
  sku: string | null;
  costPrice: number;
}

interface WarehouseOption {
  id: string;
  name: string;
  code: string;
}

interface OrderLine {
  id: string;
  productId: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  description: string | null;
  product?: { id: string; name: string; sku: string | null };
}

interface PurchaseOrder {
  id: string;
  poNumber: string;
  status: string;
  expectedDate: string | null;
  notes: string | null;
  currency: string | null;
  subtotal: number;
  taxRate: number;
  taxTotal: number;
  totalAmount: number;
  sentAt: string | null;
  createdAt: string;
  supplier: { id: string; name: string };
  warehouse: { id: string; name: string; code: string } | null;
  _count?: { items: number };
  items?: OrderLine[];
  createdBy?: { id: string; name: string } | null;
}

interface DraftLine {
  productId: string;
  quantity: string;
  unitPrice: string;
}

const EMPTY_DRAFT = {
  supplierId: "",
  warehouseId: "",
  expectedDate: "",
  taxRate: "0",
  notes: "",
};

const STATUSES = [
  { value: "ALL", label: "All" },
  { value: "DRAFT", label: "Draft" },
  { value: "SENT", label: "Sent" },
  { value: "RECEIVED", label: "Received" },
  { value: "CANCELLED", label: "Cancelled" },
];

const PAGE_SIZE = 20;

function formatDate(value: string): string {
  return new Date(value).toLocaleDateString(undefined, { dateStyle: "medium" });
}

function badgeClass(status: string): string {
  switch (status) {
    case "DRAFT":
      return "bg-muted/60 text-muted-foreground";
    case "SENT":
      return "bg-info/15 text-info";
    case "PARTIALLY_RECEIVED":
      return "bg-warning/15 text-warning";
    case "RECEIVED":
      return "bg-success/15 text-success";
    default:
      return "bg-danger/15 text-danger";
  }
}

/** Mirrors the server calculation so the form never shows a total the API would reject. */
function money(amount: number, currency: string | null): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: currency || "USD",
    maximumFractionDigits: 2,
  }).format(amount);
}

export function PurchaseOrdersPanel() {
  const [orders, setOrders] = useState<PurchaseOrder[]>([]);
  const [meta, setMeta] = useState<{
    page: number;
    totalPages: number;
    total: number;
    byStatus: Record<string, number>;
  }>({
    page: 1,
    totalPages: 0,
    total: 0,
    byStatus: {},
  });
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [term, setTerm] = useState("");
  const [status, setStatus] = useState("ALL");
  const [page, setPage] = useState(1);

  const [showForm, setShowForm] = useState(false);
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [lines, setLines] = useState<DraftLine[]>([
    { productId: "", quantity: "1", unitPrice: "" },
  ]);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [detail, setDetail] = useState<PurchaseOrder | null>(null);

  const [suppliers, setSuppliers] = useState<SupplierOption[]>([]);
  const [products, setProducts] = useState<ProductOption[]>([]);
  const [warehouses, setWarehouses] = useState<WarehouseOption[]>([]);

  useEffect(() => {
    const timer = setTimeout(() => setTerm(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    setPage(1);
  }, [term, status]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get("/purchase-orders", {
        params: {
          ...(term.trim() ? { search: term.trim() } : {}),
          status,
          page,
          limit: PAGE_SIZE,
        },
      });
      setOrders(res.data.data as PurchaseOrder[]);
      setMeta({
        page: res.data.meta?.page ?? 1,
        totalPages: res.data.meta?.totalPages ?? 0,
        total: res.data.meta?.total ?? 0,
        byStatus: res.data.meta?.byStatus ?? {},
      });
      setLoadError(null);
    } catch (err) {
      setLoadError(getApiError(err));
    } finally {
      setLoading(false);
    }
  }, [term, status, page]);

  useEffect(() => {
    load();
  }, [load]);

  // Option lists are small reference data, so they are fetched once when the form opens.
  useEffect(() => {
    if (!showForm) return;
    (async () => {
      try {
        const [supplierRes, productRes, warehouseRes] = await Promise.all([
          api.get("/suppliers", { params: { limit: 200, page: 1 } }),
          api.get("/products", { params: { limit: 200, page: 1 } }),
          api.get("/org/warehouses"),
        ]);
        setSuppliers((supplierRes.data.data ?? []) as SupplierOption[]);
        setProducts((productRes.data.data ?? []) as ProductOption[]);
        setWarehouses((warehouseRes.data.data ?? []) as WarehouseOption[]);
      } catch (err) {
        setFormError(getApiError(err));
      }
    })();
  }, [showForm]);

  const productById = useMemo(() => new Map(products.map(p => [p.id, p])), [products]);

  const totals = useMemo(() => {
    const subtotal = lines.reduce((sum, line) => {
      const quantity = Number(line.quantity);
      const price = Number(line.unitPrice);
      if (!Number.isFinite(quantity) || !Number.isFinite(price)) return sum;
      return sum + quantity * price;
    }, 0);
    const rate = Number(draft.taxRate) || 0;
    const tax = (subtotal * rate) / 100;
    return { subtotal, tax, total: subtotal + tax };
  }, [lines, draft.taxRate]);

  const setLine = (index: number, patch: Partial<DraftLine>) => {
    setLines(current => current.map((line, i) => (i === index ? { ...line, ...patch } : line)));
  };

  const openCreate = () => {
    setDraft(EMPTY_DRAFT);
    setLines([{ productId: "", quantity: "1", unitPrice: "" }]);
    setFormError(null);
    setNotice(null);
    setShowForm(true);
  };

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!draft.supplierId) {
      setFormError("Choose a supplier for this order.");
      return;
    }
    const items = lines
      .filter(line => line.productId)
      .map(line => ({
        productId: line.productId,
        quantity: Number(line.quantity),
        unitPrice: Number(line.unitPrice) || 0,
      }));
    if (!items.length) {
      setFormError("Add at least one product to the order.");
      return;
    }
    if (items.some(item => !Number.isFinite(item.quantity) || item.quantity <= 0)) {
      setFormError("Every line needs a quantity greater than zero.");
      return;
    }

    setSaving(true);
    setFormError(null);
    try {
      const res = await api.post("/purchase-orders", {
        supplierId: draft.supplierId,
        warehouseId: draft.warehouseId || null,
        expectedDate: draft.expectedDate
          ? new Date(`${draft.expectedDate}T09:00:00`).toISOString()
          : null,
        taxRate: Number(draft.taxRate) || 0,
        notes: draft.notes.trim() || null,
        items,
      });
      setNotice(`Purchase order ${res.data.data.poNumber} created as a draft.`);
      setShowForm(false);
      await load();
    } catch (err) {
      setFormError(getApiError(err));
    } finally {
      setSaving(false);
    }
  };

  const act = async (order: PurchaseOrder, action: "send" | "cancel" | "delete") => {
    const questions = {
      send: `Send ${order.poNumber} to ${order.supplier.name}? It becomes read-only.`,
      cancel: `Cancel ${order.poNumber}?`,
      delete: `Delete ${order.poNumber}? This cannot be undone.`,
    };
    if (!window.confirm(questions[action])) return;
    setBusyId(order.id);
    setNotice(null);
    setLoadError(null);
    try {
      if (action === "delete") {
        await api.delete(`/purchase-orders/${order.id}`);
        setNotice(`Purchase order ${order.poNumber} deleted.`);
        if (detail?.id === order.id) setDetail(null);
      } else {
        const res = await api.post(`/purchase-orders/${order.id}/${action}`, {});
        setNotice(`Purchase order ${order.poNumber} ${action === "send" ? "sent" : "cancelled"}.`);
        if (detail?.id === order.id) setDetail(res.data.data);
      }
      await load();
    } catch (err) {
      setLoadError(getApiError(err));
    } finally {
      setBusyId(null);
    }
  };

  const openDetail = async (order: PurchaseOrder) => {
    if (detail?.id === order.id) {
      setDetail(null);
      return;
    }
    try {
      const res = await api.get(`/purchase-orders/${order.id}`);
      setDetail(res.data.data as PurchaseOrder);
    } catch (err) {
      setLoadError(getApiError(err));
    }
  };

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-4">
        <p className="text-sm text-muted-foreground">
          {meta.total} order{meta.total === 1 ? "" : "s"}
          {meta.byStatus.DRAFT ? `, ${meta.byStatus.DRAFT} awaiting to send` : ""}
          {meta.byStatus.SENT ? `, ${meta.byStatus.SENT} with the supplier` : ""}
        </p>
        <button type="button" onClick={openCreate} className="kazi-button-primary px-4 text-sm">
          <Plus className="h-4 w-4" aria-hidden="true" />
          New purchase order
        </button>
      </div>

      {notice && <Notice tone="success" title="Done" message={notice} />}
      {loadError && (
        <Notice tone="error" title="Could not load purchase orders" message={loadError} />
      )}

      {showForm && (
        <form onSubmit={save} className="kazi-card mb-6 p-6">
          <h2 className="mb-1 text-lg font-semibold text-foreground">New purchase order</h2>
          <p className="mb-4 text-sm text-muted-foreground">
            Saved as a draft with a number like PO-2509-AB12. Totals are calculated on the server,
            so the figure below always matches what the supplier is asked for.
          </p>

          {formError && <Notice tone="error" title="Order not saved" message={formError} />}

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-sm text-muted-foreground" htmlFor="po-supplier">
                Supplier
              </label>
              <select
                id="po-supplier"
                value={draft.supplierId}
                onChange={e => setDraft({ ...draft, supplierId: e.target.value })}
                className="kazi-input"
                required
              >
                <option value="">Select a supplier</option>
                {suppliers.map(supplier => (
                  <option key={supplier.id} value={supplier.id}>
                    {supplier.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-sm text-muted-foreground" htmlFor="po-warehouse">
                Deliver to warehouse
              </label>
              <select
                id="po-warehouse"
                value={draft.warehouseId}
                onChange={e => setDraft({ ...draft, warehouseId: e.target.value })}
                className="kazi-input"
              >
                <option value="">Decide later</option>
                {warehouses.map(warehouse => (
                  <option key={warehouse.id} value={warehouse.id}>
                    {warehouse.name} ({warehouse.code})
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-sm text-muted-foreground" htmlFor="po-expected">
                Expected date
              </label>
              <input
                id="po-expected"
                type="date"
                value={draft.expectedDate}
                onChange={e => setDraft({ ...draft, expectedDate: e.target.value })}
                className="kazi-input"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm text-muted-foreground" htmlFor="po-tax">
                Tax rate (%)
              </label>
              <input
                id="po-tax"
                type="number"
                min="0"
                max="100"
                step="0.01"
                value={draft.taxRate}
                onChange={e => setDraft({ ...draft, taxRate: e.target.value })}
                className="kazi-input"
              />
            </div>
          </div>

          <div className="mt-6">
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-sm font-medium text-foreground">Items</h3>
              <button
                type="button"
                onClick={() =>
                  setLines([...lines, { productId: "", quantity: "1", unitPrice: "" }])
                }
                className="kazi-button-secondary px-3 py-1 text-xs"
              >
                <Plus className="h-3 w-3" aria-hidden="true" />
                Add line
              </button>
            </div>

            {!products.length && (
              <p className="mb-3 text-xs text-muted-foreground">
                No products yet. Create a product first, then come back to this order.
              </p>
            )}

            <div className="space-y-2">
              {lines.map((line, index) => (
                <div key={index} className="grid grid-cols-1 gap-2 sm:grid-cols-12 sm:items-end">
                  <div className="sm:col-span-6">
                    <label
                      className="mb-1 block text-xs text-muted-foreground"
                      htmlFor={`po-line-product-${index}`}
                    >
                      Product
                    </label>
                    <select
                      id={`po-line-product-${index}`}
                      value={line.productId}
                      onChange={e => {
                        const product = productById.get(e.target.value);
                        setLine(index, {
                          productId: e.target.value,
                          unitPrice: product ? String(product.costPrice ?? "") : line.unitPrice,
                        });
                      }}
                      className="kazi-input"
                    >
                      <option value="">Select a product</option>
                      {products.map(product => (
                        <option key={product.id} value={product.id}>
                          {product.name}
                          {product.sku ? ` (${product.sku})` : ""}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="sm:col-span-2">
                    <label
                      className="mb-1 block text-xs text-muted-foreground"
                      htmlFor={`po-line-qty-${index}`}
                    >
                      Quantity
                    </label>
                    <input
                      id={`po-line-qty-${index}`}
                      type="number"
                      min="0"
                      step="0.01"
                      value={line.quantity}
                      onChange={e => setLine(index, { quantity: e.target.value })}
                      className="kazi-input"
                    />
                  </div>
                  <div className="sm:col-span-3">
                    <label
                      className="mb-1 block text-xs text-muted-foreground"
                      htmlFor={`po-line-price-${index}`}
                    >
                      Unit price
                    </label>
                    <input
                      id={`po-line-price-${index}`}
                      type="number"
                      min="0"
                      step="0.01"
                      value={line.unitPrice}
                      onChange={e => setLine(index, { unitPrice: e.target.value })}
                      className="kazi-input"
                    />
                  </div>
                  <div className="sm:col-span-1">
                    <button
                      type="button"
                      onClick={() => setLines(lines.filter((_, i) => i !== index))}
                      disabled={lines.length === 1}
                      className="kazi-button-secondary w-full px-2 py-2 text-xs disabled:opacity-40"
                      aria-label="Remove line"
                    >
                      <X className="mx-auto h-3 w-3" aria-hidden="true" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="mt-4 space-y-1 border-t border-border pt-4 text-sm">
            <div className="flex justify-between text-muted-foreground">
              <span>Subtotal</span>
              <span>{money(totals.subtotal, null)}</span>
            </div>
            <div className="flex justify-between text-muted-foreground">
              <span>Tax ({draft.taxRate || 0}%)</span>
              <span>{money(totals.tax, null)}</span>
            </div>
            <div className="flex justify-between text-base font-semibold text-foreground">
              <span>Total</span>
              <span>{money(totals.total, null)}</span>
            </div>
          </div>

          <div className="mt-4">
            <label className="mb-1 block text-sm text-muted-foreground" htmlFor="po-notes">
              Notes
            </label>
            <textarea
              id="po-notes"
              value={draft.notes}
              onChange={e => setDraft({ ...draft, notes: e.target.value })}
              className="kazi-input"
              rows={2}
              maxLength={500}
            />
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            <button type="submit" className="kazi-button-primary px-4 text-sm" disabled={saving}>
              {saving ? "Saving..." : "Save as draft"}
            </button>
            <button
              type="button"
              className="kazi-button-secondary px-4 text-sm"
              onClick={() => setShowForm(false)}
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div className="w-full sm:w-72">
          <label className="mb-1 block text-sm text-muted-foreground" htmlFor="po-search">
            Search
          </label>
          <input
            id="po-search"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Number, supplier or notes"
            className="kazi-input"
          />
        </div>
        <div>
          <label className="mb-1 block text-sm text-muted-foreground" htmlFor="po-status">
            Status
          </label>
          <select
            id="po-status"
            value={status}
            onChange={e => setStatus(e.target.value)}
            className="kazi-input"
          >
            {STATUSES.map(option => (
              <option key={option.value} value={option.value}>
                {option.label}
                {option.value !== "ALL" && meta.byStatus[option.value]
                  ? ` (${meta.byStatus[option.value]})`
                  : ""}
              </option>
            ))}
          </select>
        </div>
      </div>

      {loading ? (
        <LoadingBlock label="Loading purchase orders..." />
      ) : (
        <div className="kazi-table-wrap">
          <table>
            <thead>
              <tr>
                <th>Number</th>
                <th>Supplier</th>
                <th>Expected</th>
                <th>Status</th>
                <th>Items</th>
                <th className="text-right">Total</th>
                <th className="text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {orders.map(order => (
                <tr key={order.id}>
                  <td className="font-medium text-foreground">{order.poNumber}</td>
                  <td>{order.supplier.name}</td>
                  <td>{order.expectedDate ? formatDate(order.expectedDate) : "-"}</td>
                  <td>
                    <span
                      className={`rounded-full px-2 py-1 text-xs font-medium ${badgeClass(order.status)}`}
                    >
                      {order.status.replace(/_/g, " ")}
                    </span>
                  </td>
                  <td>{order._count?.items ?? 0}</td>
                  <td className="text-right font-medium text-foreground">
                    {money(order.totalAmount, order.currency)}
                  </td>
                  <td>
                    <div className="flex justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => openDetail(order)}
                        className="kazi-button-secondary px-3 py-1 text-xs"
                      >
                        <Eye className="h-3 w-3" aria-hidden="true" />
                        {detail?.id === order.id ? "Hide" : "View"}
                      </button>
                      {order.status === "DRAFT" && (
                        <button
                          type="button"
                          onClick={() => act(order, "send")}
                          disabled={busyId === order.id}
                          className="kazi-button-secondary px-3 py-1 text-xs disabled:opacity-50"
                        >
                          <Send className="h-3 w-3" aria-hidden="true" />
                          Send
                        </button>
                      )}
                      {(order.status === "DRAFT" || order.status === "SENT") && (
                        <button
                          type="button"
                          onClick={() => act(order, "cancel")}
                          disabled={busyId === order.id}
                          className="kazi-button-secondary px-3 py-1 text-xs disabled:opacity-50"
                        >
                          <Ban className="h-3 w-3" aria-hidden="true" />
                          Cancel
                        </button>
                      )}
                      {(order.status === "DRAFT" || order.status === "CANCELLED") && (
                        <button
                          type="button"
                          onClick={() => act(order, "delete")}
                          disabled={busyId === order.id}
                          className="kazi-button-secondary px-3 py-1 text-xs disabled:opacity-50"
                        >
                          <Trash2 className="h-3 w-3" aria-hidden="true" />
                          Delete
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {!orders.length && (
                <EmptyRow
                  colSpan={7}
                  message={
                    term.trim() || status !== "ALL"
                      ? "No purchase orders match those filters."
                      : "No purchase orders yet. Raise one to tell a supplier what to deliver."
                  }
                />
              )}
            </tbody>
          </table>
        </div>
      )}

      {meta.totalPages > 1 && (
        <div className="mt-4 flex items-center justify-between text-sm text-muted-foreground">
          <span>
            Page {meta.page} of {meta.totalPages}
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              className="kazi-button-secondary px-3 py-1 text-xs disabled:opacity-50"
              onClick={() => setPage(current => Math.max(1, current - 1))}
              disabled={meta.page <= 1 || loading}
            >
              Previous
            </button>
            <button
              type="button"
              className="kazi-button-secondary px-3 py-1 text-xs disabled:opacity-50"
              onClick={() => setPage(current => current + 1)}
              disabled={meta.page >= meta.totalPages || loading}
            >
              Next
            </button>
          </div>
        </div>
      )}

      {detail && (
        <div className="kazi-card mt-6 p-6">
          <div className="mb-4 flex items-start justify-between">
            <div>
              <h2 className="flex items-center gap-2 text-lg font-semibold text-foreground">
                <FileText className="h-4 w-4" aria-hidden="true" />
                {detail.poNumber}
              </h2>
              <p className="text-sm text-muted-foreground">
                {detail.supplier.name}
                {detail.warehouse ? `, delivered to ${detail.warehouse.name}` : ""}
                {detail.expectedDate ? `, expected ${formatDate(detail.expectedDate)}` : ""}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setDetail(null)}
              className="kazi-button-secondary px-3 py-1 text-xs"
            >
              <X className="h-3 w-3" aria-hidden="true" />
              Close
            </button>
          </div>

          <div className="kazi-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Product</th>
                  <th className="text-right">Quantity</th>
                  <th className="text-right">Unit price</th>
                  <th className="text-right">Line total</th>
                </tr>
              </thead>
              <tbody>
                {(detail.items ?? []).map(line => (
                  <tr key={line.id}>
                    <td>
                      {line.product?.name ?? "Unknown product"}
                      {line.product?.sku ? (
                        <span className="ml-2 text-xs text-muted-foreground">
                          {line.product.sku}
                        </span>
                      ) : null}
                    </td>
                    <td className="text-right">{line.quantity}</td>
                    <td className="text-right">{money(line.unitPrice, detail.currency)}</td>
                    <td className="text-right font-medium text-foreground">
                      {money(line.lineTotal, detail.currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-4 space-y-1 border-t border-border pt-4 text-sm">
            <div className="flex justify-between text-muted-foreground">
              <span>Subtotal</span>
              <span>{money(detail.subtotal, detail.currency)}</span>
            </div>
            <div className="flex justify-between text-muted-foreground">
              <span>Tax ({detail.taxRate}%)</span>
              <span>{money(detail.taxTotal, detail.currency)}</span>
            </div>
            <div className="flex justify-between text-base font-semibold text-foreground">
              <span>Total</span>
              <span>{money(detail.totalAmount, detail.currency)}</span>
            </div>
          </div>

          {detail.notes && <p className="mt-4 text-sm text-muted-foreground">{detail.notes}</p>}

          <p className="mt-4 text-xs text-muted-foreground">
            Raised {formatDate(detail.createdAt)}
            {detail.createdBy ? ` by ${detail.createdBy.name}` : ""}
            {detail.sentAt ? `, sent ${formatDate(detail.sentAt)}` : ""}.
          </p>
        </div>
      )}

      <p className="mt-6 flex items-center gap-2 text-xs text-muted-foreground">
        <Search className="h-3 w-3" aria-hidden="true" />
        Receiving goods against a sent order is the next milestone.
      </p>
    </div>
  );
}
