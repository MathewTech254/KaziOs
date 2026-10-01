import { useState, useEffect } from "react";
import { api } from "../lib/api";
import { Plus } from "lucide-react";

interface Customer {
  id: string;
  name: string;
  email?: string;
  phone?: string;
  customerType: string;
}

export function CustomersPage() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: "", email: "", phone: "", customerType: "INDIVIDUAL" });

  const load = async () => {
    const res = await api.get("/customers");
    setCustomers(res.data.data);
  };

  useEffect(() => {
    load();
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await api.post("/customers", form);
    setShowForm(false);
    setForm({ name: "", email: "", phone: "", customerType: "INDIVIDUAL" });
    load();
  };

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="kazi-page-title">Customers</h1>
          <p className="kazi-page-subtitle">Manage your customer relationships</p>
        </div>
        <button onClick={() => setShowForm(!showForm)} className="kazi-button-primary px-4 text-sm">
          <Plus className="h-4 w-4" />
          {showForm ? "Cancel" : "Add Customer"}
        </button>
      </div>

      {showForm && (
        <form onSubmit={handleSubmit} className="kazi-card mb-6 p-6">
          <h2 className="mb-4 text-lg font-semibold text-foreground">New Customer</h2>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
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
              />
            </div>
            <div>
              <label className="mb-1 block text-sm text-muted-foreground">Phone</label>
              <input
                value={form.phone}
                onChange={e => setForm({ ...form, phone: e.target.value })}
                className="kazi-input"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm text-muted-foreground">Type</label>
              <select
                value={form.customerType}
                onChange={e => setForm({ ...form, customerType: e.target.value })}
                className="kazi-input"
              >
                <option value="INDIVIDUAL">Individual</option>
                <option value="BUSINESS">Business</option>
              </select>
            </div>
          </div>
          <button type="submit" className="kazi-button-primary mt-4 px-4 text-sm">
            Save customer
          </button>
        </form>
      )}

      <div className="kazi-table-wrap kazi-card">
        <table className="min-w-full divide-y divide-border">
          <thead className="bg-surface-muted">
            <tr>
              <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase">
                Name
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase">
                Email
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase">
                Phone
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase">
                Type
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {customers.map(c => (
              <tr key={c.id} className="hover:bg-surface-muted/50">
                <td className="px-6 py-4 text-sm font-medium text-foreground">{c.name}</td>
                <td className="px-6 py-4 text-sm text-muted-foreground">{c.email || "-"}</td>
                <td className="px-6 py-4 text-sm text-muted-foreground">{c.phone || "-"}</td>
                <td className="px-6 py-4 text-sm text-muted-foreground">{c.customerType}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
