import { useEffect, useState } from "react";
import { KeyRound, UserPlus, X } from "lucide-react";
import { api, getApiError } from "../lib/api";

interface RoleRef {
  id: string;
  name: string;
  type: string;
  permissions: string[];
}

interface Assignment {
  id: string;
  role: RoleRef;
}

interface Member {
  id: string;
  email: string;
  name: string;
  status: string;
  roles: Assignment[];
}

interface RoleOption {
  id: string;
  name: string;
  type: string;
}

const emptyForm = { name: "", email: "", password: "", roleId: "" };

export function SettingsUsersPanel({ canManage }: { canManage: boolean }) {
  const [members, setMembers] = useState<Member[]>([]);
  const [roles, setRoles] = useState<RoleOption[]>([]);
  const [form, setForm] = useState(emptyForm);
  const [selection, setSelection] = useState<Record<string, string>>({});
  const [resetFor, setResetFor] = useState<string | null>(null);
  const [resetValue, setResetValue] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const load = async () => {
    try {
      const [memberRes, roleRes] = await Promise.all([api.get("/users"), api.get("/roles")]);
      setMembers(memberRes.data.data);
      setRoles(roleRes.data.data);
    } catch (err) {
      setError(getApiError(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const invite = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError("");
    setMessage("");
    try {
      await api.post("/users", {
        name: form.name,
        email: form.email,
        password: form.password,
        roleId: form.roleId || null,
      });
      setForm(emptyForm);
      await load();
      setMessage("Member added");
    } catch (err) {
      setError(getApiError(err));
    } finally {
      setSaving(false);
    }
  };

  const assignRole = async (member: Member) => {
    const roleId = selection[member.id];
    if (!roleId) return;
    setSaving(true);
    setError("");
    setMessage("");
    try {
      await api.post(`/users/${member.id}/roles`, { roleId });
      setSelection({ ...selection, [member.id]: "" });
      await load();
      setMessage(`Role assigned to ${member.name}`);
    } catch (err) {
      setError(getApiError(err));
    } finally {
      setSaving(false);
    }
  };

  const removeRole = async (member: Member, assignmentId: string) => {
    setSaving(true);
    setError("");
    setMessage("");
    try {
      await api.delete(`/users/${member.id}/roles/${assignmentId}`);
      await load();
      setMessage(`Role removed from ${member.name}`);
    } catch (err) {
      setError(getApiError(err));
    } finally {
      setSaving(false);
    }
  };

  /**
   * Sets a member's password from here.
   *
   * Staff cannot do this for themselves: a reset link depends on an inbox, and a shared
   * till account often has none the owner controls. The owner sets it and tells them, and
   * the API drops every session the member had so the new password is the only way back.
   */
  const resetPassword = async (member: Member, password: string) => {
    setSaving(true);
    setError("");
    setMessage("");
    try {
      await api.post(`/users/${member.id}/reset-password`, { password });
      setResetFor(null);
      setResetValue("");
      setMessage(`Password reset for ${member.name}. They will need to sign in again.`);
    } catch (err) {
      setError(getApiError(err));
    } finally {
      setSaving(false);
    }
  };

  if (loading)
    return <div className="kazi-card p-6 text-sm text-muted-foreground">Loading members...</div>;

  return (
    <div className="space-y-6">
      {error && <div className="kazi-alert-card p-3 text-sm text-foreground">{error}</div>}
      {message && (
        <div className="rounded-lg border border-border bg-surface-muted p-3 text-sm text-foreground">
          {message}
        </div>
      )}

      <form onSubmit={invite} className="kazi-card p-6">
        <h2 className="mb-4 flex items-center gap-2 text-lg font-semibold text-foreground">
          <UserPlus className="h-5 w-5" />
          Add team member
        </h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
          <div>
            <label className="mb-1 block text-sm text-muted-foreground">Name</label>
            <input
              value={form.name}
              onChange={e => setForm({ ...form, name: e.target.value })}
              className="kazi-input"
              required
            />
          </div>
          <div>
            <label className="mb-1 block text-sm text-muted-foreground">Email</label>
            <input
              type="email"
              value={form.email}
              onChange={e => setForm({ ...form, email: e.target.value })}
              className="kazi-input"
              required
            />
          </div>
          <div>
            <label className="mb-1 block text-sm text-muted-foreground">Temporary password</label>
            <input
              type="password"
              minLength={8}
              value={form.password}
              onChange={e => setForm({ ...form, password: e.target.value })}
              className="kazi-input"
              required
            />
          </div>
          <div>
            <label className="mb-1 block text-sm text-muted-foreground">Role</label>
            <select
              value={form.roleId}
              onChange={e => setForm({ ...form, roleId: e.target.value })}
              className="kazi-input"
            >
              <option value="">No role yet</option>
              {roles.map(role => (
                <option key={role.id} value={role.id}>
                  {role.name}
                </option>
              ))}
            </select>
          </div>
        </div>
        <button
          type="submit"
          disabled={!canManage || saving}
          className="kazi-button-primary mt-4 px-4 text-sm disabled:opacity-50"
        >
          {saving ? "Saving..." : "Add member"}
        </button>
      </form>

      <div className="kazi-table-wrap kazi-card">
        <table className="min-w-full divide-y divide-border">
          <thead className="bg-surface-muted">
            <tr>
              <th className="px-6 py-3 text-left text-xs font-medium uppercase text-muted-foreground">
                Member
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium uppercase text-muted-foreground">
                Status
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium uppercase text-muted-foreground">
                Roles
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium uppercase text-muted-foreground">
                Password
              </th>
              <th className="px-6 py-3 text-right text-xs font-medium uppercase text-muted-foreground">
                Assign role
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {members.map(member => (
              <tr key={member.id} className="hover:bg-surface-muted/50">
                <td className="px-6 py-4 text-sm font-medium text-foreground">
                  {member.name}
                  <p className="text-xs text-muted-foreground">{member.email}</p>
                </td>
                <td className="px-6 py-4 text-sm text-muted-foreground">{member.status}</td>
                <td className="px-6 py-4">
                  <div className="flex flex-wrap gap-2">
                    {member.roles.length === 0 && (
                      <span className="text-sm text-muted-foreground">No roles</span>
                    )}
                    {member.roles.map(assignment => (
                      <span
                        key={assignment.id}
                        className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs text-foreground"
                      >
                        {assignment.role.name}
                        <button
                          type="button"
                          onClick={() => removeRole(member, assignment.id)}
                          disabled={!canManage || saving}
                          className="disabled:opacity-50"
                          aria-label={`Remove ${assignment.role.name} from ${member.name}`}
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </span>
                    ))}
                  </div>
                </td>
                <td className="px-6 py-4">
                  {resetFor === member.id ? (
                    <form
                      onSubmit={e => {
                        e.preventDefault();
                        void resetPassword(member, resetValue);
                      }}
                      className="flex items-center gap-2"
                    >
                      <input
                        type="password"
                        minLength={8}
                        required
                        autoFocus
                        value={resetValue}
                        onChange={e => setResetValue(e.target.value)}
                        placeholder="New password"
                        aria-label={`New password for ${member.name}`}
                        className="kazi-input max-w-[11rem]"
                      />
                      <button
                        type="submit"
                        disabled={saving || resetValue.length < 8}
                        className="kazi-button-primary px-3 text-xs disabled:opacity-50"
                      >
                        Save
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setResetFor(null);
                          setResetValue("");
                        }}
                        className="kazi-button-secondary px-3 text-xs"
                      >
                        Cancel
                      </button>
                    </form>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        setResetFor(member.id);
                        setResetValue("");
                      }}
                      disabled={!canManage || saving}
                      className="kazi-button-secondary inline-flex items-center gap-1 px-3 text-xs disabled:opacity-50"
                      aria-label={`Reset password for ${member.name}`}
                    >
                      <KeyRound className="h-3.5 w-3.5" aria-hidden="true" />
                      Reset
                    </button>
                  )}
                </td>
                <td className="px-6 py-4 text-right">
                  <div className="flex justify-end gap-2">
                    <select
                      value={selection[member.id] || ""}
                      onChange={e => setSelection({ ...selection, [member.id]: e.target.value })}
                      className="kazi-input max-w-[10rem]"
                    >
                      <option value="">Select role</option>
                      {roles.map(role => (
                        <option key={role.id} value={role.id}>
                          {role.name}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={() => assignRole(member)}
                      disabled={!canManage || saving || !selection[member.id]}
                      className="kazi-button-secondary px-3 text-xs disabled:opacity-50"
                    >
                      Assign
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
