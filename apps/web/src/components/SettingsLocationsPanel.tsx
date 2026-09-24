import { useEffect, useState } from "react";
import { Pencil, Plus, Star, Trash2 } from "lucide-react";
import { api, getApiError } from "../lib/api";

interface Warehouse {
  id: string;
  name: string;
  code: string;
  address?: string | null;
  branchId?: string | null;
  branch?: { id: string; name: string } | null;
}

interface Branch {
  id: string;
  name: string;
  code: string;
  address?: string | null;
  phone?: string | null;
  isMain: boolean;
  warehouses?: Warehouse[];
}

const emptyBranch = { name: "", code: "", address: "", phone: "" };
const emptyWarehouse = { name: "", code: "", address: "", branchId: "" };

export function SettingsLocationsPanel({ canManage }: { canManage: boolean }) {
  const [branches, setBranches] = useState<Branch[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [branchForm, setBranchForm] = useState(emptyBranch);
  const [branchId, setBranchId] = useState<string | null>(null);
  const [warehouseForm, setWarehouseForm] = useState(emptyWarehouse);
  const [warehouseId, setWarehouseId] = useState<string | null>(null);

  const load = async () => {
    try {
      const [branchRes, warehouseRes] = await Promise.all([
        api.get("/org/branches"),
        api.get("/org/warehouses"),
      ]);
      setBranches(branchRes.data.data);
      setWarehouses(warehouseRes.data.data);
    } catch (err) {
      setError(getApiError(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const report = async (action: () => Promise<unknown>, successMessage: string) => {
    setSaving(true);
    setError("");
    setMessage("");
    try {
      await action();
      await load();
      setMessage(successMessage);
      return true;
    } catch (err) {
      setError(getApiError(err));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const submitBranch = async (e: React.FormEvent) => {
    e.preventDefault();
    const payload = {
      name: branchForm.name,
      code: branchForm.code,
      address: branchForm.address || null,
      phone: branchForm.phone || null,
    };
    const ok = branchId
      ? await report(() => api.patch(`/org/branches/${branchId}`, payload), "Branch updated")
      : await report(() => api.post("/org/branches", payload), "Branch created");
    if (ok) {
      setBranchForm(emptyBranch);
      setBranchId(null);
    }
  };

  const submitWarehouse = async (e: React.FormEvent) => {
    e.preventDefault();
    const payload = {
      name: warehouseForm.name,
      code: warehouseForm.code,
      address: warehouseForm.address || null,
      branchId: warehouseForm.branchId || null,
    };
    const ok = warehouseId
      ? await report(() => api.patch(`/org/warehouses/${warehouseId}`, payload), "Warehouse updated")
      : await report(() => api.post("/org/warehouses", payload), "Warehouse created");
    if (ok) {
      setWarehouseForm(emptyWarehouse);
      setWarehouseId(null);
    }
  };

  const markMainBranch = (branch: Branch) =>
    report(() => api.patch(`/org/branches/${branch.id}`, { isMain: true }), `${branch.name} is now the main branch`);

  if (loading) return <div className="kazi-card p-6 text-sm text-muted-foreground">Loading locations...</div>;

  return (
    <div className="space-y-6">
      {error && <div className="kazi-alert-card p-3 text-sm text-foreground">{error}</div>}
      {message && <div className="rounded-lg border border-border bg-surface-muted p-3 text-sm text-foreground">{message}</div>}

      <form onSubmit={submitBranch} className="kazi-card p-6">
        <h2 className="mb-4 text-lg font-semibold text-foreground">{branchId ? "Edit branch" : "Add branch"}</h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
          <div>
            <label className="mb-1 block text-sm text-muted-foreground">Name</label>
            <input
              value={branchForm.name}
              onChange={(e) => setBranchForm({ ...branchForm, name: e.target.value })}
              className="kazi-input"
              required
            />
          </div>
          <div>
            <label className="mb-1 block text-sm text-muted-foreground">Code</label>
            <input
              value={branchForm.code}
              onChange={(e) => setBranchForm({ ...branchForm, code: e.target.value })}
              className="kazi-input"
              placeholder="MAIN"
              required
            />
          </div>
          <div>
            <label className="mb-1 block text-sm text-muted-foreground">Phone</label>
            <input
              value={branchForm.phone}
              onChange={(e) => setBranchForm({ ...branchForm, phone: e.target.value })}
              className="kazi-input"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm text-muted-foreground">Address</label>
            <input
              value={branchForm.address}
              onChange={(e) => setBranchForm({ ...branchForm, address: e.target.value })}
              className="kazi-input"
            />
          </div>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <button type="submit" disabled={!canManage || saving} className="kazi-button-primary px-4 text-sm disabled:opacity-50">
            <Plus className="h-4 w-4" />
            {branchId ? "Update branch" : "Add branch"}
          </button>
          {branchId && (
            <button
              type="button"
              onClick={() => {
                setBranchId(null);
                setBranchForm(emptyBranch);
              }}
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
              <th className="px-6 py-3 text-left text-xs font-medium uppercase text-muted-foreground">Branch</th>
              <th className="px-6 py-3 text-left text-xs font-medium uppercase text-muted-foreground">Code</th>
              <th className="px-6 py-3 text-left text-xs font-medium uppercase text-muted-foreground">Address</th>
              <th className="px-6 py-3 text-left text-xs font-medium uppercase text-muted-foreground">Warehouses</th>
              <th className="px-6 py-3 text-right text-xs font-medium uppercase text-muted-foreground">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {branches.length === 0 && (
              <tr>
                <td className="px-6 py-4 text-sm text-muted-foreground" colSpan={5}>
                  No branches yet.
                </td>
              </tr>
            )}
            {branches.map((branch) => (
              <tr key={branch.id} className="hover:bg-surface-muted/50">
                <td className="px-6 py-4 text-sm font-medium text-foreground">
                  {branch.name}
                  {branch.isMain && <span className="ml-2 text-xs text-accent">main</span>}
                </td>
                <td className="px-6 py-4 text-sm text-muted-foreground">{branch.code}</td>
                <td className="px-6 py-4 text-sm text-muted-foreground">{branch.address || "-"}</td>
                <td className="px-6 py-4 text-sm text-muted-foreground">{branch.warehouses?.length || 0}</td>
                <td className="px-6 py-4 text-right">
                  <div className="flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setBranchId(branch.id);
                        setBranchForm({
                          name: branch.name,
                          code: branch.code,
                          address: branch.address || "",
                          phone: branch.phone || "",
                        });
                      }}
                      disabled={!canManage}
                      className="kazi-button-secondary px-3 text-xs disabled:opacity-50"
                      aria-label={`Edit ${branch.name}`}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => markMainBranch(branch)}
                      disabled={!canManage || branch.isMain || saving}
                      className="kazi-button-secondary px-3 text-xs disabled:opacity-50"
                      aria-label={`Make ${branch.name} the main branch`}
                    >
                      <Star className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => report(() => api.delete(`/org/branches/${branch.id}`), "Branch deleted")}
                      disabled={!canManage || branch.isMain || saving}
                      className="kazi-button-secondary px-3 text-xs disabled:opacity-50"
                      aria-label={`Delete ${branch.name}`}
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

      <form onSubmit={submitWarehouse} className="kazi-card p-6">
        <h2 className="mb-4 text-lg font-semibold text-foreground">{warehouseId ? "Edit warehouse" : "Add warehouse"}</h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
          <div>
            <label className="mb-1 block text-sm text-muted-foreground">Name</label>
            <input
              value={warehouseForm.name}
              onChange={(e) => setWarehouseForm({ ...warehouseForm, name: e.target.value })}
              className="kazi-input"
              required
            />
          </div>
          <div>
            <label className="mb-1 block text-sm text-muted-foreground">Code</label>
            <input
              value={warehouseForm.code}
              onChange={(e) => setWarehouseForm({ ...warehouseForm, code: e.target.value })}
              className="kazi-input"
              placeholder="WH-01"
              required
            />
          </div>
          <div>
            <label className="mb-1 block text-sm text-muted-foreground">Branch</label>
            <select
              value={warehouseForm.branchId}
              onChange={(e) => setWarehouseForm({ ...warehouseForm, branchId: e.target.value })}
              className="kazi-input"
            >
              <option value="">Unassigned</option>
              {branches.map((branch) => (
                <option key={branch.id} value={branch.id}>
                  {branch.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-sm text-muted-foreground">Address</label>
            <input
              value={warehouseForm.address}
              onChange={(e) => setWarehouseForm({ ...warehouseForm, address: e.target.value })}
              className="kazi-input"
            />
          </div>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <button type="submit" disabled={!canManage || saving} className="kazi-button-primary px-4 text-sm disabled:opacity-50">
            <Plus className="h-4 w-4" />
            {warehouseId ? "Update warehouse" : "Add warehouse"}
          </button>
          {warehouseId && (
            <button
              type="button"
              onClick={() => {
                setWarehouseId(null);
                setWarehouseForm(emptyWarehouse);
              }}
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
              <th className="px-6 py-3 text-left text-xs font-medium uppercase text-muted-foreground">Warehouse</th>
              <th className="px-6 py-3 text-left text-xs font-medium uppercase text-muted-foreground">Code</th>
              <th className="px-6 py-3 text-left text-xs font-medium uppercase text-muted-foreground">Branch</th>
              <th className="px-6 py-3 text-right text-xs font-medium uppercase text-muted-foreground">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {warehouses.length === 0 && (
              <tr>
                <td className="px-6 py-4 text-sm text-muted-foreground" colSpan={4}>
                  No warehouses yet.
                </td>
              </tr>
            )}
            {warehouses.map((warehouse) => (
              <tr key={warehouse.id} className="hover:bg-surface-muted/50">
                <td className="px-6 py-4 text-sm font-medium text-foreground">{warehouse.name}</td>
                <td className="px-6 py-4 text-sm text-muted-foreground">{warehouse.code}</td>
                <td className="px-6 py-4 text-sm text-muted-foreground">{warehouse.branch?.name || "Unassigned"}</td>
                <td className="px-6 py-4 text-right">
                  <div className="flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setWarehouseId(warehouse.id);
                        setWarehouseForm({
                          name: warehouse.name,
                          code: warehouse.code,
                          address: warehouse.address || "",
                          branchId: warehouse.branchId || "",
                        });
                      }}
                      disabled={!canManage}
                      className="kazi-button-secondary px-3 text-xs disabled:opacity-50"
                      aria-label={`Edit ${warehouse.name}`}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => report(() => api.delete(`/org/warehouses/${warehouse.id}`), "Warehouse deleted")}
                      disabled={!canManage || saving}
                      className="kazi-button-secondary px-3 text-xs disabled:opacity-50"
                      aria-label={`Delete ${warehouse.name}`}
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