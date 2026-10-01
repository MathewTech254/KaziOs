import { useEffect, useState } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { api, getApiError } from "../lib/api";

interface TaxCategory {
  id: string;
  name: string;
  rate: number;
  mode: string;
  _count?: { products: number; invoiceItems: number };
}

const emptyForm = { name: "", rate: 16, mode: "EXCLUSIVE" };

export function SettingsTaxPanel({ canManage }: { canManage: boolean }) {
  const [categories, setCategories] = useState<TaxCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [form, setForm] = useState(emptyForm);
  const [editingId, setEditingId] = useState<string | null>(null);

  const load = async () => {
    try {
      const res = await api.get("/tax-categories");
      setCategories(res.data.data);
    } catch (err) {
      setError(getApiError(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const resetForm = () => {
    setForm(emptyForm);
    setEditingId(null);
  };

  const startEdit = (category: TaxCategory) => {
    setEditingId(category.id);
    setForm({ name: category.name, rate: category.rate, mode: category.mode });
    setMessage("");
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError("");
    setMessage("");
    try {
      const payload = { name: form.name, rate: Number(form.rate), mode: form.mode };
      if (editingId) {
        await api.patch(`/tax-categories/${editingId}`, payload);
      } else {
        await api.post("/tax-categories", payload);
      }
      resetForm();
      await load();
      setMessage(editingId ? "Tax category updated" : "Tax category created");
    } catch (err) {
      setError(getApiError(err));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (category: TaxCategory) => {
    setError("");
    setMessage("");
    try {
      await api.delete(`/tax-categories/${category.id}`);
      await load();
      setMessage(`Deleted ${category.name}`);
    } catch (err) {
      setError(getApiError(err));
    }
  };

  const totalProducts = categories.reduce(
    (sum, category) => sum + (category._count?.products || 0),
    0
  );

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="kazi-stat-card">
          <p className="kazi-stat-label">Tax categories</p>
          <p className="kazi-stat-value mt-1">{categories.length}</p>
        </div>
        <div className="kazi-stat-card">
          <p className="kazi-stat-label">Products with tax</p>
          <p className="kazi-stat-value mt-1">{totalProducts}</p>
        </div>
        <div className="kazi-stat-card">
          <p className="kazi-stat-label">Highest rate</p>
          <p className="kazi-stat-value mt-1">
            {categories.length ? `${Math.max(...categories.map(c => c.rate))}%` : "-"}
          </p>
        </div>
      </div>

      {error && <div className="kazi-alert-card p-3 text-sm text-foreground">{error}</div>}
      {message && (
        <div className="rounded-lg border border-border bg-surface-muted p-3 text-sm text-foreground">
          {message}
        </div>
      )}

      <form onSubmit={handleSubmit} className="kazi-card p-6">
        <h2 className="mb-4 text-lg font-semibold text-foreground">
          {editingId ? "Edit tax category" : "Add tax category"}
        </h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div>
            <label className="mb-1 block text-sm text-muted-foreground">Name</label>
            <input
              value={form.name}
              onChange={e => setForm({ ...form, name: e.target.value })}
              className="kazi-input"
              placeholder="VAT Standard"
              required
            />
          </div>
          <div>
            <label className="mb-1 block text-sm text-muted-foreground">Rate (%)</label>
            <input
              type="number"
              step="0.01"
              min="0"
              max="100"
              value={form.rate}
              onChange={e => setForm({ ...form, rate: parseFloat(e.target.value) })}
              className="kazi-input"
              required
            />
          </div>
          <div>
            <label className="mb-1 block text-sm text-muted-foreground">Calculation</label>
            <select
              value={form.mode}
              onChange={e => setForm({ ...form, mode: e.target.value })}
              className="kazi-input"
            >
              <option value="EXCLUSIVE">Exclusive (added to price)</option>
              <option value="INCLUSIVE">Inclusive (included in price)</option>
            </select>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="submit"
            disabled={!canManage || saving}
            className="kazi-button-primary px-4 text-sm disabled:opacity-50"
          >
            <Plus className="h-4 w-4" />
            {saving ? "Saving..." : editingId ? "Update category" : "Add category"}
          </button>
          {editingId && (
            <button
              type="button"
              onClick={resetForm}
              className="kazi-button-secondary px-4 text-sm"
            >
              Cancel
            </button>
          )}
        </div>
      </form>

      <div className="kazi-table-wrap kazi-card">
        <table className="min-w-full divide-y divide-border">
          <thead className="bg-surface-muted">
            <tr>
              <th className="px-6 py-3 text-left text-xs font-medium uppercase text-muted-foreground">
                Name
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium uppercase text-muted-foreground">
                Rate
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium uppercase text-muted-foreground">
                Mode
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium uppercase text-muted-foreground">
                In use
              </th>
              <th className="px-6 py-3 text-right text-xs font-medium uppercase text-muted-foreground">
                Actions
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {loading && (
              <tr>
                <td className="px-6 py-4 text-sm text-muted-foreground" colSpan={5}>
                  Loading tax categories...
                </td>
              </tr>
            )}
            {!loading && categories.length === 0 && (
              <tr>
                <td className="px-6 py-4 text-sm text-muted-foreground" colSpan={5}>
                  No tax categories yet.
                </td>
              </tr>
            )}
            {categories.map(category => (
              <tr key={category.id} className="hover:bg-surface-muted/50">
                <td className="px-6 py-4 text-sm font-medium text-foreground">{category.name}</td>
                <td className="px-6 py-4 text-sm text-muted-foreground">{category.rate}%</td>
                <td className="px-6 py-4 text-sm text-muted-foreground">{category.mode}</td>
                <td className="px-6 py-4 text-sm text-muted-foreground">
                  {category._count?.products || 0} products / {category._count?.invoiceItems || 0}{" "}
                  lines
                </td>
                <td className="px-6 py-4 text-right">
                  <div className="flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => startEdit(category)}
                      disabled={!canManage}
                      className="kazi-button-secondary px-3 text-xs disabled:opacity-50"
                      aria-label={`Edit ${category.name}`}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDelete(category)}
                      disabled={!canManage}
                      className="kazi-button-secondary px-3 text-xs disabled:opacity-50"
                      aria-label={`Delete ${category.name}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
