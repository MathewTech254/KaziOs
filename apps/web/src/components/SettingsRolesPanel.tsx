import { useEffect, useState } from "react";
import { Pencil, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { api, getApiError } from "../lib/api";

interface PermissionGroup {
  label: string;
  permissions: { key: string; label: string }[];
}

interface Role {
  id: string;
  name: string;
  type: string;
  description?: string | null;
  permissions: string[];
  _count?: { users: number };
}

const emptyForm = { name: "", type: "CUSTOM", description: "" };

export function SettingsRolesPanel({ canManage }: { canManage: boolean }) {
  const [roles, setRoles] = useState<Role[]>([]);
  const [groups, setGroups] = useState<PermissionGroup[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [form, setForm] = useState(emptyForm);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const load = async () => {
    try {
      const [roleRes, permissionRes] = await Promise.all([api.get("/roles"), api.get("/roles/permissions")]);
      setRoles(roleRes.data.data);
      setGroups(permissionRes.data.data);
    } catch (err) {
      setError(getApiError(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const togglePermission = (key: string) =>
    setSelected((current) => (current.includes(key) ? current.filter((item) => item !== key) : [...current, key]));

  const resetForm = () => {
    setForm(emptyForm);
    setSelected([]);
    setEditingId(null);
  };

  const startEdit = (role: Role) => {
    setEditingId(role.id);
    setForm({ name: role.name, type: role.type, description: role.description || "" });
    setSelected(role.permissions.filter((permission) => permission !== "*"));
    setMessage("");
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError("");
    setMessage("");
    try {
      const payload = {
        name: form.name,
        type: form.type || "CUSTOM",
        description: form.description || null,
        permissions: selected,
      };
      if (editingId) {
        await api.patch(`/roles/${editingId}`, payload);
      } else {
        await api.post("/roles", payload);
      }
      const wasEditing = Boolean(editingId);
      resetForm();
      await load();
      setMessage(wasEditing ? "Role updated" : "Role created");
    } catch (err) {
      setError(getApiError(err));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (role: Role) => {
    setError("");
    setMessage("");
    try {
      await api.delete(`/roles/${role.id}`);
      await load();
      setMessage(`Deleted ${role.name}`);
    } catch (err) {
      setError(getApiError(err));
    }
  };

  if (loading) return <div className="kazi-card p-6 text-sm text-muted-foreground">Loading roles...</div>;

  const editingRole = roles.find((role) => role.id === editingId) ?? null;
  const lockedForEdit = Boolean(editingRole && editingRole.type === "OWNER");

  return (
    <div className="space-y-6">
      {error && <div className="kazi-alert-card p-3 text-sm text-foreground">{error}</div>}
      {message && <div className="rounded-lg border border-border bg-surface-muted p-3 text-sm text-foreground">{message}</div>}

      <form onSubmit={handleSubmit} className="kazi-card p-6">
        <h2 className="mb-4 flex items-center gap-2 text-lg font-semibold text-foreground">
          <ShieldCheck className="h-5 w-5" />
          {editingId ? "Edit role" : "Create role"}
        </h2>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label className="mb-1 block text-sm text-muted-foreground">Role name</label>
            <input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className="kazi-input"
              placeholder="Cashier"
              required
            />
          </div>
          <div>
            <label className="mb-1 block text-sm text-muted-foreground">Type</label>
            <input
              value={form.type}
              onChange={(e) => setForm({ ...form, type: e.target.value })}
              className="kazi-input"
              placeholder="CUSTOM"
            />
          </div>
          <div className="sm:col-span-2">
            <label className="mb-1 block text-sm text-muted-foreground">Description</label>
            <input
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              className="kazi-input"
              placeholder="What can this role do?"
            />
          </div>
        </div>

        <p className="kazi-section-title mt-6 mb-2">Permissions</p>
        {lockedForEdit && (
          <div className="kazi-alert-card mb-3 p-2 text-xs text-foreground">
            The OWNER role keeps full access and cannot be restricted.
          </div>
        )}
        <div className="space-y-4">
          {groups.map((group) => (
            <div key={group.label}>
              <p className="kazi-section-title mb-2">{group.label}</p>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {group.permissions.map((permission) => (
                  <label key={permission.key} className="flex items-center gap-2 text-sm text-foreground">
                    <input
                      type="checkbox"
                      checked={selected.includes(permission.key)}
                      onChange={() => togglePermission(permission.key)}
                      disabled={!canManage || lockedForEdit}
                    />
                    <span>
                      {permission.label}
                      <span className="ml-1 text-xs text-muted-foreground">{permission.key}</span>
                    </span>
                  </label>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="submit"
            disabled={!canManage || saving || lockedForEdit}
            className="kazi-button-primary px-4 text-sm disabled:opacity-50"
          >
            <Plus className="h-4 w-4" />
            {saving ? "Saving..." : editingId ? "Update role" : "Create role"}
          </button>
          {editingId && (
            <button type="button" onClick={resetForm} className="kazi-button-secondary px-4 text-sm">
              Cancel
            </button>
          )}
        </div>
      </form>

      <div className="kazi-table-wrap kazi-card">
        <table className="min-w-full divide-y divide-border">
          <thead className="bg-surface-muted">
            <tr>
              <th className="px-6 py-3 text-left text-xs font-medium uppercase text-muted-foreground">Role</th>
              <th className="px-6 py-3 text-left text-xs font-medium uppercase text-muted-foreground">Type</th>
              <th className="px-6 py-3 text-left text-xs font-medium uppercase text-muted-foreground">Permissions</th>
              <th className="px-6 py-3 text-left text-xs font-medium uppercase text-muted-foreground">Members</th>
              <th className="px-6 py-3 text-right text-xs font-medium uppercase text-muted-foreground">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {roles.length === 0 && (
              <tr>
                <td className="px-6 py-4 text-sm text-muted-foreground" colSpan={5}>
                  No roles yet.
                </td>
              </tr>
            )}
            {roles.map((role) => {
              const isOwner = role.type === "OWNER";
              return (
                <tr key={role.id} className="hover:bg-surface-muted/50">
                  <td className="px-6 py-4 text-sm font-medium text-foreground">
                    {role.name}
                    {role.description && <p className="text-xs text-muted-foreground">{role.description}</p>}
                  </td>
                  <td className="px-6 py-4 text-sm text-muted-foreground">{role.type}</td>
                  <td className="px-6 py-4 text-sm text-muted-foreground">
                    {role.permissions.includes("*") ? "Full access (*)" : `${role.permissions.length} granted`}
                  </td>
                  <td className="px-6 py-4 text-sm text-muted-foreground">{role._count?.users || 0}</td>
                  <td className="px-6 py-4 text-right">
                    <div className="flex justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => startEdit(role)}
                        disabled={!canManage || isOwner}
                        className="kazi-button-secondary px-3 text-xs disabled:opacity-50"
                        aria-label={`Edit ${role.name}`}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDelete(role)}
                        disabled={!canManage || isOwner}
                        className="kazi-button-secondary px-3 text-xs disabled:opacity-50"
                        aria-label={`Delete ${role.name}`}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}