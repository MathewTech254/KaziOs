import { useCallback, useEffect, useState } from "react";
import { Building2, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { api, getApiError } from "../lib/api";
import { EmptyRow, LoadingBlock, Notice } from "../components/Feedback";
import { PurchaseOrdersPanel } from "../components/purchasing/PurchaseOrdersPanel";
import { useAuth } from "../contexts/AuthContext";

interface Supplier {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  address: string | null;
  taxNumber: string | null;
  createdAt: string;
  _count?: { purchaseOrders: number };
}

const EMPTY_FORM = { name: "", email: "", phone: "", address: "", taxNumber: "" };
const PAGE_SIZE = 20;

function formatDate(value: string): string {
  return new Date(value).toLocaleDateString(undefined, { dateStyle: "medium" });
}

export function PurchasingPage() {
  const { hasPermission } = useAuth();
  const canView = hasPermission("purchasing.view");
  const canManage = hasPermission("purchasing.manage");

  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [meta, setMeta] = useState({ page: 1, limit: PAGE_SIZE, total: 0, totalPages: 0 });
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [term, setTerm] = useState("");
  const [page, setPage] = useState(1);

  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Supplier | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [tab, setTab] = useState<"suppliers" | "orders">("suppliers");

  useEffect(() => {
    const timer = setTimeout(() => setTerm(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    setPage(1);
  }, [term]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get("/suppliers", {
        params: { ...(term.trim() ? { search: term.trim() } : {}), page, limit: PAGE_SIZE },
      });
      setSuppliers(res.data.data as Supplier[]);
      setMeta({
        page: res.data.meta?.page ?? 1,
        limit: res.data.meta?.limit ?? PAGE_SIZE,
        total: res.data.meta?.total ?? 0,
        totalPages: res.data.meta?.totalPages ?? 0,
      });
      setLoadError(null);
    } catch (err) {
      setLoadError(getApiError(err));
    } finally {
      setLoading(false);
    }
  }, [term, page]);

  useEffect(() => {
    if (canView) load();
  }, [canView, load]);

  const openCreate = () => {
    setEditing(null);
    setForm(EMPTY_FORM);
    setFormError(null);
    setNotice(null);
    setShowForm(true);
  };

  const openEdit = (supplier: Supplier) => {
    setEditing(supplier);
    setForm({
      name: supplier.name ?? "",
      email: supplier.email ?? "",
      phone: supplier.phone ?? "",
      address: supplier.address ?? "",
      taxNumber: supplier.taxNumber ?? "",
    });
    setFormError(null);
    setNotice(null);
    setShowForm(true);
  };

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    const name = form.name.trim();
    if (name.length < 2) {
      setFormError("Supplier name must be at least 2 characters.");
      return;
    }

    const payload = {
      name,
      email: form.email.trim() || null,
      phone: form.phone.trim() || null,
      address: form.address.trim() || null,
      taxNumber: form.taxNumber.trim() || null,
    };

    setSaving(true);
    setFormError(null);
    try {
      if (editing) {
        await api.patch(`/suppliers/${editing.id}`, payload);
        setNotice(`Supplier ${name} updated.`);
      } else {
        await api.post("/suppliers", payload);
        setNotice(`Supplier ${name} created.`);
      }
      setShowForm(false);
      setEditing(null);
      setForm(EMPTY_FORM);
      await load();
    } catch (err) {
      setFormError(getApiError(err));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (supplier: Supplier) => {
    if (!window.confirm(`Delete supplier "${supplier.name}"? This cannot be undone.`)) return;
    setBusyId(supplier.id);
    setNotice(null);
    setLoadError(null);
    try {
      await api.delete(`/suppliers/${supplier.id}`);
      setNotice(`Supplier ${supplier.name} deleted.`);
      await load();
    } catch (err) {
      setLoadError(getApiError(err));
    } finally {
      setBusyId(null);
    }
  };

  if (!canView) {
    return (
      <div>
        <div className="mb-6">
          <h1 className="kazi-page-title">Purchasing</h1>
          <p className="kazi-page-subtitle">Suppliers and purchase orders</p>
        </div>
        <div className="kazi-alert-card p-4 text-sm text-foreground">
          You do not have access to purchasing. Ask an owner to grant the{" "}
          <span className="font-medium">purchasing.view</span> permission to your role.
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-6">
        <h1 className="kazi-page-title">Purchasing</h1>
        <p className="kazi-page-subtitle">Suppliers and purchase orders</p>
      </div>

      <div className="mb-6 flex flex-wrap items-center justify-between gap-4 border-b border-border">
        <div className="flex gap-4" role="tablist" aria-label="Purchasing sections">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "suppliers"}
            onClick={() => setTab("suppliers")}
            className={`-mb-px border-b-2 px-1 pb-3 text-sm font-medium ${
              tab === "suppliers"
                ? "border-accent text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            Suppliers
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "orders"}
            onClick={() => setTab("orders")}
            className={`-mb-px border-b-2 px-1 pb-3 text-sm font-medium ${
              tab === "orders"
                ? "border-accent text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            Purchase orders
          </button>
        </div>
        {tab === "suppliers" && canManage && (
          <button type="button" onClick={openCreate} className="kazi-button-primary px-4 text-sm">
            <Plus className="h-4 w-4" aria-hidden="true" />
            New supplier
          </button>
        )}
      </div>

      {!canManage && (
        <div className="kazi-alert-card mb-4 p-4 text-sm text-foreground">
          You have read-only access. An owner can grant the <span className="font-medium">purchasing.manage</span>{" "}
          permission to let you add suppliers and raise purchase orders.
        </div>
      )}

      {tab === "orders" ? (
        <PurchaseOrdersPanel />
      ) : (
        <>
      {notice && <Notice tone="success" title="Done" message={notice} />}
      {loadError && <Notice tone="error" title="Could not load suppliers" message={loadError} />}

      {showForm && canManage && (
        <form onSubmit={save} className="kazi-card mb-6 p-6">
          <h2 className="mb-1 text-lg font-semibold text-foreground">{editing ? "Edit supplier" : "New supplier"}</h2>
          <p className="mb-4 text-sm text-muted-foreground">
            Only the name is required. Everything else helps your team when they raise a purchase order.
          </p>

          {formError && <Notice tone="error" title="Supplier not saved" message={formError} />}

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <label className="mb-1 block text-sm text-muted-foreground" htmlFor="supplier-name">
                Name
              </label>
              <input
                id="supplier-name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                className="kazi-input"
                maxLength={100}
                required
              />
            </div>
            <div>
              <label className="mb-1 block text-sm text-muted-foreground" htmlFor="supplier-email">
                Email
              </label>
              <input
                id="supplier-email"
                type="email"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                className="kazi-input"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm text-muted-foreground" htmlFor="supplier-phone">
                Phone
              </label>
              <input
                id="supplier-phone"
                value={form.phone}
                onChange={(e) => setForm({ ...form, phone: e.target.value })}
                className="kazi-input"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm text-muted-foreground" htmlFor="supplier-tax">
                Tax number
              </label>
              <input
                id="supplier-tax"
                value={form.taxNumber}
                onChange={(e) => setForm({ ...form, taxNumber: e.target.value })}
                className="kazi-input"
                maxLength={50}
              />
            </div>
            <div>
              <label className="mb-1 block text-sm text-muted-foreground" htmlFor="supplier-address">
                Address
              </label>
              <input
                id="supplier-address"
                value={form.address}
                onChange={(e) => setForm({ ...form, address: e.target.value })}
                className="kazi-input"
                maxLength={200}
              />
            </div>
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            <button type="submit" className="kazi-button-primary px-4 text-sm" disabled={saving}>
              {saving ? "Saving..." : editing ? "Save changes" : "Create supplier"}
            </button>
            <button
              type="button"
              className="kazi-button-secondary px-4 text-sm"
              onClick={() => {
                setShowForm(false);
                setEditing(null);
                setFormError(null);
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div className="w-full sm:w-72">
          <label className="mb-1 block text-sm text-muted-foreground" htmlFor="supplier-search">
            Search
          </label>
          <input
            id="supplier-search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Name, email, phone or tax number"
            className="kazi-input"
          />
        </div>
        <p className="text-xs text-muted-foreground sm:pb-3">
          <Search className="mr-1 inline h-3 w-3" aria-hidden="true" />
          {meta.total === 0 ? "No matches" : `${meta.total} supplier${meta.total === 1 ? "" : "s"}`}
        </p>
      </div>

      {loading ? (
        <div className="kazi-card">
          <LoadingBlock label="Loading suppliers..." />
        </div>
      ) : (
        <div className="kazi-table-wrap kazi-card">
          <table className="min-w-full divide-y divide-border">
            <thead className="bg-surface-muted">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase">Supplier</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase">Contact</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase">Tax number</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase">Orders</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase">Added</th>
                {canManage && (
                  <th className="px-4 py-3 text-right text-xs font-medium text-muted-foreground uppercase">Actions</th>
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {suppliers.map((supplier) => (
                <tr key={supplier.id} className="hover:bg-surface-muted/50">
                  <td className="px-4 py-3 text-sm font-medium text-foreground">
                    {supplier.name}
                    {supplier.address && (
                      <span className="block text-xs font-normal text-muted-foreground">{supplier.address}</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-sm text-muted-foreground">
                    {supplier.email || "-"}
                    {supplier.phone && <span className="block text-xs">{supplier.phone}</span>}
                  </td>
                  <td className="px-4 py-3 text-sm text-muted-foreground">{supplier.taxNumber || "-"}</td>
                  <td className="px-4 py-3 text-sm text-muted-foreground">{supplier._count?.purchaseOrders ?? 0}</td>
                  <td className="px-4 py-3 text-sm text-muted-foreground">{formatDate(supplier.createdAt)}</td>
                  {canManage && (
                    <td className="px-4 py-3 text-right text-sm">
                      <div className="flex justify-end gap-2">
                        <button type="button" onClick={() => openEdit(supplier)} className="kazi-button-secondary px-3 py-1 text-xs">
                          <Pencil className="h-3 w-3" aria-hidden="true" />
                          Edit
                        </button>
                        <button
                          type="button"
                          onClick={() => remove(supplier)}
                          disabled={busyId === supplier.id}
                          className="kazi-button-secondary px-3 py-1 text-xs disabled:opacity-50"
                        >
                          <Trash2 className="h-3 w-3" aria-hidden="true" />
                          {busyId === supplier.id ? "..." : "Delete"}
                        </button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
              {!suppliers.length && (
                <EmptyRow
                  colSpan={canManage ? 6 : 5}
                  message={
                    term.trim()
                      ? "No suppliers match that search."
                      : "No suppliers yet. Add your first supplier to start raising purchase orders."
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
              onClick={() => setPage((current) => Math.max(1, current - 1))}
              disabled={meta.page <= 1 || loading}
            >
              Previous
            </button>
            <button
              type="button"
              className="kazi-button-secondary px-3 py-1 text-xs disabled:opacity-50"
              onClick={() => setPage((current) => current + 1)}
              disabled={meta.page >= meta.totalPages || loading}
            >
              Next
            </button>
          </div>
        </div>
      )}

      <p className="mt-6 flex items-center gap-2 text-xs text-muted-foreground">
        <Building2 className="h-3 w-3" aria-hidden="true" />
        Goods receiving against a sent order is the next milestone.
      </p>
        </>
      )}
    </div>
  );
}
